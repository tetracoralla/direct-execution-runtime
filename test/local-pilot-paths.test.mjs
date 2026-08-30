import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { resolveMathAnchorRoot } from '../scripts/local-pilot-paths.mjs'

test('local pilot uses an explicit absolute Math Anchor checkout or the legacy sibling', () => {
  const workspace = resolve('/tmp', 'openadam-workspace')
  assert.equal(resolveMathAnchorRoot(workspace, {}), resolve(workspace, 'calculator'))
  assert.equal(
    resolveMathAnchorRoot(workspace, { OPENADAM_MATH_ANCHOR_ROOT: '/tmp/moved-math-anchor' }),
    '/tmp/moved-math-anchor',
  )
  assert.throws(
    () => resolveMathAnchorRoot(workspace, { OPENADAM_MATH_ANCHOR_ROOT: 'relative/path' }),
    /must be an absolute path/,
  )
})
