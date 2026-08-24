import { chmod, lstat, realpath, stat, unlink } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { HostError } from './errors.mjs'
import { assertHostRequest, hostFailure, hostSuccess, HOST_SERVICE_VERSION } from './host-protocol.mjs'
import { jsonBytes, parseStrictJson } from './json.mjs'

const ENVELOPE_ALLOWANCE_BYTES = 64 * 1024
const DEFAULT_REQUEST_RECEIVE_TIMEOUT_MS = 30_000

async function secureSocketPath(path) {
  if (!isAbsolute(path)) throw new HostError('HOST_CONFIG_INVALID', 'Host socket path must be absolute')
  const name = basename(path)
  if (name.length === 0 || name === '.' || name === '..') {
    throw new HostError('HOST_CONFIG_INVALID', 'Host socket path must name a socket file')
  }
  const parent = await realpath(dirname(path)).catch((error) => {
    throw new HostError('HOST_CONFIG_INVALID', 'Host socket directory does not exist', { cause: error })
  })
  const parentInfo = await stat(parent)
  if (!parentInfo.isDirectory()) throw new HostError('HOST_CONFIG_INVALID', 'Host socket parent is not a directory')
  if (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()) {
    throw new HostError('HOST_CONFIG_INVALID', 'Host socket directory is not owned by the current user')
  }
  if ((parentInfo.mode & 0o077) !== 0) {
    throw new HostError('HOST_CONFIG_INVALID', 'Host socket directory must not be accessible by group or other users')
  }
  return resolve(parent, name)
}

async function liveSocket(path) {
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const socket = connect({ path })
    const finish = (method, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      method(value)
    }
    const timer = setTimeout(() => finish(resolvePromise, false), 250)
    socket.once('connect', () => finish(resolvePromise, true))
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') finish(resolvePromise, false)
      else finish(reject, new HostError('HOST_SERVICE_UNAVAILABLE', 'Existing host socket could not be inspected', { cause: error }))
    })
  })
}

async function prepareSocket(path, replaceStaleSocket) {
  const existing = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (existing === undefined) return
  if (!existing.isSocket()) throw new HostError('HOST_CONFIG_INVALID', 'Host socket path already exists and is not a socket')
  if (await liveSocket(path)) throw new HostError('HOST_SERVICE_IN_USE', 'Another host service is already listening on the socket')
  if (!replaceStaleSocket) {
    throw new HostError('HOST_STALE_SOCKET', 'A stale host socket exists; pass --replace-stale-socket to replace it')
  }
  await unlink(path)
}

function sameFile(left, right) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino
}

export class DirectHostService {
  #server
  #socketIdentity
  #sockets = new Set()
  #controllers = new Set()
  #closing

  constructor(runtime, options) {
    this.runtime = runtime
    this.requestLimit = runtime.config.limits.maxWorkOrderBytes + ENVELOPE_ALLOWANCE_BYTES
    this.responseLimit = runtime.config.limits.maxResultBytes + ENVELOPE_ALLOWANCE_BYTES
    this.requestedSocketPath = options.socketPath
    this.replaceStaleSocket = options.replaceStaleSocket === true
    this.maxConnections = options.maxConnections ?? 64
    this.requestReceiveTimeoutMs = options.requestReceiveTimeoutMs ?? DEFAULT_REQUEST_RECEIVE_TIMEOUT_MS
    if (!Number.isInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 1024) {
      throw new HostError('HOST_CONFIG_INVALID', 'Host maxConnections must be between 1 and 1024')
    }
    if (!Number.isInteger(this.requestReceiveTimeoutMs) || this.requestReceiveTimeoutMs < 10 || this.requestReceiveTimeoutMs > 60_000) {
      throw new HostError('HOST_CONFIG_INVALID', 'Host requestReceiveTimeoutMs must be between 10 and 60000')
    }
  }

  async start() {
    if (this.#server !== undefined) throw new HostError('HOST_SERVICE_IN_USE', 'Host service is already started')
    this.socketPath = await secureSocketPath(this.requestedSocketPath)
    await prepareSocket(this.socketPath, this.replaceStaleSocket)
    const server = createServer((socket) => this.#accept(socket))
    server.maxConnections = this.maxConnections
    this.#server = server
    try {
      await new Promise((resolvePromise, reject) => {
        const onError = (error) => {
          cleanup()
          reject(new HostError('HOST_SERVICE_UNAVAILABLE', `Host service could not listen: ${error.message}`, { cause: error }))
        }
        const onListening = () => {
          cleanup()
          resolvePromise()
        }
        const cleanup = () => {
          server.off('error', onError)
          server.off('listening', onListening)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.socketPath)
      })
      await chmod(this.socketPath, 0o600)
      this.#socketIdentity = await lstat(this.socketPath)
    } catch (error) {
      this.#server = undefined
      await new Promise((resolvePromise) => server.close(() => resolvePromise())).catch(() => {})
      throw error
    }
    return {
      schemaVersion: HOST_SERVICE_VERSION,
      status: 'ready',
      socketPath: this.socketPath,
      pid: process.pid,
      limits: {
        maxConnections: this.maxConnections,
        requestReceiveTimeoutMs: this.requestReceiveTimeoutMs,
        maxWorkOrderBytes: this.runtime.config.limits.maxWorkOrderBytes,
        maxResultBytes: this.runtime.config.limits.maxResultBytes,
      },
    }
  }

  #accept(socket) {
    this.#sockets.add(socket)
    socket.once('close', () => this.#sockets.delete(socket))
    socket.setTimeout(this.requestReceiveTimeoutMs)
    let buffer = Buffer.alloc(0)
    let processing = false
    let responded = false
    let requestId = 'invalid-request'
    let controller

    const respond = (response) => {
      if (responded || socket.destroyed) return
      responded = true
      let output = response
      if (jsonBytes(output) > this.responseLimit) {
        output = hostFailure(requestId, new HostError('HOST_RESULT_TOO_LARGE', 'Host service response exceeds its complete envelope limit'))
      }
      socket.end(`${JSON.stringify(output)}\n`)
    }
    const fail = (error) => respond(hostFailure(requestId, error))

    socket.once('timeout', () => {
      if (!processing && !responded) fail(new HostError('HOST_TIMEOUT', 'Host service did not receive a complete request before its deadline'))
    })

    socket.on('data', (chunk) => {
      if (responded) return
      if (processing) {
        if (chunk.toString('utf8').trim().length !== 0) {
          controller?.abort()
          fail(new HostError('HOST_PROTOCOL_ERROR', 'Host service accepts exactly one request per connection'))
        }
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > this.requestLimit) {
        fail(new HostError('HOST_INPUT_TOO_LARGE', 'Host service request exceeds its complete envelope limit'))
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) return
      processing = true
      socket.setTimeout(0)
      const trailing = buffer.subarray(newline + 1).toString('utf8').trim()
      if (trailing.length !== 0) {
        fail(new HostError('HOST_PROTOCOL_ERROR', 'Host service accepts exactly one request per connection'))
        return
      }
      void (async () => {
        try {
          const request = parseStrictJson(buffer.subarray(0, newline).toString('utf8'), 'host request')
          if (typeof request?.id === 'string') requestId = request.id
          assertHostRequest(request, this.requestLimit)
          controller = new AbortController()
          this.#controllers.add(controller)
          const result = request.action === 'inspect'
            ? await this.runtime.inspectBindings()
            : request.action === 'validate'
              ? await this.runtime.validateWorkOrder(request.workOrder)
              : await this.runtime.runWorkOrder(request.workOrder, { signal: controller.signal })
          respond(hostSuccess(request.id, result))
        } catch (error) {
          fail(error)
        } finally {
          if (controller !== undefined) this.#controllers.delete(controller)
        }
      })()
    })
    socket.once('close', () => {
      if (!responded) controller?.abort()
    })
    socket.once('error', () => {
      if (!responded) controller?.abort()
    })
  }

  async close() {
    if (this.#closing !== undefined) return await this.#closing
    const closing = this.#closeOwned()
    this.#closing = closing
    try {
      await closing
    } finally {
      if (this.#closing === closing) this.#closing = undefined
    }
  }

  async #closeOwned() {
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    const server = this.#server
    this.#server = undefined
    let serverError
    if (server !== undefined) {
      await new Promise((resolvePromise) => {
        server.close((error) => {
          serverError = error
          resolvePromise()
        })
      })
    }
    let runtimeError
    try {
      await this.runtime.close()
    } catch (error) {
      runtimeError = error
    }
    if (this.socketPath !== undefined) {
      const current = await lstat(this.socketPath).catch((error) => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      if (sameFile(current, this.#socketIdentity)) await unlink(this.socketPath)
    }
    if (runtimeError !== undefined) throw runtimeError
    if (serverError !== undefined) throw new HostError('HOST_CLEANUP_FAILED', 'Host service did not close cleanly', { cause: serverError })
  }
}
