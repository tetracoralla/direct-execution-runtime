import { access, chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { requestDirectHost } from '../src/host-client.mjs'
import { HOST_REQUEST_VERSION } from '../src/host-protocol.mjs'
import { DirectHostService, waitForSocketIdentity } from '../src/host-service.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { assertSchema, createValidator, loadBundledSchema } from '../src/schema.mjs'
import { fakeCall, fakeConfig, workOrder } from './helpers.mjs'

async function withService(task, config = fakeConfig(), serviceOptions = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-service-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const socketPath = resolve(directory, 'runtime.sock')
  const service = new DirectHostService(runtime, { socketPath, ...serviceOptions })
  try {
    const ready = await service.start()
    return await task({ directory, runtime, service, socketPath, ready })
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function rawRequest(socketPath, text) {
  return await new Promise((resolvePromise, reject) => {
    const chunks = []
    const socket = connect({ path: socketPath })
    socket.once('connect', () => socket.write(`${text}\n`))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  })
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true before timeout')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

test('persistent host service reuses one provider session across separate clients', async () => {
  await withService(async ({ runtime, service, socketPath, ready }) => {
    const validateReady = createValidator().compile(await loadBundledSchema('host-service-observation.schema.json'))
    assertSchema(validateReady, ready, 'TEST_READY_INVALID', 'host readiness')
    const mode = (await stat(socketPath)).mode & 0o777
    assert.equal(mode, 0o600)
    const first = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('first-client', [fakeCall('first', { value: 'one' })]),
    })
    const second = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('second-client', [fakeCall('second', { value: 'two' })]),
    })
    assert.equal(first.calls[0].session, 'cold')
    assert.equal(second.calls[0].session, 'warm')
    assert.equal(second.calls[0].result.value, 'two')
    assert.equal(runtime.sessionSnapshot()[0].present, true)

    const projected = await requestDirectHost({
      socketPath,
      action: 'project',
      selection: {
        schemaVersion: 'openadam.direct-contract-selection.v0.1',
        providerId: 'test.fake-capability',
        target: {
          kind: 'capability',
          capabilityId: 'org.openadam.test.echo',
          capabilityVersion: '0.1.0',
          operationId: 'echo',
        },
      },
    })
    assert.equal(projected.contract.contractSource, 'configured-files')
    assert.equal(projected.target.operationId, 'echo')

    const duplicateRuntime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
    const duplicate = new DirectHostService(duplicateRuntime, { socketPath, replaceStaleSocket: true })
    await assert.rejects(() => duplicate.start(), (error) => error.code === 'HOST_SERVICE_IN_USE')
    await duplicate.close()

    await service.close()
    await assert.rejects(() => access(socketPath), (error) => error.code === 'ENOENT')
    assert.equal(runtime.sessionSnapshot()[0].present, false)
  })
})

test('cold host service waits for the listening Socket to become filesystem-visible', async () => {
  let inspections = 0
  let delays = 0
  const identity = await waitForSocketIdentity('/private/runtime.sock', {
    lstat: async () => {
      inspections += 1
      if (inspections < 3) throw Object.assign(new Error('not visible yet'), { code: 'ENOENT' })
      return { isSocket: () => true, dev: 1, ino: 2 }
    },
    delay: async () => { delays += 1 },
  })
  assert.equal(identity.ino, 2)
  assert.equal(inspections, 3)
  assert.equal(delays, 2)
})

test('invalid host protocol input is bounded and does not poison the next request', async () => {
  await withService(async ({ socketPath }) => {
    const invalid = await rawRequest(
      socketPath,
      `{"schemaVersion":"${HOST_REQUEST_VERSION}","id":"a","id":"b","action":"inspect"}`,
    )
    assert.equal(invalid.status, 'host_error')
    assert.equal(invalid.error.code, 'HOST_INVALID_JSON')
    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('after-invalid', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].result.value, 'ready')
  })
})

test('incomplete and pipelined requests cannot retain a connection slot or start hidden work', async () => {
  await withService(async ({ socketPath }) => {
    const incomplete = await new Promise((resolvePromise, reject) => {
      const chunks = []
      const socket = connect({ path: socketPath })
      socket.once('connect', () => socket.write(`{"schemaVersion":"${HOST_REQUEST_VERSION}"`))
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    assert.equal(incomplete.error.code, 'HOST_TIMEOUT')

    const first = {
      schemaVersion: HOST_REQUEST_VERSION,
      id: 'first-pipelined',
      action: 'run',
      workOrder: workOrder('first-pipelined', [fakeCall('slow', { value: 'late', delayMs: 200 })]),
    }
    const second = { schemaVersion: HOST_REQUEST_VERSION, id: 'second-pipelined', action: 'inspect' }
    const pipelined = await new Promise((resolvePromise, reject) => {
      const chunks = []
      const socket = connect({ path: socketPath })
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(first)}\n`)
        setTimeout(() => socket.write(`${JSON.stringify(second)}\n`), 10)
      })
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    assert.equal(pipelined.error.code, 'HOST_PROTOCOL_ERROR')

    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('request-framing-recovery', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].status, 'ok')
  }, fakeConfig(), { requestReceiveTimeoutMs: 25 })
})

test('client disconnect cancels running work and releases admission before recovery', async () => {
  await withService(async ({ runtime, socketPath }) => {
    const request = {
      schemaVersion: HOST_REQUEST_VERSION,
      id: 'disconnect-client',
      action: 'run',
      workOrder: workOrder('disconnect', [fakeCall('slow', { value: 'late', delayMs: 500 })]),
    }
    const socket = connect({ path: socketPath })
    await new Promise((resolvePromise, reject) => {
      socket.once('connect', resolvePromise)
      socket.once('error', reject)
    })
    socket.write(`${JSON.stringify(request)}\n`)
    await waitFor(() => runtime.admissionSnapshot().active === 1)
    socket.destroy()
    await waitFor(() => runtime.admissionSnapshot().active === 0)
    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('disconnect-recovery', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].session, 'cold')
  })
})

test('host service refuses a socket directory accessible by other users', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-insecure-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    await chmod(directory, 0o755)
    const service = new DirectHostService(runtime, { socketPath: resolve(directory, 'runtime.sock') })
    await assert.rejects(() => service.start(), (error) => error.code === 'HOST_CONFIG_INVALID')
    await service.close()
  } finally {
    await chmod(directory, 0o700)
    await rm(directory, { recursive: true, force: true })
  }
})

test('host service rejects an overlong Unix Socket path before listening can truncate it', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-long-socket-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    const service = new DirectHostService(runtime, { socketPath: resolve(directory, 'x'.repeat(180)) })
    await assert.rejects(() => service.start(), (error) => error.code === 'HOST_CONFIG_INVALID' && error.message.includes('platform limit'))
    await service.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
