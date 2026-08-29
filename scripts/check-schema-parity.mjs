#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(root, '..')

export const schemaParityPairs = Object.freeze([
  ['capability-profile.schema.v0.3.json', 'capability-contracts/schemas/capability-profile.schema.v0.3.json'],
  ['capability-jsonl-envelope.schema.v0.1.json', 'capability-contracts/schemas/capability-jsonl-envelope.schema.v0.1.json'],
  ['provider-manifest.schema.v0.3.json', 'capability-contracts/schemas/provider-manifest.schema.v0.3.json'],
  ['procedure-profile.schema.v0.5.json', 'procedure-contracts/schemas/procedure-profile.schema.v0.5.json'],
  ['procedure-implementation-manifest.schema.v0.5.json', 'procedure-contracts/schemas/procedure-implementation-manifest.schema.v0.5.json'],
  ['evals-direct-driver-request.schema.json', 'agent-tool-evals/schemas/direct-driver-request.schema.json'],
  ['evals-direct-driver-result.schema.json', 'agent-tool-evals/schemas/direct-driver-result.schema.json'],
])

export async function checkSchemaParity() {
  for (const [bundledName, canonicalRelativePath] of schemaParityPairs) {
    const [bundled, canonical] = await Promise.all([
      readFile(resolve(root, 'schemas', bundledName)),
      readFile(resolve(workspace, canonicalRelativePath)),
    ])
    if (!bundled.equals(canonical)) throw new Error(`Bundled standard schema drift: ${bundledName}`)
  }
  return { status: 'passed', compared: schemaParityPairs.length }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkSchemaParity()
  process.stdout.write(`${JSON.stringify({ schemaParity: result })}\n`)
}
