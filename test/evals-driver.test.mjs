import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { EVALS_DRIVER_ID, EVALS_DRIVER_VERSION } from '../src/evals-driver-identity.mjs'
import { DirectHostService } from '../src/host-service.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { assertSchema, createValidator, loadBundledSchema } from '../src/schema.mjs'
import { fakeConfig, fakeProjectedMcpConfig, repositoryRoot } from './helpers.mjs'

const driverPath = resolve(repositoryRoot, 'src/evals-driver.mjs')

function runDriver(args, request) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(driverPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

function request(overrides = {}) {
  return {
    schemaVersion: 'openadam.agent-tool-eval.direct-driver-request.v0.1',
    executionMode: 'direct-host',
    runId: 'evals-driver:test:r1',
    task: {
      id: 'echo.structured',
      invocation: { operationId: 'echo', input: { value: '42', delayMs: 0 } },
      tags: ['fixture'],
    },
    purpose: 'development-smoke',
    repeat: 1,
    target: overrides.target,
    targetCapability: { id: 'org.openadam.test.echo', version: '0.1.0' },
    providerRef: overrides.providerRef,
    driverRef: { id: EVALS_DRIVER_ID, version: EVALS_DRIVER_VERSION },
    budget: { timeoutMs: 10000 },
    isolation: { mode: 'deny-read-roots', deniedReadRoots: ['/tmp/evals-oracle'] },
    ...overrides.request,
  }
}

test('evaluator driver pins identity and invokes a persistent host service', async () => {
  await chmod(driverPath, 0o755)
  const directory = await mkdtemp(resolve(tmpdir(), 'de-eval-'))
  const socketPath = resolve(directory, 'runtime.sock')
  const prepared = await prepareRuntimeConfig(fakeConfig())
  const binding = prepared.providers.get('test.fake-capability')
  const runtime = new DirectExecutionRuntime(prepared)
  const service = new DirectHostService(runtime, { socketPath })
  await service.start()
  const target = { id: 'test.fake-capability.echo', version: binding.bindingDigest }
  const providerRef = { id: 'test.fake-capability', version: binding.providerVersion }
  const args = [
    '--socket', socketPath,
    '--provider-id', providerRef.id,
    '--provider-version', providerRef.version,
    '--target-id', target.id,
    '--target-version', target.version,
    '--target-kind', 'capability',
    '--operation-id', 'echo',
    '--capability-id', 'org.openadam.test.echo',
    '--capability-version', '0.1.0',
  ]
  try {
    const first = await runDriver(args, request({ target, providerRef }))
    assert.equal(first.code, 0, first.stderr)
    const result = JSON.parse(first.stdout)
    assert.equal(result.status, 'success')
    assert.deepEqual(result.answer, { value: '42' })
    assert.deepEqual(result.runtime, {
      driver: { id: EVALS_DRIVER_ID, version: EVALS_DRIVER_VERSION },
      provider: providerRef,
      target,
      capability: { id: 'org.openadam.test.echo', version: '0.1.0' },
    })
    const validate = createValidator().compile(await loadBundledSchema('evals-direct-driver-result.schema.json'))
    assertSchema(validate, result, 'TEST_RESULT_INVALID', 'driver result')

    const providerFailureRequest = request({ target, providerRef })
    providerFailureRequest.task.invocation.input.behavior = 'provider-error'
    const providerFailure = await runDriver(args, providerFailureRequest)
    assert.equal(providerFailure.code, 0, providerFailure.stderr)
    assert.equal(JSON.parse(providerFailure.stdout).status, 'error')

    const mismatch = await runDriver(args, request({
      target,
      providerRef: { ...providerRef, version: 'wrong-version' },
    }))
    assert.notEqual(mismatch.code, 0)
    assert.equal(mismatch.stdout, '')
    assert.equal(JSON.parse(mismatch.stderr).code, 'HOST_EVAL_IDENTITY_MISMATCH')
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('evaluator driver preserves an explicit projected MCP operation target', async () => {
  await chmod(driverPath, 0o755)
  const directory = await mkdtemp(resolve(tmpdir(), 'de-proj-'))
  const socketPath = resolve(directory, 'runtime.sock')
  const prepared = await prepareRuntimeConfig(fakeProjectedMcpConfig())
  const binding = prepared.providers.get('test.fake-mcp')
  const runtime = new DirectExecutionRuntime(prepared)
  const service = new DirectHostService(runtime, { socketPath })
  await service.start()
  const target = { id: 'test.fake-mcp.dispatch.text-upper', version: binding.bindingDigest }
  const providerRef = { id: 'test.fake-mcp', version: '0.1.0' }
  const args = [
    '--socket', socketPath,
    '--provider-id', providerRef.id,
    '--provider-version', providerRef.version,
    '--target-id', target.id,
    '--target-version', target.version,
    '--target-kind', 'mcp-operation',
    '--tool-name', 'dispatch',
    '--operation-id', 'text.upper',
  ]
  const projectedRequest = request({
    target,
    providerRef,
    request: {
      targetCapability: undefined,
      task: {
        id: 'text.upper',
        invocation: {
          operationId: 'text.upper',
          input: { operation: 'text.upper', arguments: { value: 'hello' } },
        },
        tags: ['fixture'],
      },
    },
  })
  try {
    const result = await runDriver(args, projectedRequest)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).answer, { value: 'HELLO' })

    const wrongOperation = structuredClone(projectedRequest)
    wrongOperation.task.invocation.operationId = 'number.double'
    const mismatch = await runDriver(args, wrongOperation)
    assert.notEqual(mismatch.code, 0)
    assert.equal(JSON.parse(mismatch.stderr).code, 'HOST_EVAL_IDENTITY_MISMATCH')
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
