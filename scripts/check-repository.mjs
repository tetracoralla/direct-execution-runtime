#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import { fileURLToPath } from 'node:url'
import { parseStrictJson } from '../src/json.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', '.verify', 'build'])

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...await files(path))
    else found.push(path)
  }
  return found
}

const allFiles = await files(root)
for (const required of [
  'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'README.md', 'docs/INTEGRATIONS.md', 'docs/PUBLIC_DEMO.md',
  'examples/demo-math-anchor.mjs', 'examples/contract-selection.example.json', 'schemas/README.md',
  '.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/dependabot.yml',
]) {
  if (!allFiles.includes(resolve(root, required))) throw new Error(`public repository file is absent: ${required}`)
}
const sourceFiles = allFiles.filter((path) => path.endsWith('.mjs'))
for (const path of sourceFiles) {
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (checked.status !== 0) throw new Error(`syntax check failed for ${path}: ${checked.stderr}`)
}

const packageJson = parseStrictJson(await readFile(resolve(root, 'package.json'), 'utf8'), 'package.json')
if (packageJson.private !== true || packageJson.license !== 'Apache-2.0') {
  throw new Error('GitHub-ready runtime must remain private from npm publication and use Apache-2.0')
}
if (
  packageJson.repository?.url !== 'git+https://github.com/tetracoralla/direct-execution-runtime.git' ||
  packageJson.homepage !== 'https://github.com/tetracoralla/direct-execution-runtime#readme' ||
  packageJson.bugs?.url !== 'https://github.com/tetracoralla/direct-execution-runtime/issues'
) {
  throw new Error('public repository metadata must identify tetracoralla/direct-execution-runtime')
}
if (packageJson.scripts?.['check:providers'] || !packageJson.scripts?.['check:local-pilots']) {
  throw new Error('sibling-provider validation must be exposed only as the maintainer-local pilot check')
}
if (
  packageJson.scripts['check:local-pilots'] !== 'node scripts/check-local-pilots.mjs' ||
  allFiles.includes(resolve(root, 'scripts/check-real-providers.mjs'))
) {
  throw new Error('maintainer pilot entry point must retain its explicit local-only identity')
}
if (packageJson.scripts?.['demo:math-anchor'] !== 'node examples/demo-math-anchor.mjs') {
  throw new Error('public Math Anchor demo entry point is absent or drifted')
}
const packageLock = parseStrictJson(await readFile(resolve(root, 'package-lock.json'), 'utf8'), 'package-lock.json')
const lockedRoot = packageLock.packages?.['']
if (
  lockedRoot?.name !== packageJson.name ||
  lockedRoot?.version !== packageJson.version ||
  lockedRoot?.license !== packageJson.license ||
  !isDeepStrictEqual(lockedRoot?.bin, packageJson.bin)
) {
  throw new Error('package-lock root identity differs from package.json')
}
for (const packagedPublicFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) {
  if (!packageJson.files?.includes(packagedPublicFile)) {
    throw new Error(`public package file is absent from package.json files: ${packagedPublicFile}`)
  }
}

const sourceText = (await Promise.all(
  allFiles.filter((path) => path.includes('/src/')).map((path) => readFile(path, 'utf8')),
)).join('\n')
if (sourceText.includes('@modelcontextprotocol/sdk/server')) {
  throw new Error('the runtime must not expose a generic MCP server')
}
if (allFiles.some((path) => path.endsWith('.mcp.json') || path.includes('/plugins/'))) {
  throw new Error('the v0.1 runtime must not package a model-facing plugin')
}
if (allFiles.some((path) => path.endsWith('.local.json'))) {
  throw new Error('machine-local provider bindings must not be tracked')
}
const productText = (await Promise.all(allFiles.map((path) => readFile(path).catch(() => Buffer.alloc(0))))).join('\n')
const developmentCoordinate = ['/Users', 'openadam', 'Development'].join('/')
if (productText.includes(developmentCoordinate)) {
  throw new Error('tracked product files must not persist development checkout coordinates')
}
const workflowText = (await Promise.all(
  allFiles.filter((path) => path.includes('/.github/workflows/')).map((path) => readFile(path, 'utf8')),
)).join('\n')
for (const unsafe of ['pull_request_target', 'permissions: write-all', 'contents: write']) {
  if (workflowText.includes(unsafe)) throw new Error(`unsafe public workflow authority is present: ${unsafe}`)
}
for (const match of workflowText.matchAll(/\buses:\s+[^\s@]+@([^\s#]+)/gu)) {
  if (!/^[a-f0-9]{40}$/u.test(match[1])) throw new Error(`workflow action is not pinned to a full commit: ${match[0]}`)
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
const providerSchema = parseStrictJson(await readFile(resolve(root, 'schemas/provider-config.schema.json'), 'utf8'))
const workOrderSchema = parseStrictJson(await readFile(resolve(root, 'schemas/work-order.schema.json'), 'utf8'))
const contractSelectionSchema = parseStrictJson(await readFile(resolve(root, 'schemas/contract-selection.schema.json'), 'utf8'))
const exampleConfig = parseStrictJson(await readFile(resolve(root, 'examples/provider-config.example.json'), 'utf8'))
const exampleOrder = parseStrictJson(await readFile(resolve(root, 'examples/work-order.example.json'), 'utf8'))
const exampleSelection = parseStrictJson(await readFile(resolve(root, 'examples/contract-selection.example.json'), 'utf8'))
if (!ajv.compile(providerSchema)(exampleConfig)) throw new Error('provider config example does not satisfy its schema')
if (!ajv.compile(workOrderSchema)(exampleOrder)) throw new Error('work-order example does not satisfy its schema')
if (!ajv.compile(contractSelectionSchema)(exampleSelection)) throw new Error('contract-selection example does not satisfy its schema')

const cli = resolve(root, 'src/cli.mjs')
if (((await stat(cli)).mode & 0o111) === 0) throw new Error('CLI entry point is not executable')
const evalsDriver = resolve(root, 'src/evals-driver.mjs')
if (((await stat(evalsDriver)).mode & 0o111) === 0) throw new Error('evaluator driver entry point is not executable')
process.stdout.write(`repository invariants passed for ${sourceFiles.length} executable modules\n`)
