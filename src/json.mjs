import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { types as utilTypes } from 'node:util'
import { HostError } from './errors.mjs'

export const STRICT_JSON_MAX_BYTES = 64 * 1024 * 1024
export const STRICT_JSON_MAX_DEPTH = 256
export const STRICT_JSON_MAX_SCALARS = 32 * 1024 * 1024
export const STRICT_JSON_MAX_VALUES = 1_000_000

const literalPattern = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y

function boundedLabel(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256) return 'JSON input'
  try {
    countUnicodeScalars(value, 'JSON input', 'HOST_INVALID_JSON')
    return value
  } catch {
    return 'JSON input'
  }
}

function countUnicodeScalars(value, label, code) {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new HostError(code, `${label}: lone Unicode surrogate is not permitted`)
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new HostError(code, `${label}: lone Unicode surrogate is not permitted`)
    }
    count += 1
  }
  return count
}

export function assertUnicodeScalarString(value, label = 'JSON string', code = 'HOST_INVALID_JSON') {
  if (typeof value !== 'string') throw new HostError(code, `${boundedLabel(label)} must be a string`)
  return countUnicodeScalars(value, boundedLabel(label), code)
}

function unsupported(code, label, message) {
  throw new HostError(code, `${label}: ${message}`)
}

/**
 * Copies a JavaScript value into an isolated JSON-data snapshot without invoking
 * getters, Proxy traps, iterators, or toJSON hooks. Each own data descriptor is
 * obtained once and every later operation uses only the copied value.
 */
export function snapshotJsonValue(value, options = undefined) {
  const code = options?.code ?? 'HOST_INVALID_JSON_VALUE'
  const label = boundedLabel(options?.label ?? 'JSON value')
  const maxBytes = options?.maxBytes ?? STRICT_JSON_MAX_BYTES
  const maxDepth = options?.maxDepth ?? STRICT_JSON_MAX_DEPTH
  const maxScalars = options?.maxScalars ?? STRICT_JSON_MAX_SCALARS
  const maxValues = options?.maxValues ?? STRICT_JSON_MAX_VALUES
  const ancestors = new Set()
  let scalars = 0
  let values = 0

  function copy(current, depth) {
    values += 1
    if (values > maxValues) unsupported(code, label, `contains more than ${maxValues} values`)
    if (depth > maxDepth) unsupported(code, label, `nesting exceeds ${maxDepth} levels`)

    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') {
      scalars += countUnicodeScalars(current, label, code)
      if (scalars > maxScalars) unsupported(code, label, `contains more than ${maxScalars} Unicode scalars`)
      return current
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) unsupported(code, label, 'JSON numbers must be finite')
      if (Number.isInteger(current) && !Number.isSafeInteger(current) && Math.abs(current) < 1e21) {
        unsupported(code, label, 'unsafe JSON integers must be encoded as strings')
      }
      return current
    }

    const currentType = typeof current
    if (currentType === 'object' || currentType === 'function') {
      if (utilTypes.isProxy(current)) unsupported(code, label, 'Proxy values are not supported')
    }
    if (currentType !== 'object') unsupported(code, label, `unsupported JSON value type: ${currentType}`)

    const isArray = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      unsupported(code, label, 'only ordinary objects and arrays are supported')
    }
    if (ancestors.has(current)) unsupported(code, label, 'cyclic values are not supported')
    ancestors.add(current)

    const ownKeys = Reflect.ownKeys(current)
    const descriptors = new Map()
    for (const key of ownKeys) {
      if (typeof key === 'symbol') unsupported(code, label, 'symbol keys are not supported')
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor === undefined) unsupported(code, label, 'an own property changed while it was read')
      descriptors.set(key, descriptor)
    }

    let result
    if (isArray) {
      const lengthDescriptor = descriptors.get('length')
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        unsupported(code, label, 'array length must be an ordinary data property')
      }
      const length = lengthDescriptor.value
      result = new Array(length)
      const indexDescriptors = new Map()
      for (const [key, descriptor] of descriptors) {
        if (key === 'length') continue
        if (!descriptor.enumerable) unsupported(code, label, 'hidden properties are not supported')
        if (!Object.hasOwn(descriptor, 'value')) unsupported(code, label, 'accessor properties are not supported')
        const numeric = Number(key)
        if (!Number.isInteger(numeric) || numeric < 0 || numeric >= length || String(numeric) !== key) {
          unsupported(code, label, 'array properties must be contiguous indexes')
        }
        indexDescriptors.set(numeric, descriptor)
      }
      if (indexDescriptors.size !== length) unsupported(code, label, 'sparse arrays are not supported')
      for (let index = 0; index < length; index += 1) {
        const descriptor = indexDescriptors.get(index)
        if (descriptor === undefined) unsupported(code, label, 'sparse arrays are not supported')
        result[index] = copy(descriptor.value, depth + 1)
      }
    } else {
      result = {}
      for (const [key, descriptor] of descriptors) {
        scalars += countUnicodeScalars(key, label, code)
        if (scalars > maxScalars) unsupported(code, label, `contains more than ${maxScalars} Unicode scalars`)
        if (!descriptor.enumerable) unsupported(code, label, 'hidden properties are not supported')
        if (!Object.hasOwn(descriptor, 'value')) unsupported(code, label, 'accessor properties are not supported')
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
    }
    ancestors.delete(current)
    return result
  }

  const snapshot = copy(value, 0)
  let bytes
  try {
    bytes = Buffer.byteLength(JSON.stringify(snapshot))
  } catch (error) {
    throw new HostError(code, `${label}: value could not be serialized as JSON`, { cause: error })
  }
  if (bytes > maxBytes) unsupported(code, label, `exceeds ${maxBytes} bytes`)
  return snapshot
}

function canonicalJsonFromSnapshot(value) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonFromSnapshot).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonFromSnapshot(value[key])}`)
    .join(',')}}`
}

export function canonicalJson(value) {
  return canonicalJsonFromSnapshot(snapshotJsonValue(value))
}

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(snapshotJsonValue(value)))
}

export function digestJson(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export async function digestFile(path) {
  return digestBytes(await readFile(path))
}

export function decodeUtf8Strict(value, label = 'JSON input', code = 'HOST_INVALID_JSON') {
  const safeLabel = boundedLabel(label)
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new HostError(code, `${safeLabel}: input must be bytes`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch (error) {
    throw new HostError(code, `${safeLabel}: invalid UTF-8`, { cause: error })
  }
}

export async function readStrictJsonFile(path, maxBytes, label = path) {
  const safeLabel = boundedLabel(label)
  const info = await stat(path).catch((error) => {
    throw new HostError('HOST_INPUT_UNAVAILABLE', `${safeLabel} is unavailable`, { cause: error })
  })
  if (!info.isFile()) throw new HostError('HOST_INPUT_UNAVAILABLE', `${safeLabel} is not a regular file`)
  if (info.size > maxBytes) throw new HostError('HOST_INPUT_TOO_LARGE', `${safeLabel} exceeds ${maxBytes} bytes`)
  const body = await readFile(path)
  if (body.length > maxBytes) throw new HostError('HOST_INPUT_TOO_LARGE', `${safeLabel} exceeds ${maxBytes} bytes`)
  return parseStrictJson(decodeUtf8Strict(body, safeLabel), safeLabel)
}

export function parseStrictJson(text, label = 'JSON input') {
  const safeLabel = boundedLabel(label)
  if (typeof text !== 'string') throw new HostError('HOST_INVALID_JSON', `${safeLabel}: input must be text`)
  const inputBytes = Buffer.byteLength(text)
  if (inputBytes > STRICT_JSON_MAX_BYTES) {
    throw new HostError('HOST_INVALID_JSON', `${safeLabel}: input exceeds ${STRICT_JSON_MAX_BYTES} bytes`)
  }

  let index = 0
  let scalarCount = 0
  let valueCount = 0

  function fail(message) {
    throw new HostError('HOST_INVALID_JSON', `${safeLabel}: ${message} at character offset ${index}`)
  }

  function accountString(value) {
    scalarCount += countUnicodeScalars(value, safeLabel, 'HOST_INVALID_JSON')
    if (scalarCount > STRICT_JSON_MAX_SCALARS) fail(`contains more than ${STRICT_JSON_MAX_SCALARS} Unicode scalars`)
  }

  function whitespace() {
    while (index < text.length && /\s/u.test(text[index])) index += 1
  }

  function stringValue() {
    if (text[index] !== '"') fail('expected string')
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const character = text[index]
      if (!escaped && character === '"') {
        index += 1
        try {
          const parsed = JSON.parse(text.slice(start, index))
          accountString(parsed)
          return parsed
        } catch (error) {
          if (error instanceof HostError) throw error
          fail('invalid string escape')
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) fail('unescaped control character')
      if (!escaped && character === '\\') escaped = true
      else escaped = false
      index += 1
    }
    fail('unterminated string')
  }

  function value(depth) {
    valueCount += 1
    if (valueCount > STRICT_JSON_MAX_VALUES) fail(`contains more than ${STRICT_JSON_MAX_VALUES} values`)
    if (depth > STRICT_JSON_MAX_DEPTH) fail(`nesting exceeds ${STRICT_JSON_MAX_DEPTH} levels`)
    whitespace()
    const character = text[index]
    if (character === '{') return objectValue(depth)
    if (character === '[') return arrayValue(depth)
    if (character === '"') return stringValue()
    literalPattern.lastIndex = index
    const literal = literalPattern.exec(text)
    if (literal === null) fail('expected JSON value')
    if (/^-?(?:0|[1-9]\d*)$/u.test(literal[0])) {
      const integer = BigInt(literal[0])
      if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
        fail('integer must be within the IEEE-754 safe range or encoded as a string')
      }
    } else {
      const number = Number(literal[0])
      if (Number.isInteger(number) && !Number.isSafeInteger(number) && Math.abs(number) < 1e21) {
        fail('integer-valued number loses IEEE-754 precision and must be encoded as a string')
      }
    }
    index += literal[0].length
    return undefined
  }

  function objectValue(depth) {
    index += 1
    whitespace()
    const keys = new Set()
    if (text[index] === '}') {
      index += 1
      return undefined
    }
    while (index < text.length) {
      whitespace()
      const key = stringValue()
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`)
      keys.add(key)
      whitespace()
      if (text[index] !== ':') fail('expected colon')
      index += 1
      value(depth + 1)
      whitespace()
      if (text[index] === '}') {
        index += 1
        return undefined
      }
      if (text[index] !== ',') fail('expected comma or closing brace')
      index += 1
    }
    fail('unterminated object')
  }

  function arrayValue(depth) {
    index += 1
    whitespace()
    if (text[index] === ']') {
      index += 1
      return undefined
    }
    while (index < text.length) {
      value(depth + 1)
      whitespace()
      if (text[index] === ']') {
        index += 1
        return undefined
      }
      if (text[index] !== ',') fail('expected comma or closing bracket')
      index += 1
    }
    fail('unterminated array')
  }

  whitespace()
  if (index === text.length) fail('empty input')
  value(0)
  whitespace()
  if (index !== text.length) fail('unexpected trailing content')
  try {
    return snapshotJsonValue(JSON.parse(text), {
      code: 'HOST_INVALID_JSON',
      label: safeLabel,
      maxBytes: STRICT_JSON_MAX_BYTES,
      maxDepth: STRICT_JSON_MAX_DEPTH,
      maxScalars: STRICT_JSON_MAX_SCALARS,
      maxValues: STRICT_JSON_MAX_VALUES,
    })
  } catch (error) {
    if (error instanceof HostError) throw error
    throw new HostError('HOST_INVALID_JSON', `${safeLabel}: ${error.message}`, { cause: error })
  }
}
