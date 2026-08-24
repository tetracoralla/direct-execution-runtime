#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', '.verify', 'build'])

async function modules(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...await modules(path))
    else if (path.endsWith('.mjs')) found.push(path)
  }
  return found
}

const paths = await modules(root)
for (const path of paths) {
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (checked.status !== 0) throw new Error(`syntax check failed for ${path}: ${checked.stderr}`)
}
process.stdout.write(`syntax passed for ${paths.length} modules\n`)
