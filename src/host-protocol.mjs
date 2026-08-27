import { HostError, hostErrorPayload } from './errors.mjs'
import { jsonBytes } from './json.mjs'

export const HOST_REQUEST_VERSION = 'openadam.direct-host-request.v0.1'
export const HOST_RESPONSE_VERSION = 'openadam.direct-host-response.v0.1'
export const HOST_SERVICE_VERSION = 'openadam.direct-host-service-observation.v0.1'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u
const ACTIONS = new Set(['inspect', 'project', 'validate', 'run'])

function ordinaryObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key))
}

export function assertHostRequest(request, maxBytes) {
  if (!ordinaryObject(request)) throw new HostError('HOST_PROTOCOL_ERROR', 'Host request must be an object')
  if (jsonBytes(request) > maxBytes) throw new HostError('HOST_INPUT_TOO_LARGE', 'Host request exceeds the service byte limit')
  if (request.schemaVersion !== HOST_REQUEST_VERSION) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Unsupported host request schemaVersion')
  }
  if (typeof request.id !== 'string' || request.id.length > 200 || !ID_PATTERN.test(request.id)) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Host request id is invalid')
  }
  if (!ACTIONS.has(request.action)) throw new HostError('HOST_PROTOCOL_ERROR', 'Host request action is invalid')
  const allowed = request.action === 'inspect'
    ? new Set(['schemaVersion', 'id', 'action'])
    : request.action === 'project'
      ? new Set(['schemaVersion', 'id', 'action', 'selection'])
      : new Set(['schemaVersion', 'id', 'action', 'workOrder'])
  if (!exactKeys(request, allowed) || Object.keys(request).length !== allowed.size) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Host request fields do not match its action')
  }
  if (request.action === 'project' && !ordinaryObject(request.selection)) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Host request selection must be an object')
  }
  if (!['inspect', 'project'].includes(request.action) && !ordinaryObject(request.workOrder)) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Host request workOrder must be an object')
  }
  return request
}

export function hostSuccess(id, result) {
  return {
    schemaVersion: HOST_RESPONSE_VERSION,
    id,
    status: 'ok',
    result,
  }
}

export function hostFailure(id, error) {
  return {
    schemaVersion: HOST_RESPONSE_VERSION,
    id,
    status: 'host_error',
    error: hostErrorPayload(error),
  }
}

export function assertHostResponse(response, expectedId, maxBytes) {
  if (!ordinaryObject(response)) throw new HostError('HOST_PROTOCOL_ERROR', 'Host response must be an object')
  if (jsonBytes(response) > maxBytes) throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'Host response exceeds the client byte limit')
  if (response.schemaVersion !== HOST_RESPONSE_VERSION || response.id !== expectedId) {
    throw new HostError('HOST_PROTOCOL_ERROR', 'Host response identity does not match the request')
  }
  if (response.status === 'ok') {
    if (!exactKeys(response, new Set(['schemaVersion', 'id', 'status', 'result'])) || !ordinaryObject(response.result)) {
      throw new HostError('HOST_PROTOCOL_ERROR', 'Host success response is invalid')
    }
    return response
  }
  if (response.status === 'host_error') {
    if (!exactKeys(response, new Set(['schemaVersion', 'id', 'status', 'error'])) || !ordinaryObject(response.error)) {
      throw new HostError('HOST_PROTOCOL_ERROR', 'Host error response is invalid')
    }
    const error = response.error
    if (
      typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code) ||
      typeof error.message !== 'string' || error.message.length === 0 ||
      typeof error.retryable !== 'boolean'
    ) {
      throw new HostError('HOST_PROTOCOL_ERROR', 'Host error payload is invalid')
    }
    return response
  }
  throw new HostError('HOST_PROTOCOL_ERROR', 'Host response status is invalid')
}
