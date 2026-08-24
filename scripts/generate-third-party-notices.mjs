#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStrictJson } from '../src/json.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const lockPath = resolve(root, 'package-lock.json')
const outputPath = resolve(root, 'THIRD_PARTY_NOTICES.md')

function packageName(path) {
  const marker = 'node_modules/'
  const index = path.lastIndexOf(marker)
  return path.slice(index + marker.length)
}

function render(lock) {
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error('package-lock.json must use lockfileVersion 3 with a packages inventory')
  }
  const dependencies = []
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || metadata.dev === true) continue
    const name = packageName(path)
    if (typeof metadata.version !== 'string' || typeof metadata.license !== 'string') {
      throw new Error(`production dependency metadata is incomplete: ${path}`)
    }
    dependencies.push({ name, version: metadata.version, license: metadata.license })
  }
  const unique = new Map()
  for (const dependency of dependencies) {
    unique.set(`${dependency.name}\0${dependency.version}`, dependency)
  }
  const sorted = [...unique.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ))
  const rows = sorted.map(({ name, version, license }) => (
    `| [${name}](https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}) | ${version} | ${license} |`
  ))
  return `# Third-Party Notices

Direct Execution Runtime uses the production dependency packages listed below.
They are resolved by npm and are not copied into this source repository. Each
installed package carries its own license text and remains governed by that
license. This inventory is generated from the committed package lock; run
\`npm run generate:third-party-notices\` after dependency changes.

| Package | Version | Declared license |
| --- | ---: | --- |
${rows.join('\n')}
`
}

const lock = parseStrictJson(await readFile(lockPath, 'utf8'), 'package-lock.json')
const expected = render(lock)
if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (current !== expected) {
    throw new Error('THIRD_PARTY_NOTICES.md is missing or does not match package-lock.json')
  }
  process.stdout.write(`third-party notices match ${expected.split('\n').filter((line) => line.startsWith('| [')).length} locked production packages\n`)
} else {
  await writeFile(outputPath, expected)
  process.stdout.write(`wrote ${outputPath}\n`)
}
