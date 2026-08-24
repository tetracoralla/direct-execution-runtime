export class HostError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HostError'
    this.code = code
    this.retryable = options.retryable === true
    if (options.details !== undefined) this.details = options.details
  }
}

export function asHostError(error, fallbackCode = 'HOST_INTERNAL') {
  if (error instanceof HostError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HostError(fallbackCode, boundedMessage(message), { cause: error })
}

export function boundedMessage(value, maxBytes = 1000) {
  const source = String(value)
  if (Buffer.byteLength(source) <= maxBytes) return source
  let end = Math.min(source.length, maxBytes)
  while (end > 0 && Buffer.byteLength(source.slice(0, end)) > maxBytes - 3) end -= 1
  return `${source.slice(0, end)}...`
}

export function hostErrorPayload(error) {
  const normalized = asHostError(error)
  const payload = {
    code: normalized.code,
    message: boundedMessage(normalized.message),
    retryable: normalized.retryable,
  }
  if (normalized.details !== undefined) payload.details = normalized.details
  return payload
}
