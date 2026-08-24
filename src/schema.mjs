import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { HostError } from './errors.mjs'
import { parseStrictJson } from './json.mjs'

export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
  addFormats(ajv)
  return ajv
}

export async function loadBundledSchema(name) {
  const url = new URL(`../schemas/${name}`, import.meta.url)
  return parseStrictJson(await readFile(url, 'utf8'), name)
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
