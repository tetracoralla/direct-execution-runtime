import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'
import { HostError } from './errors.mjs'
import { decodeUtf8Strict, parseStrictJson, snapshotJsonValue } from './json.mjs'

function killProcessGroup(child, signal) {
  if (child?.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process already exited.
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      resolve(exited)
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onClose)
  })
}

/**
 * MCP's stock stdio transport decodes with Buffer.toString(), which replaces
 * malformed UTF-8 before the caller can reject it, and parses JSON before a
 * duplicate-key check is possible. This transport retains the SDK protocol
 * client while making the byte-to-message boundary strict and bounded.
 */
export class StrictMcpStdioTransport {
  #server
  #process
  #stderrStream
  #buffer = Buffer.alloc(0)
  #closing
  #closed = false

  constructor(server) {
    this.#server = snapshotJsonValue({
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd,
      ...(server.env === undefined ? {} : { env: server.env }),
      maxBufferSize: server.maxBufferSize,
    }, {
      code: 'HOST_CONFIG_INVALID',
      label: 'MCP stdio transport configuration',
    })
    if (server.stderr === 'pipe') this.#stderrStream = new PassThrough()
  }

  get stderr() {
    return this.#stderrStream ?? this.#process?.stderr ?? null
  }

  get pid() {
    return this.#process?.pid ?? null
  }

  async start() {
    if (this.#process !== undefined) throw new Error('MCP stdio transport is already started')
    this.#closed = false
    this.#buffer = Buffer.alloc(0)
    const child = spawn(this.#server.command, this.#server.args, {
      cwd: this.#server.cwd,
      env: this.#server.env ?? { ...getDefaultEnvironment(), PWD: this.#server.cwd },
      detached: true,
      stdio: ['pipe', 'pipe', this.#stderrStream === undefined ? 'inherit' : 'pipe'],
      shell: false,
      windowsHide: true,
    })
    this.#process = child
    child.on('error', (error) => {
      this.onerror?.(error)
      if (this.#process === child) void this.close().catch((closeError) => this.onerror?.(closeError))
    })
    child.stdout.on('data', (chunk) => {
      if (this.#process !== child) return
      try {
        this.#consume(chunk)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close().catch((closeError) => this.onerror?.(closeError))
      }
    })
    child.stdout.on('error', (error) => this.onerror?.(error))
    child.stdin.on('error', (error) => this.onerror?.(error))
    if (this.#stderrStream !== undefined) child.stderr.pipe(this.#stderrStream)
    child.once('close', () => {
      if (this.#process === child) this.#process = undefined
      this.#signalClosed()
    })
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup()
        resolve()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    let newline = this.#buffer.indexOf(0x0a)
    while (newline !== -1) {
      let line = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > this.#server.maxBufferSize) {
        this.#buffer = Buffer.alloc(0)
        throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP JSON-RPC frame exceeded its configured limit')
      }
      if (line.length === 0) {
        throw new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'MCP provider emitted an empty JSON-RPC line')
      }
      const value = parseStrictJson(
        decodeUtf8Strict(line, 'MCP JSON-RPC message', 'HOST_PROVIDER_PROTOCOL_ERROR'),
        'MCP JSON-RPC message',
      )
      const message = JSONRPCMessageSchema.parse(value)
      this.onmessage?.(message)
      newline = this.#buffer.indexOf(0x0a)
    }
    if (this.#buffer.length > this.#server.maxBufferSize) {
      this.#buffer = Buffer.alloc(0)
      throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP unterminated JSON-RPC frame exceeded its configured limit')
    }
  }

  async send(message) {
    const child = this.#process
    if (child?.stdin === undefined) throw new Error('MCP stdio transport is not connected')
    // The SDK owns the outer JSON-RPC envelope and intentionally uses omitted
    // `undefined` metadata fields. User-controlled params are already isolated
    // ordinary data before they reach this transport.
    const line = Buffer.from(`${JSON.stringify(message)}\n`)
    if (line.length > this.#server.maxBufferSize) {
      throw new HostError('HOST_INPUT_TOO_LARGE', 'Outbound MCP JSON-RPC message exceeded its configured limit')
    }
    await new Promise((resolve, reject) => {
      child.stdin.write(line, (error) => error === null || error === undefined ? resolve() : reject(error))
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
    const child = this.#process
    this.#process = undefined
    this.#buffer = Buffer.alloc(0)
    if (child !== undefined) {
      child.stdin.end()
      if (!(await waitForExit(child, 250))) {
        killProcessGroup(child, 'SIGTERM')
        if (!(await waitForExit(child, 750))) {
          killProcessGroup(child, 'SIGKILL')
          if (!(await waitForExit(child, 750))) {
            throw new HostError('HOST_CLEANUP_FAILED', 'MCP provider process remained after forced termination')
          }
        }
      }
    }
    this.#signalClosed()
  }

  #signalClosed() {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.()
  }
}
