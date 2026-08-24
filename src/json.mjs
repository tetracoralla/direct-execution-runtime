import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { HostError } from './errors.mjs'

export function canonicalJson(value) {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HostError('HOST_INVALID_JSON_VALUE', 'JSON numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new HostError('HOST_INVALID_JSON_VALUE', 'Sparse arrays are not valid canonical JSON values')
    }
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  throw new HostError('HOST_INVALID_JSON_VALUE', `Unsupported JSON value type: ${typeof value}`)
}

export function jsonBytes(value) {
  const ancestors = new Set()
  const check = (current, depth) => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new HostError('HOST_INVALID_JSON_VALUE', 'JSON numbers must be finite')
      return
    }
    if (typeof current !== 'object') {
      throw new HostError('HOST_INVALID_JSON_VALUE', `Unsupported JSON value type: ${typeof current}`)
    }
    if (depth > 256) throw new HostError('HOST_INVALID_JSON_VALUE', 'JSON nesting exceeds 256 levels')
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new HostError('HOST_INVALID_JSON_VALUE', 'JSON objects must use an ordinary object or array representation')
    }
    if (ancestors.has(current)) throw new HostError('HOST_INVALID_JSON_VALUE', 'Cyclic values are not valid JSON')
    ancestors.add(current)
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) throw new HostError('HOST_INVALID_JSON_VALUE', 'Sparse arrays are not valid JSON values')
        check(current[index], depth + 1)
      }
    } else {
      for (const item of Object.values(current)) check(item, depth + 1)
    }
    ancestors.delete(current)
  }
  check(value, 0)
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch (error) {
    throw new HostError('HOST_INVALID_JSON_VALUE', 'Value could not be serialized as JSON', { cause: error })
  }
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

export async function readStrictJsonFile(path, maxBytes, label = path) {
  const info = await stat(path).catch((error) => {
    throw new HostError('HOST_INPUT_UNAVAILABLE', `${label} is unavailable`, { cause: error })
  })
  if (!info.isFile()) throw new HostError('HOST_INPUT_UNAVAILABLE', `${label} is not a regular file`)
  if (info.size > maxBytes) {
    throw new HostError('HOST_INPUT_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`)
  }
  const body = await readFile(path)
  if (body.length > maxBytes) {
    throw new HostError('HOST_INPUT_TOO_LARGE', `${label} exceeds ${maxBytes} bytes`)
  }
  return parseStrictJson(body.toString('utf8'), label)
}

export function parseStrictJson(text, label = 'JSON input') {
  let index = 0

  function fail(message) {
    throw new HostError('HOST_INVALID_JSON', `${label}: ${message} at character offset ${index}`)
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
          return JSON.parse(text.slice(start, index))
        } catch {
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

  function value() {
    whitespace()
    const character = text[index]
    if (character === '{') return objectValue()
    if (character === '[') return arrayValue()
    if (character === '"') return stringValue()
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index))
    if (literal === null) fail('expected JSON value')
    index += literal[0].length
    return undefined
  }

  function objectValue() {
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
      value()
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

  function arrayValue() {
    index += 1
    whitespace()
    if (text[index] === ']') {
      index += 1
      return undefined
    }
    while (index < text.length) {
      value()
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
  value()
  whitespace()
  if (index !== text.length) fail('unexpected trailing content')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new HostError('HOST_INVALID_JSON', `${label}: ${error.message}`, { cause: error })
  }
}
