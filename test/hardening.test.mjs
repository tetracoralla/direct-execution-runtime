import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { canonicalJson, digestFile, digestJson, jsonBytes, parseStrictJson, readStrictJsonFile } from '../src/json.mjs'
import { createLaunchSnapshot } from '../src/launch-snapshot.mjs'
import { validateResolutionResult } from '../src/resolution-result.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { StrictMcpStdioTransport } from '../src/strict-mcp-stdio-transport.mjs'
import {
  fakeCall,
  fakeConfig,
  fakeMcpCall,
  fakeMcpConfig,
  fakeMcpRoot,
  fakeProjectedMcpConfig,
  fakeRoot,
  workOrder,
} from './helpers.mjs'

function zeroTrapProxy(value) {
  let traps = 0
  const trap = () => {
    traps += 1
    throw new Error('Proxy trap must not run')
  }
  return {
    value: new Proxy(value, {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      has: trap,
    }),
    traps: () => traps,
  }
}

async function waitForLaunchSnapshot(directory, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await readdir(directory)
    if (entries.some((entry) => entry.startsWith('openadam-direct-launch-'))) return
    await delay(1)
  }
  throw new Error('launch snapshot did not begin before timeout')
}

async function assertNoLaunchSnapshot(directory) {
  assert.deepEqual(
    (await readdir(directory)).filter((entry) => entry.startsWith('openadam-direct-launch-')),
    [],
  )
}

test('strict JSON rejects excessive depth and invalid UTF-8 with stable HostError codes', async () => {
  assert.throws(
    () => parseStrictJson(`${'['.repeat(5000)}0${']'.repeat(5000)}`, 'deep input'),
    (error) => error.code === 'HOST_INVALID_JSON' && !(error instanceof RangeError),
  )
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-runtime-json-'))
  try {
    const path = resolve(directory, 'invalid.json')
    await writeFile(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
    await assert.rejects(
      () => readStrictJsonFile(path, 1024, 'invalid UTF-8 fixture'),
      (error) => error.code === 'HOST_INVALID_JSON' && /invalid UTF-8/.test(error.message),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP stdio rejects invalid UTF-8 and duplicate JSON keys before SDK message handling', async () => {
  const command = resolve(fakeMcpRoot, 'malformed-server.mjs')
  for (const mode of ['invalid-utf8', 'duplicate-key']) {
    const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeMcpConfig({
      command,
      args: [`--mode=${mode}`],
    })))
    try {
      const result = await runtime.runWorkOrder(workOrder(`strict-mcp-${mode}`, [
        fakeMcpCall('call', { value: 'must-not-pass' }),
      ]))
      assert.equal(result.calls[0].status, 'host_error')
      assert.equal(result.calls[0].error.code, 'HOST_TRANSPORT_ERROR')
      assert.equal(runtime.sessionSnapshot()[0].pid, null)
    } finally {
      await runtime.close()
    }
  }
})

test('MCP stdio applies the byte limit to each complete frame and the unterminated remainder', async () => {
  const transport = new StrictMcpStdioTransport({
    command: process.execPath,
    args: [resolve(fakeMcpRoot, 'framing-server.mjs')],
    cwd: fakeMcpRoot,
    stderr: 'pipe',
    maxBufferSize: 2048,
  })
  const messages = []
  try {
    const received = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('framing fixture did not return two messages')), 3000)
      transport.onerror = reject
      transport.onmessage = (message) => {
        messages.push(message)
        if (messages.length === 2) {
          clearTimeout(timer)
          resolvePromise()
        }
      }
    })
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'fixture/pair', params: {} })
    await received
    assert.equal(messages.length, 2)
    assert.equal(messages[0].id, 1)
    assert.equal(messages[1].method, 'notifications/message')
  } finally {
    await transport.close()
  }
})

test('JSONL empty stdout lines terminate the generation and the next call recovers cold', async () => {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    const failed = await runtime.runWorkOrder(workOrder('jsonl-empty-line', [
      fakeCall('empty', { value: '__empty_line__' }),
    ]))
    assert.equal(failed.calls[0].error.code, 'HOST_PROVIDER_PROTOCOL_ERROR')
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
    const recovered = await runtime.runWorkOrder(workOrder('jsonl-empty-line-recovery', [
      fakeCall('ready', { value: 'ready' }),
    ]))
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].session, 'cold')
  } finally {
    await runtime.close()
  }
})

test('runtime close waits for in-flight JSONL and MCP launch snapshots without staging or child residue', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-close-snapshot-'))
  const snapshotDirectory = resolve(parent, 'snapshots')
  const jsonlRoot = resolve(parent, 'jsonl-provider')
  const mcpRoot = resolve(parent, 'mcp-provider')
  const previousTmpdir = process.env.TMPDIR
  let runtime
  try {
    await mkdir(snapshotDirectory, { mode: 0o700 })
    await cp(fakeRoot, jsonlRoot, { recursive: true })
    await cp(fakeMcpRoot, mcpRoot, { recursive: true })
    const jsonlSlowIdentity = resolve(jsonlRoot, 'slow-identity.bin')
    const mcpSlowIdentity = resolve(mcpRoot, 'slow-identity.bin')
    for (const path of [jsonlSlowIdentity, mcpSlowIdentity]) {
      const file = await open(path, 'w', 0o600)
      try {
        await file.truncate(64 * 1024 * 1024)
      } finally {
        await file.close()
      }
    }
    const jsonlConfig = await prepareRuntimeConfig(fakeConfig({
      rootPath: jsonlRoot,
      identityFiles: [resolve(jsonlRoot, 'adapter.mjs'), jsonlSlowIdentity],
    }))
    const mcpServer = resolve(mcpRoot, 'server.mjs')
    const mcpConfig = await prepareRuntimeConfig(fakeMcpConfig({
      rootPath: mcpRoot,
      identityFiles: [mcpServer, mcpSlowIdentity],
    }))
    process.env.TMPDIR = snapshotDirectory
    assert.equal(tmpdir(), snapshotDirectory)

    for (const scenario of [
      {
        id: 'jsonl-close-during-snapshot',
        config: jsonlConfig,
        call: fakeCall('jsonl', { value: 'must-not-run' }),
      },
      {
        id: 'mcp-close-during-snapshot',
        config: mcpConfig,
        call: fakeMcpCall('mcp', { value: 'must-not-run' }),
      },
    ]) {
      runtime = new DirectExecutionRuntime(scenario.config)
      const running = runtime.runWorkOrder(workOrder(scenario.id, [scenario.call]))
      await waitForLaunchSnapshot(snapshotDirectory)
      assert.equal(runtime.sessionSnapshot()[0].pid, null)
      await runtime.close()
      const result = await running
      assert.equal(result.calls[0].status, 'host_error')
      assert.equal(result.calls[0].error.code, 'HOST_CANCELLED')
      assert.equal(runtime.sessionSnapshot()[0].pid, null)
      await assertNoLaunchSnapshot(snapshotDirectory)
      runtime = undefined
    }
  } finally {
    await runtime?.close()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    await rm(parent, { recursive: true, force: true })
  }
})

test('provider sessions execute private frozen command and identity bytes, then remove the snapshot', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-frozen-launch-'))
  const providerRoot = resolve(parent, 'provider')
  let snapshot
  try {
    await cp(fakeRoot, providerRoot, { recursive: true })
    const prepared = await prepareRuntimeConfig(fakeConfig({ rootPath: providerRoot }))
    const binding = prepared.providers.get('test.fake-capability')
    snapshot = await createLaunchSnapshot(binding)
    const stagedAdapter = snapshot.args[0]
    assert.equal(await digestFile(snapshot.command), binding.commandDigest)
    assert.equal(await digestFile(stagedAdapter), binding.launchIdentityFiles[0].digest)
    const commandInfo = await stat(snapshot.command)
    const adapterInfo = await stat(stagedAdapter)
    assert.equal(commandInfo.nlink, 1)
    assert.equal(adapterInfo.nlink, 1)
    assert.notEqual(snapshot.command, binding.adapterCommand)
    assert.notEqual(stagedAdapter, resolve(providerRoot, 'adapter.mjs'))
    assert.equal(snapshot.cwd, await realpath(providerRoot))

    await writeFile(resolve(providerRoot, 'adapter.mjs'), [
      "import { createInterface } from 'node:readline'",
      'for await (const line of createInterface({ input: process.stdin })) {',
      '  const request = JSON.parse(line)',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { value: "mutated" } })}\\n`)',
      '}',
      '',
    ].join('\n'))

    const frozenEnvironment = await snapshot.prepareEnvironment(process.env)
    const response = await new Promise((resolvePromise, reject) => {
      const child = spawn(snapshot.command, snapshot.args, {
        cwd: snapshot.cwd,
        env: frozenEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      child.once('error', reject)
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`frozen adapter exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
          return
        }
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString('utf8').trim()))
      })
      child.stdin.end(`${JSON.stringify({ id: 'frozen', operationId: 'echo', input: { value: 'frozen' } })}\n`)
    })
    assert.equal(response.result.value, 'frozen')
    const snapshotRoot = snapshot.rootPath
    await snapshot.dispose()
    snapshot = undefined
    await assert.rejects(() => access(snapshotRoot), (error) => error.code === 'ENOENT')

    const jsonlRuntime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
    try {
      const jsonl = await jsonlRuntime.runWorkOrder(workOrder('jsonl-staged-path', [
        fakeCall('path', { value: '__execution_path__' }),
        fakeCall('cwd', { value: '__execution_cwd__' }),
      ]))
      assert.match(jsonl.calls[0].result.value, /openadam-direct-launch-.+\/filesystem\//u)
      assert.notEqual(jsonl.calls[0].result.value, resolve(fakeRoot, 'adapter.mjs'))
      assert.equal(jsonl.calls[1].result.value, fakeRoot)
    } finally {
      await jsonlRuntime.close()
    }

    const mcpRuntime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeMcpConfig()))
    try {
      const mcp = await mcpRuntime.runWorkOrder(workOrder('mcp-staged-path', [
        fakeMcpCall('path', { value: '__execution_path__' }),
        fakeMcpCall('cwd', { value: '__execution_cwd__' }),
      ]))
      assert.match(mcp.calls[0].result.value, /openadam-direct-launch-.+\/filesystem\//u)
      assert.notEqual(mcp.calls[0].result.value, resolve(fakeMcpRoot, 'server.mjs'))
      assert.equal(mcp.calls[1].result.value, fakeMcpRoot)
    } finally {
      await mcpRuntime.close()
    }
  } finally {
    await snapshot?.dispose()
    await rm(parent, { recursive: true, force: true })
  }
})

test('identity arguments referenced through a symlink stay frozen and drifted references fail closed', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-symlink-identity-'))
  const providerRoot = resolve(parent, 'provider')
  const identityFiles = () => [
    resolve(providerRoot, 'identity-arg-adapter.mjs'),
    resolve(providerRoot, 'identity-real.txt'),
  ]
  let runtime
  try {
    await cp(fakeRoot, providerRoot, { recursive: true })
    await writeFile(resolve(providerRoot, 'identity-real.txt'), 'ORIGINAL-BYTES\n')
    await writeFile(resolve(providerRoot, 'identity-other.txt'), 'PWNED-BYTES\n')
    await symlink('identity-real.txt', resolve(providerRoot, 'identity-link.json'))
    await writeFile(resolve(providerRoot, 'identity-arg-adapter.mjs'), [
      "import { readFileSync } from 'node:fs'",
      "import { createInterface } from 'node:readline'",
      'const identityPath = process.argv.find((value) => value.startsWith("--identity-file=")).split("=")[1]',
      'const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })',
      'for await (const line of lines) {',
      '  const request = JSON.parse(line)',
      '  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { value: readFileSync(identityPath, "utf8").trim() } })}\\n`)',
      '}',
      '',
    ].join('\n'))
    const manifest = parseStrictJson(
      await readFile(resolve(providerRoot, 'provider.json'), 'utf8'),
      'provider manifest',
    )
    manifest.implementations[0].adapter.args = ['identity-arg-adapter.mjs', '--identity-file=identity-link.json']
    await writeFile(resolve(providerRoot, 'provider.json'), JSON.stringify(manifest))

    runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig({
      rootPath: providerRoot,
      identityFiles: identityFiles(),
    })))
    const read = () => fakeCall('read', { value: 'read' })
    const first = await runtime.runWorkOrder(workOrder('symlink-identity', [read()]))
    assert.equal(first.calls[0].status, 'ok')
    assert.equal(first.calls[0].result.value, 'ORIGINAL-BYTES')

    await rm(resolve(providerRoot, 'identity-link.json'))
    await symlink('identity-other.txt', resolve(providerRoot, 'identity-link.json'))

    const warm = await runtime.runWorkOrder(workOrder('symlink-warm', [read()]))
    assert.equal(warm.calls[0].status, 'ok')
    assert.equal(warm.calls[0].result.value, 'ORIGINAL-BYTES')
    assert.equal(warm.calls[0].session, 'warm')

    await runtime.replaceProvider('test.fake-capability')
    const drifted = await runtime.runWorkOrder(workOrder('symlink-cold', [read()]))
    assert.equal(drifted.calls[0].status, 'host_error')
    assert.equal(drifted.calls[0].error.code, 'HOST_PROVIDER_REPLACED')

    await rm(resolve(providerRoot, 'identity-link.json'))
    await symlink('identity-real.txt', resolve(providerRoot, 'identity-link.json'))
    const recovered = await runtime.runWorkOrder(workOrder('symlink-recovered', [read()]))
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].result.value, 'ORIGINAL-BYTES')
    assert.equal(recovered.calls[0].session, 'cold')
  } finally {
    await runtime?.close()
    await rm(parent, { recursive: true, force: true })
  }
})

test('canonical and digest helpers reject Proxy input before any trap', () => {
  for (const helper of [canonicalJson, digestJson, jsonBytes]) {
    const proxied = zeroTrapProxy({ value: 'x' })
    assert.throws(() => helper(proxied.value), (error) => error.code === 'HOST_INVALID_JSON_VALUE')
    assert.equal(proxied.traps(), 0)
    const revoked = Proxy.revocable([], {})
    revoked.revoke()
    assert.throws(() => helper(revoked.proxy), (error) => error.code === 'HOST_INVALID_JSON_VALUE')
  }
})

test('runtime configuration snapshot rejects non-ordinary data without reads or Proxy traps', async () => {
  const rootProxy = zeroTrapProxy(fakeConfig())
  await assert.rejects(() => prepareRuntimeConfig(rootProxy.value), (error) => error.code === 'HOST_CONFIG_INVALID')
  assert.equal(rootProxy.traps(), 0)

  const nestedProxy = zeroTrapProxy(fakeConfig().providers[0])
  const nested = fakeConfig()
  nested.providers[0] = nestedProxy.value
  await assert.rejects(() => prepareRuntimeConfig(nested), (error) => error.code === 'HOST_CONFIG_INVALID')
  assert.equal(nestedProxy.traps(), 0)

  let getterReads = 0
  const accessor = fakeConfig()
  Object.defineProperty(accessor.providers[0], 'providerId', {
    enumerable: true,
    get() { getterReads += 1; return 'test.fake-capability' },
  })
  await assert.rejects(() => prepareRuntimeConfig(accessor), (error) => error.code === 'HOST_CONFIG_INVALID')
  assert.equal(getterReads, 0)

  const cases = []
  const hidden = fakeConfig()
  Object.defineProperty(hidden.providers[0], 'hidden', { value: true })
  cases.push(hidden)
  const symbol = fakeConfig()
  symbol.providers[0][Symbol('hidden')] = true
  cases.push(symbol)
  const exotic = fakeConfig()
  Object.setPrototypeOf(exotic.providers[0], { inherited: true })
  cases.push(exotic)
  const toJson = fakeConfig()
  Object.defineProperty(toJson.providers[0], 'toJSON', { value: () => ({}) })
  cases.push(toJson)
  const sparse = fakeConfig()
  sparse.providers.length = 2
  cases.push(sparse)
  const surrogateValue = fakeConfig()
  surrogateValue.providers[0].providerId = 'bad\ud800'
  cases.push(surrogateValue)
  const surrogateKey = fakeConfig()
  surrogateKey.providers[0]['bad\ud800'] = true
  cases.push(surrogateKey)
  for (const value of cases) {
    await assert.rejects(() => prepareRuntimeConfig(value), (error) => error.code === 'HOST_CONFIG_INVALID')
  }

  const revoked = Proxy.revocable(fakeConfig(), {})
  revoked.revoke()
  await assert.rejects(() => prepareRuntimeConfig(revoked.proxy), (error) => error.code === 'HOST_CONFIG_INVALID')
})

test('prepared configuration owns frozen arguments and a non-mutable provider registry', async () => {
  const source = fakeMcpConfig({ args: ['--startup-delay=5'] })
  const prepared = await prepareRuntimeConfig(source)
  const binding = prepared.providers.get('test.fake-mcp')
  source.providers[0].args.push('--narrow-schema')
  assert.deepEqual(binding.args, ['--startup-delay=5'])
  assert.equal(Object.isFrozen(binding.args), true)
  assert.equal(Object.isFrozen(binding), true)
  assert.equal(prepared.providers.set, undefined)
  assert.throws(() => binding.args.push('--changed'), TypeError)
})

test('work-order, selection, and resolution entries reject Proxy and accessor data without observation', async () => {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    for (const entry of ['run', 'validate']) {
      const proxied = zeroTrapProxy({ value: 'x' })
      const order = workOrder(entry, [fakeCall('call', proxied.value)])
      await assert.rejects(
        () => entry === 'run' ? runtime.runWorkOrder(order) : runtime.validateWorkOrder(order),
        (error) => error.code === 'HOST_INVALID_JSON_VALUE',
      )
      assert.equal(proxied.traps(), 0)
    }

    const selectionTarget = zeroTrapProxy(fakeCall('x', { value: 'x' }).target)
    await assert.rejects(
      () => runtime.projectContract({
        schemaVersion: 'openadam.direct-contract-selection.v0.1',
        providerId: 'test.fake-capability',
        target: selectionTarget.value,
      }),
      (error) => error.code === 'HOST_CONTRACT_SELECTION_INVALID',
    )
    assert.equal(selectionTarget.traps(), 0)

    const resolutionTarget = zeroTrapProxy(fakeCall('x', { value: 'x' }).target)
    await assert.rejects(
      () => runtime.resolveBindings({
        schemaVersion: 'openadam.direct-resolution-request.v0.1',
        target: resolutionTarget.value,
        constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
      }),
      (error) => error.code === 'HOST_RESOLUTION_REQUEST_INVALID',
    )
    assert.equal(resolutionTarget.traps(), 0)

    let reads = 0
    const input = {}
    Object.defineProperty(input, 'value', { enumerable: true, get() { reads += 1; return 'x' } })
    await assert.rejects(
      () => runtime.runWorkOrder(workOrder('accessor', [fakeCall('call', input)])),
      (error) => error.code === 'HOST_INVALID_JSON_VALUE',
    )
    assert.equal(reads, 0)
  } finally {
    await runtime.close()
  }
})

test('work-order dispatch and returned values are isolated from caller mutation and toJSON', async () => {
  const runtime = new DirectExecutionRuntime(
    await prepareRuntimeConfig(fakeConfig({ limits: { maxConcurrentCalls: 1 } })),
    {
      observationSink: {
        async write(observation) {
          observation.target.operationId = 'sink-mutated-operation'
        },
      },
    },
  )
  try {
    const input = { value: 'captured', delayMs: 30 }
    const order = workOrder('snapshot', [fakeCall('first', input), fakeCall('queued', { value: 'queued' })])
    const sourceTarget = order.calls[0].target
    const running = runtime.runWorkOrder(order)
    input.value = 'mutated'
    order.calls[1].input.value = 'mutated-queued'
    sourceTarget.operationId = 'mutated-operation'
    const result = await running
    assert.equal(result.calls[0].result.value, 'captured')
    assert.equal(result.calls[1].result.value, 'queued')
    assert.equal(result.calls[0].target.operationId, 'echo')
    assert.notEqual(result.calls[0].target, sourceTarget)
    result.calls[0].target.operationId = 'result-mutated'
    assert.equal(sourceTarget.operationId, 'mutated-operation')

    const hiddenToJson = { value: 'ordinary' }
    Object.defineProperty(hiddenToJson, 'toJSON', { value: () => ({ value: 'different' }) })
    await assert.rejects(
      () => runtime.runWorkOrder(workOrder('to-json', [fakeCall('call', hiddenToJson)])),
      (error) => error.code === 'HOST_INVALID_JSON_VALUE',
    )
  } finally {
    await runtime.close()
  }
})

test('provider identity drift fails closed before a new adapter process starts', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-binding-drift-'))
  const root = resolve(parent, 'fixture')
  let runtime
  try {
    await cp(fakeRoot, root, { recursive: true })
    runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig({ rootPath: root })))
    const adapterPath = resolve(root, 'adapter.mjs')
    await writeFile(adapterPath, `${await readFile(adapterPath, 'utf8')}\n// identity drift\n`)
    const result = await runtime.runWorkOrder(workOrder('drift', [fakeCall('call', { value: 'must-not-run' })]))
    assert.equal(result.calls[0].status, 'host_error')
    assert.equal(result.calls[0].error.code, 'HOST_PROVIDER_REPLACED')
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
  } finally {
    await runtime?.close()
    await rm(parent, { recursive: true, force: true })
  }
})

test('resolution semantic validator closes cross-field identity, count, and precedence relations', async () => {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    const result = await runtime.resolveBindings({
      schemaVersion: 'openadam.direct-resolution-request.v0.1',
      target: fakeCall('x', { value: 'x' }).target,
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
    })
    const isolated = await validateResolutionResult(result)
    assert.notEqual(isolated, result)
    for (const mutate of [
      (value) => { value.candidates[0].selection.providerId = 'different' },
      (value) => { value.candidates[0].target.operationId = 'different' },
      (value) => { value.summary.eligible = 64 },
      (value) => { value.summary.exactCandidates = 0 },
      (value) => { value.status = 'unknown' },
      (value) => { value.summary.configuredProviders = 0 },
      (value) => {
        value.candidates[0].status = 'ineligible'
        value.candidates[0].reasonCodes = ['HOST_SCHEMA_DRIFT']
        value.summary.eligible = 0
        value.summary.ineligible = 1
        value.status = 'ineligible'
      },
      (value) => { value.candidates[0].observation.observedAt = '2999-01-01T00:00:00.000Z' },
      (value) => {
        value.candidates = []
        value.summary.exactCandidates = 0
        value.summary.eligible = 0
        value.summary.ineligible = 0
        value.summary.unknown = 0
        value.status = 'ineligible'
        value.reasonCodes = ['NO_EXACT_BINDING']
      },
    ]) {
      const contradictory = structuredClone(result)
      mutate(contradictory)
      await assert.rejects(
        () => validateResolutionResult(contradictory),
        (error) => error.code === 'HOST_RESOLUTION_RESULT_INVALID',
      )
    }

    const rejected = await runtime.resolveBindings({
      schemaVersion: 'openadam.direct-resolution-request.v0.1',
      target: fakeCall('x', { value: 'x' }).target,
      constraints: {
        effectAllowance: 'read-only',
        dataLocality: 'local-process',
        requiredContractDigest: `sha256:${'0'.repeat(64)}`,
        maxContractSchemaBytes: 1,
      },
    })
    for (const mutate of [
      (value) => { value.candidates[0].reasonCodes.reverse() },
      (value) => {
        value.candidates[0].observation.contractDigest = value.request.constraints.requiredContractDigest
      },
      (value) => { value.candidates[0].observation.contractSchemaBytes = 1 },
    ]) {
      const contradictory = structuredClone(rejected)
      mutate(contradictory)
      await assert.rejects(
        () => validateResolutionResult(contradictory),
        (error) => error.code === 'HOST_RESOLUTION_RESULT_INVALID',
      )
    }
  } finally {
    await runtime.close()
  }
})

test('resolution validator never admits HOST_UNKNOWN_OPERATION as a projected-operation candidate', async () => {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeProjectedMcpConfig({
    args: ['--startup-fail'],
    limits: { defaultTimeoutMs: 10000 },
  })))
  try {
    const result = await runtime.resolveBindings({
      schemaVersion: 'openadam.direct-resolution-request.v0.1',
      target: { kind: 'mcp-operation', toolName: 'dispatch', operationId: 'text.echo' },
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
    })
    const contradictory = structuredClone(result)
    contradictory.candidates[0].observation.error.code = 'HOST_UNKNOWN_OPERATION'
    contradictory.candidates[0].reasonCodes = ['HOST_UNKNOWN_OPERATION']
    await assert.rejects(
      () => validateResolutionResult(contradictory),
      (error) => error.code === 'HOST_RESOLUTION_RESULT_INVALID',
    )
  } finally {
    await runtime.close()
  }
})

test('close atomically cancels active and queued work, waits for settlement, and stays closed', async () => {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig({
    limits: { maxConcurrentCalls: 1, maxQueuedCalls: 4 },
  })))
  const running = runtime.runWorkOrder(workOrder('closing', [
    fakeCall('active', { value: 'active', delayMs: 200 }),
    fakeCall('queued', { value: 'queued', delayMs: 200 }),
  ]))
  await delay(20)
  const firstClose = runtime.close()
  const secondClose = runtime.close()
  const result = await running
  await Promise.all([firstClose, secondClose])
  assert.deepEqual(result.calls.map((call) => call.error.code), ['HOST_CANCELLED', 'HOST_CANCELLED'])
  assert.deepEqual(runtime.admissionSnapshot(), {
    active: 0,
    queued: 0,
    queuedGroups: 0,
    maxConcurrentCalls: 1,
    maxQueuedCalls: 4,
  })
  assert.equal(runtime.sessionSnapshot()[0].present, false)
  assert.equal(runtime.sessionSnapshot()[0].pid, null)
  await assert.rejects(
    () => runtime.runWorkOrder(workOrder('post-close', [fakeCall('call', { value: 'x' })])),
    (error) => error.code === 'HOST_RUNTIME_CLOSED',
  )
  await runtime.close()
})
