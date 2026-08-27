import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { HostError } from './errors.mjs'
import { assertHostRequest, assertHostResponse, HOST_REQUEST_VERSION } from './host-protocol.mjs'
import { parseStrictJson } from './json.mjs'

export const MAX_HOST_CLIENT_REQUEST_BYTES = 16 * 1024 * 1024 + 64 * 1024
export const MAX_HOST_CLIENT_RESPONSE_BYTES = 32 * 1024 * 1024 + 64 * 1024

function responseError(payload) {
  return new HostError(payload.code, payload.message, {
    retryable: payload.retryable,
    ...(payload.details === undefined ? {} : { details: payload.details }),
  })
}

export async function requestDirectHost({
  socketPath,
  action,
  workOrder,
  selection,
  signal,
  timeoutMs = 305_000,
  maxResponseBytes = MAX_HOST_CLIENT_RESPONSE_BYTES,
}) {
  if (!isAbsolute(socketPath)) throw new HostError('HOST_CONFIG_INVALID', 'Host socket path must be absolute')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new HostError('HOST_CONFIG_INVALID', 'Host client timeout must be between 1 and 600000 milliseconds')
  }
  const id = `client-${randomUUID()}`
  const request = {
    schemaVersion: HOST_REQUEST_VERSION,
    id,
    action,
    ...(action === 'inspect' ? {} : action === 'project' ? { selection } : { workOrder }),
  }
  assertHostRequest(request, MAX_HOST_CLIENT_REQUEST_BYTES)
  const requestLine = Buffer.from(`${JSON.stringify(request)}\n`)

  return await new Promise((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)
    const socket = createConnection({ path: socketPath })
    const finish = (method, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      method(value)
    }
    const timer = setTimeout(() => {
      finish(reject, new HostError('HOST_TIMEOUT', 'Host service request exceeded the client deadline', { retryable: true }))
    }, timeoutMs)
    const abort = () => finish(reject, new HostError('HOST_CANCELLED', 'Host service request was cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    socket.once('connect', () => socket.write(requestLine))
    socket.on('data', (chunk) => {
      if (settled) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > maxResponseBytes) {
        finish(reject, new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'Host service response exceeds the client byte limit'))
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) return
      const trailing = buffer.subarray(newline + 1).toString('utf8').trim()
      if (trailing.length !== 0) {
        finish(reject, new HostError('HOST_PROTOCOL_ERROR', 'Host service returned more than one response'))
        return
      }
      try {
        const response = parseStrictJson(buffer.subarray(0, newline).toString('utf8'), 'host response')
        assertHostResponse(response, id, maxResponseBytes)
        if (response.status === 'host_error') finish(reject, responseError(response.error))
        else finish(resolve, response.result)
      } catch (error) {
        finish(reject, error)
      }
    })
    socket.once('error', (error) => {
      finish(reject, new HostError('HOST_SERVICE_UNAVAILABLE', `Host service connection failed: ${error.message}`, {
        cause: error,
        retryable: true,
      }))
    })
    socket.once('end', () => {
      if (!settled) finish(reject, new HostError('HOST_TRANSPORT_ERROR', 'Host service closed without a complete response', { retryable: true }))
    })
  })
}
