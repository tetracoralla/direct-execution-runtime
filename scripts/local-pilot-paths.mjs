import { isAbsolute, resolve } from 'node:path'

export function resolveMathAnchorRoot(workspace, environment = process.env) {
  const configured = environment.OPENADAM_MATH_ANCHOR_ROOT
  if (configured === undefined) return resolve(workspace, 'calculator')
  if (!isAbsolute(configured)) {
    throw new Error('OPENADAM_MATH_ANCHOR_ROOT must be an absolute path')
  }
  return resolve(configured)
}
