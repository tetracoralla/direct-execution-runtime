import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { repositoryRoot } from './helpers.mjs'

const execFileAsync = promisify(execFile)

test('public Math Anchor demo exposes a prerequisite-focused help route', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    resolve(repositoryRoot, 'examples/demo-math-anchor.mjs'),
    '--help',
  ], { encoding: 'utf8' })
  assert.equal(stderr, '')
  assert.match(stdout, /--provider-root/)
  assert.match(stdout, /invokes no model/)
  assert.match(stdout, /writes no report or provider config/)
})
