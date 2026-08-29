import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { HostError } from './errors.mjs'
import { decodeUtf8Strict, parseStrictJson } from './json.mjs'

// Published provider schemas still carry `format: "uint32"/"uint64"` claims
// (installed Projective releases do). Without these registrations Ajv only
// logs an unknown-format warning and validates no range at all.
function unsignedIntegerFormat(bits) {
  const limit = 2 ** bits
  return {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= 0 && value < limit,
  }
}

export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
  ajv.addFormat('uint32', unsignedIntegerFormat(32))
  ajv.addFormat('uint64', unsignedIntegerFormat(64))
  addFormats(ajv)
  return ajv
}

export async function loadBundledSchema(name) {
  const url = new URL(`../schemas/${name}`, import.meta.url)
  return parseStrictJson(decodeUtf8Strict(await readFile(url), name), name)
}

export function assertSchema(validate, value, code, label) {
  if (validate(value)) return
  const details = (validate.errors ?? []).slice(0, 12).map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message,
  }))
  throw new HostError(code, `${label} does not satisfy its closed schema`, { details })
}
