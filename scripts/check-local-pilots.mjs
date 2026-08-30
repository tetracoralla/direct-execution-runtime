#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { EVALS_DRIVER_ID, EVALS_DRIVER_VERSION } from '../src/evals-driver-identity.mjs'
import { requestDirectHost } from '../src/host-client.mjs'
import { DirectHostService } from '../src/host-service.mjs'
import { jsonBytes } from '../src/json.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { JsonlObservationSink } from '../src/observations.mjs'
import { checkSchemaParity } from './check-schema-parity.mjs'
import { resolveMathAnchorRoot } from './local-pilot-paths.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(root, '..')
const mathAnchorRoot = resolveMathAnchorRoot(workspace)
const timeRoot = resolve(workspace, 'migratory-time')
const dependencyRoot = resolve(workspace, 'dependency-preflight')
const structuredRoot = resolve(workspace, 'structured-data-preflight')
const procedureProfilePath = resolve(
  workspace,
  'procedure-contracts/catalog/procedures/package-dependency-change-preflight.v0.2.json',
)
const timeCapabilityProfilePath = resolve(
  workspace,
  'capability-contracts/catalog/capabilities/time-zone-convert.v0.2.json',
)
const dependencyCapabilityProfilePath = resolve(
  workspace,
  'capability-contracts/catalog/capabilities/package-dependency-evaluate.v0.1.json',
)
const structuredProcedureProfilePath = resolve(
  workspace,
  'procedure-contracts/catalog/procedures/structured-data-preflight.v0.3.json',
)
const observationLogPath = process.env.OPENADAM_DIRECT_OBSERVATION_LOG

function createRuntime(preparedConfig) {
  return new DirectExecutionRuntime(preparedConfig, {
    ...(observationLogPath === undefined ? {} : {
      observationSink: new JsonlObservationSink(resolve(observationLogPath)),
    }),
  })
}

function projectVersion(projectToml) {
  const projectStart = projectToml.indexOf('[project]')
  if (projectStart === -1) throw new Error('Math Anchor project metadata has no [project] section')
  const projectSection = projectToml.slice(projectStart + '[project]'.length).split(/^\[/mu)[0]
  const match = projectSection.match(/^\s*version\s*=\s*"([^"]+)"\s*$/mu)
  if (match === null) throw new Error('Math Anchor project metadata has no project version')
  return match[1]
}

function waitForJsonLine(child, timeoutMs = 15_000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const finish = (method, value) => {
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      method(value)
    }
    const onStderr = (chunk) => { stderr += chunk.toString('utf8') }
    const onError = (error) => finish(reject, error)
    const onExit = (code, signal) => finish(reject, new Error(`service exited before readiness: ${code ?? signal}: ${stderr}`))
    const onStdout = (chunk) => {
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline === -1) return
      try {
        finish(resolvePromise, JSON.parse(stdout.slice(0, newline)))
      } catch (error) {
        finish(reject, error)
      }
    }
    const timer = setTimeout(() => finish(reject, new Error(`service readiness timed out: ${stderr}`)), timeoutMs)
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

const schemaParity = await checkSchemaParity()
let mathAnchorVersion
try {
  mathAnchorVersion = projectVersion(await readFile(resolve(mathAnchorRoot, 'pyproject.toml'), 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  process.stdout.write(`${JSON.stringify({
    status: 'incomplete',
    schemaParity,
    providerPilot: {
      status: 'not_run',
      reason: 'Math Anchor checkout is unavailable; set OPENADAM_MATH_ANCHOR_ROOT',
    },
  })}\n`)
  process.exit(2)
}

const limits = {
  maxConcurrentCalls: 8,
  maxQueuedCalls: 64,
  maxWorkOrderCalls: 96,
  maxWorkOrderBytes: 1024 * 1024,
  maxProviderResponseBytes: 512 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  maxProtocolLineBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  defaultTimeoutMs: 15_000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 250,
}

function providers(dependencyLifecycle = 'persistent') {
  return [
    {
      providerId: 'io.github.tetracoralla.math-anchor',
      transport: 'mcp-stdio',
      lifecycle: 'persistent',
      rootPath: mathAnchorRoot,
      command: resolve(mathAnchorRoot, '.venv/bin/math-anchor-mcp'),
      args: [],
      cwd: mathAnchorRoot,
      identityFiles: [
        resolve(mathAnchorRoot, '.venv/bin/math-anchor-mcp'),
        resolve(mathAnchorRoot, 'src/math_anchor/mcp_server.py'),
        resolve(mathAnchorRoot, 'pyproject.toml'),
      ],
      expectedServer: { name: 'Math Anchor', version: mathAnchorVersion },
      allowedTools: ['math.run', 'math.batch', 'math.describe'],
      operationProjections: [{
        toolName: 'math.run',
        operationField: 'operation',
        argumentsField: 'arguments',
        batchToolName: 'math.batch',
        batchItemsField: 'items',
        schemaLookup: {
          toolName: 'math.describe',
          operationField: 'operation',
          resultPath: ['operation', 'inputSchema'],
        },
      }],
    },
    {
      providerId: 'io.github.tetracoralla.migratory-time',
      transport: 'capability-jsonl-v0.1',
      lifecycle: 'persistent',
      rootPath: timeRoot,
      profilePath: timeCapabilityProfilePath,
      manifestPath: resolve(timeRoot, 'capabilities/provider.json'),
      identityFiles: [resolve(timeRoot, 'scripts/runCapabilityAdapter.mjs')],
      capabilityId: 'org.openadam.time-zone.convert',
      capabilityVersion: '0.2.0',
      contracts: [{
        operationId: 'convert',
        inputSchemaPath: resolve(timeRoot, 'capabilities/schemas/time-zone.convert.input.schema.json'),
        outputSchemaPath: resolve(timeRoot, 'capabilities/schemas/time-zone.convert.output.schema.json'),
      }],
    },
    {
      providerId: 'org.openadam.dependency-preflight',
      transport: 'procedure-jsonl-v0.2',
      lifecycle: dependencyLifecycle,
      rootPath: dependencyRoot,
      profilePath: procedureProfilePath,
      implementationManifestPath: resolve(dependencyRoot, 'procedure/implementation-manifest.json'),
      identityFiles: [resolve(dependencyRoot, 'src/procedure-adapter.mjs')],
      procedureId: 'org.openadam.package-dependency.change-preflight',
      procedureVersion: '0.2.0',
      inputSchemaPath: resolve(dependencyRoot, 'contracts/schemas/package-dependency.change-preflight.input.schema.json'),
      outputSchemaPath: resolve(dependencyRoot, 'contracts/schemas/package-dependency.change-preflight.output.schema.json'),
    },
  ]
}

function dependencyCapabilityProvider(lifecycle = 'per-call') {
  return {
    providerId: 'org.openadam.dependency-preflight',
    transport: 'capability-jsonl-v0.1',
    lifecycle,
    rootPath: dependencyRoot,
    profilePath: dependencyCapabilityProfilePath,
    manifestPath: resolve(dependencyRoot, 'capabilities/provider.json'),
    identityFiles: [resolve(dependencyRoot, 'src/capability-adapter.mjs')],
    capabilityId: 'org.openadam.package-dependency.evaluate',
    capabilityVersion: '0.1.0',
    contracts: [{
      operationId: 'verify-target',
      inputSchemaPath: resolve(dependencyRoot, 'contracts/schemas/package-dependency.verify-target.input.schema.json'),
      outputSchemaPath: resolve(dependencyRoot, 'contracts/schemas/package-dependency.verify-target.output.schema.json'),
    }],
  }
}

function structuredProcedureProvider() {
  return {
    providerId: 'org.openadam.structured-data-preflight',
    transport: 'procedure-jsonl-v0.2',
    lifecycle: 'persistent',
    rootPath: structuredRoot,
    profilePath: structuredProcedureProfilePath,
    implementationManifestPath: resolve(structuredRoot, 'procedure/implementation-manifest.json'),
    identityFiles: [resolve(structuredRoot, 'src/structured_data_preflight/adapter.py')],
    procedureId: 'org.openadam.structured-data.preflight',
    procedureVersion: '0.3.0',
    inputSchemaPath: resolve(structuredRoot, 'src/structured_data_preflight/schemas/structured-data.preflight.input.schema.json'),
    outputSchemaPath: resolve(structuredRoot, 'src/structured_data_preflight/schemas/structured-data.preflight.output.schema.json'),
  }
}

function config(selectedProviders = providers()) {
  return { schemaVersion: 'openadam.direct-provider-config.v0.2', limits, providers: selectedProviders }
}

function mathCall(id = 'math') {
  return {
    id,
    providerId: 'io.github.tetracoralla.math-anchor',
    target: {
      kind: 'mcp-operation',
      toolName: 'math.run',
      operationId: 'expression.evaluate',
    },
    input: { operation: 'expression.evaluate', arguments: { expression: '6*7' } },
  }
}

function timeCall(id = 'time') {
  return {
    id,
    providerId: 'io.github.tetracoralla.migratory-time',
    target: {
      kind: 'capability',
      capabilityId: 'org.openadam.time-zone.convert',
      capabilityVersion: '0.2.0',
      operationId: 'convert',
    },
    input: {
      localDateTime: '2026-08-24T12:00',
      sourceTimeZone: 'UTC',
      targetTimeZones: ['Asia/Tokyo'],
      disambiguation: 'reject',
    },
  }
}

function dependencyCall(id = 'dependency') {
  return {
    id,
    providerId: 'org.openadam.dependency-preflight',
    target: {
      kind: 'procedure',
      procedureId: 'org.openadam.package-dependency.change-preflight',
      procedureVersion: '0.2.0',
    },
    input: {
      dependency: 'ajv',
      beforeSpec: '^8.17.1',
      afterSpec: '^8.20.0',
      changeState: 'proposed',
      targetEvidence: { packagePresent: true, resolvedVersion: '8.20.0' },
      surfaceEvidence: { requiredPaths: ['dist/2020.js'], availablePaths: ['dist/2020.js', 'package.json'] },
      lockfileEvidence: { rootSpec: '^8.20.0', lockedVersion: '8.20.0' },
      consumerCheck: { checkId: 'npm-test', status: 'passed' },
    },
  }
}

function dependencyCapabilityCall(id = 'dependency-capability') {
  return {
    id,
    providerId: 'org.openadam.dependency-preflight',
    target: {
      kind: 'capability',
      capabilityId: 'org.openadam.package-dependency.evaluate',
      capabilityVersion: '0.1.0',
      operationId: 'verify-target',
    },
    input: {
      dependency: 'ajv',
      afterSpec: '^8.20.0',
      packagePresent: true,
      resolvedVersion: '8.20.0',
    },
  }
}

function structuredProcedureCall(id, validation) {
  const input = { path: 'fixtures/users.json', sample_rows: 1, select: 'data.users[*]' }
  if (validation !== undefined) input.validation = validation
  return {
    id,
    providerId: 'org.openadam.structured-data-preflight',
    target: {
      kind: 'procedure',
      procedureId: 'org.openadam.structured-data.preflight',
      procedureVersion: '0.3.0',
    },
    input,
  }
}

function order(id, calls) {
  return { schemaVersion: 'openadam.direct-work-order.v0.1', id, calls }
}

function assertSemanticResult(result) {
  const byId = new Map(result.calls.map((call) => [call.id, call]))
  if (byId.has('math') && byId.get('math').result?.exact !== '42') throw new Error('Math Anchor semantic result mismatch')
  if (byId.has('time')) {
    const value = byId.get('time').result
    if (value?.status !== 'converted' || value.results?.[0]?.localDateTime !== '2026-08-24T21:00') {
      throw new Error('Migratory Time semantic result mismatch')
    }
  }
  if (
    byId.has('dependency') &&
    (byId.get('dependency').result?.status !== 'ok' || byId.get('dependency').result?.disposition !== 'land')
  ) {
    throw new Error('Dependency Preflight semantic result mismatch')
  }
  if (byId.has('dependency-capability') && byId.get('dependency-capability').result?.verification !== 'verified') {
    throw new Error('Dependency Preflight Capability semantic result mismatch')
  }
}

function quantiles(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
  return { samples: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) }
}

async function timed(runtime, workOrder) {
  const started = performance.now()
  const result = await runtime.runWorkOrder(workOrder)
  return { elapsedMs: performance.now() - started, result, resultBytes: jsonBytes(result) }
}

async function coldRoute(provider, makeCall, repetitions = 3) {
  const samples = []
  const bytes = []
  for (let index = 0; index < repetitions; index += 1) {
    const runtime = createRuntime(await prepareRuntimeConfig(config([provider])))
    try {
      const measured = await timed(runtime, order(`cold-${index}`, [makeCall(makeCall().id)]))
      if (measured.result.calls[0].status !== 'ok') throw new Error(`cold route failed for ${provider.providerId}`)
      samples.push(measured.elapsedMs)
      bytes.push(measured.resultBytes)
    } finally {
      await runtime.close()
    }
  }
  return { latencyMs: quantiles(samples), resultBytes: quantiles(bytes) }
}

async function processTreeRss(rootPids) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='])
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
  const children = new Map()
  const rss = new Map()
  for (const [pid, parent, kilobytes] of rows) {
    rss.set(pid, kilobytes)
    const values = children.get(parent) ?? []
    values.push(pid)
    children.set(parent, values)
  }
  const included = new Set()
  const visit = (pid) => {
    if (included.has(pid) || !rss.has(pid)) return
    included.add(pid)
    for (const child of children.get(pid) ?? []) visit(child)
  }
  for (const pid of rootPids.filter((value) => Number.isInteger(value))) visit(pid)
  return { processes: included.size, rssKiB: [...included].reduce((total, pid) => total + (rss.get(pid) ?? 0), 0) }
}

const conditionalRuntime = createRuntime(
  await prepareRuntimeConfig(config([structuredProcedureProvider()])),
)
let conditionalProcedure
try {
  const conditionalResult = await conditionalRuntime.runWorkOrder(order('conditional-procedure', [
    structuredProcedureCall('without-validation'),
    structuredProcedureCall('with-validation', { assertions: [{ id: 'has-rows', type: 'row_count', min: 1 }] }),
  ]))
  if (conditionalResult.summary.failed !== 0) {
    throw new Error('conditional Procedure did not execute both completion branches')
  }
  conditionalProcedure = {
    calls: conditionalResult.calls.length,
    withoutValidation: !Object.hasOwn(conditionalResult.calls[0].result ?? {}, 'validation'),
    withValidation: conditionalResult.calls[1].result?.validation?.valid === true,
  }
  if (!conditionalProcedure.withoutValidation || !conditionalProcedure.withValidation) {
    throw new Error('conditional Procedure returned the wrong completion payload')
  }
} finally {
  await conditionalRuntime.close()
}

const prepared = await prepareRuntimeConfig(config())
const runtime = createRuntime(prepared)
let report
const observedRootPids = new Set()
try {
  const inspectedCold = await runtime.inspectBindings()
  const roots = inspectedCold.providers.map((provider) => provider.pid).filter(Boolean)
  for (const pid of roots) observedRootPids.add(pid)
  const resourcesBefore = await processTreeRss(roots)

  const semantic = await timed(runtime, order('semantic', [mathCall(), timeCall(), dependencyCall()]))
  assertSemanticResult(semantic.result)

  const warm = {}
  for (const [name, makeCall] of [['math', mathCall], ['time', timeCall], ['dependency', dependencyCall]]) {
    const samples = []
    const bytes = []
    for (let index = 0; index < 20; index += 1) {
      const measured = await timed(runtime, order(`warm-${name}-${index}`, [makeCall(name)]))
      if (measured.result.calls[0].status !== 'ok') throw new Error(`warm ${name} call failed`)
      samples.push(measured.elapsedMs)
      bytes.push(measured.resultBytes)
    }
    warm[name] = { latencyMs: quantiles(samples), resultBytes: quantiles(bytes) }
  }

  const burstCalls = Array.from({ length: 24 }, (_, index) => {
    const family = index % 3
    return family === 0 ? mathCall(`burst-${index}`) : family === 1 ? timeCall(`burst-${index}`) : dependencyCall(`burst-${index}`)
  })
  const burst = await timed(runtime, order('burst', burstCalls))
  if (burst.result.summary.failed !== 0) throw new Error('mixed 24-call burst did not complete')

  const batchItems = Array.from({ length: 8 }, (_, index) => ({
    operation: 'expression.evaluate',
    arguments: { expression: `${index}+${index}` },
  }))
  const nativeBatch = await timed(runtime, order('native-batch', [{
    id: 'math-batch',
    providerId: 'io.github.tetracoralla.math-anchor',
    target: { kind: 'mcp-tool', toolName: 'math.batch' },
    input: { items: batchItems },
  }]))
  if (nativeBatch.result.calls[0].result?.results?.length !== 8) throw new Error('Math Anchor native batch mismatch')

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const cancelled = await runtime.runWorkOrder(order('cancel-mcp', [{
    id: 'cancelled-math',
    providerId: 'io.github.tetracoralla.math-anchor',
    target: {
      kind: 'mcp-operation',
      toolName: 'math.run',
      operationId: 'numeric.integrate',
    },
    input: {
      operation: 'numeric.integrate',
      arguments: {
        expression: 'sin(x)', variable: 'x', lower: '0', upper: '3.14159265358979323846', featureScale: '0.1',
      },
    },
  }]), { signal: controller.signal })
  if (!['HOST_CANCELLED', 'HOST_TIMEOUT'].includes(cancelled.calls[0].error?.code)) {
    throw new Error('live MCP cancellation did not reach a host cancellation boundary')
  }
  const cancelRecovery = await runtime.runWorkOrder(order('cancel-recovery', [mathCall()]))
  assertSemanticResult(cancelRecovery)

  await runtime.replaceProvider('io.github.tetracoralla.migratory-time')
  const replacementRecovery = await runtime.runWorkOrder(order('replacement-recovery', [timeCall()]))
  assertSemanticResult(replacementRecovery)
  if (replacementRecovery.calls[0].session !== 'cold') throw new Error('explicit provider replacement did not start a new session')

  const inspectedWarm = await runtime.inspectBindings()
  const warmRoots = inspectedWarm.providers.map((provider) => provider.pid).filter(Boolean)
  for (const pid of warmRoots) observedRootPids.add(pid)
  const resourcesWarm = await processTreeRss(warmRoots)

  const runSoak = async (firstGroup) => {
    const started = performance.now()
    let failed = 0
    for (let group = firstGroup; group < firstGroup + 10; group += 1) {
      const soakCalls = Array.from({ length: 30 }, (_, index) => {
        const item = group * 30 + index
        const family = item % 3
        return family === 0 ? mathCall(`soak-${item}`) : family === 1 ? timeCall(`soak-${item}`) : dependencyCall(`soak-${item}`)
      })
      const soakResult = await runtime.runWorkOrder(order(`soak-group-${group}`, soakCalls))
      failed += soakResult.summary.failed
    }
    return { calls: 300, failed, elapsedMs: performance.now() - started }
  }
  const soakOne = await runSoak(0)
  if (soakOne.failed !== 0) throw new Error('first 300-call mixed soak did not complete')
  const resourcesAfterSoakOne = await processTreeRss(warmRoots)
  const soakTwo = await runSoak(10)
  if (soakTwo.failed !== 0) throw new Error('second 300-call mixed soak did not complete')
  const resourcesAfterSoakTwo = await processTreeRss(warmRoots)

  const cold = {}
  const definitions = providers()
  for (const [name, providerId, makeCall] of [
    ['math', 'io.github.tetracoralla.math-anchor', mathCall],
    ['time', 'io.github.tetracoralla.migratory-time', timeCall],
    ['dependency', 'org.openadam.dependency-preflight', dependencyCall],
  ]) {
    cold[name] = await coldRoute(definitions.find((provider) => provider.providerId === providerId), makeCall)
  }

  const mathDefinition = definitions.find((provider) => provider.providerId === 'io.github.tetracoralla.math-anchor')
  const startupRuntime = createRuntime(await prepareRuntimeConfig(config([mathDefinition])))
  let startupDeadline
  try {
    const startupCall = mathCall('startup-timeout')
    startupCall.timeoutMs = 1
    const timedOutStartup = await startupRuntime.runWorkOrder(order('startup-timeout', [startupCall]))
    if (timedOutStartup.calls[0].error?.code !== 'HOST_TIMEOUT') {
      throw new Error('cold MCP startup did not honor the one-millisecond whole-call deadline')
    }
    const timedOutSession = startupRuntime.sessionSnapshot()[0]
    if (timedOutSession.pid !== null) throw new Error('timed-out cold MCP startup retained a live child process')
    const startupRecovery = await startupRuntime.runWorkOrder(order('startup-recovery', [mathCall()]))
    assertSemanticResult(startupRecovery)
    startupDeadline = {
      timeoutCode: 'HOST_TIMEOUT',
      childPidAfterTimeout: timedOutSession.pid,
      recoveryStatus: startupRecovery.calls[0].status,
    }
  } finally {
    await startupRuntime.close()
  }

  const perCallDefinition = dependencyCapabilityProvider('per-call')
  const perCallRuntime = createRuntime(await prepareRuntimeConfig(config([perCallDefinition])))
  let perCall
  try {
    perCall = await perCallRuntime.runWorkOrder(order('per-call-jsonl', [
      dependencyCapabilityCall('dependency-capability'),
      dependencyCapabilityCall('per-call-2'),
      dependencyCapabilityCall('per-call-3'),
    ]))
    if (perCall.calls.some((call) => call.status !== 'ok' || call.session !== 'cold')) {
      throw new Error('per-call JSONL lifecycle did not remain short-lived')
    }
  } finally {
    await perCallRuntime.close()
  }

  const cliDirectory = await mkdtemp(resolve(tmpdir(), 'direct-exec-real-cli-'))
  let cliSmoke
  try {
    const configPath = resolve(cliDirectory, 'providers.json')
    const workOrderPath = resolve(cliDirectory, 'work-order.json')
    await writeFile(configPath, `${JSON.stringify(config(providers('per-call')))}\n`)
    await writeFile(workOrderPath, `${JSON.stringify(order('real-cli', [mathCall(), timeCall(), dependencyCall()]))}\n`)
    const cliPath = resolve(root, 'src/cli.mjs')
    const validated = await execFileAsync(process.execPath, [cliPath, 'validate', '--config', configPath, '--work-order', workOrderPath])
    const validation = JSON.parse(validated.stdout)
    if (validation.status !== 'valid') throw new Error('real-provider CLI validation failed')
    const ran = await execFileAsync(process.execPath, [cliPath, 'run', '--config', configPath, '--work-order', workOrderPath])
    const cliResult = JSON.parse(ran.stdout)
    assertSemanticResult(cliResult)
    cliSmoke = { validation: validation.status, run: cliResult.status, resultBytes: Buffer.byteLength(ran.stdout) }
  } finally {
    await rm(cliDirectory, { recursive: true, force: true })
  }

  const hostDirectory = await mkdtemp(resolve(tmpdir(), 'direct-exec-real-host-'))
  const hostSocketPath = resolve(hostDirectory, 'runtime.sock')
  const hostRuntime = createRuntime(await prepareRuntimeConfig(config()))
  const hostService = new DirectHostService(hostRuntime, { socketPath: hostSocketPath })
  let hostServiceSmoke
  let evalsSmoke
  try {
    const ready = await hostService.start()
    const hostOrder = order('real-host-first', [mathCall(), timeCall(), dependencyCall()])
    const first = await requestDirectHost({ socketPath: hostSocketPath, action: 'run', workOrder: hostOrder })
    assertSemanticResult(first)
    const second = await requestDirectHost({
      socketPath: hostSocketPath,
      action: 'run',
      workOrder: { ...hostOrder, id: 'real-host-second' },
    })
    assertSemanticResult(second)
    const firstSessions = first.calls.map((call) => call.session)
    const secondSessions = second.calls.map((call) => call.session)
    if (firstSessions.some((session) => session !== 'cold')) {
      throw new Error('first real-provider host request did not start cold sessions')
    }
    if (secondSessions.some((session) => session !== 'warm')) {
      throw new Error('second real-provider host request did not reuse provider sessions')
    }
    const hostBindings = await requestDirectHost({ socketPath: hostSocketPath, action: 'inspect' })
    hostServiceSmoke = {
      ready: ready.status,
      clients: 3,
      firstSessions,
      secondSessions,
      providerProcesses: hostBindings.providers.filter((provider) => provider.pid !== null).length,
      socketMode: (await lstat(hostSocketPath)).mode & 0o777,
    }

    const mathBinding = hostBindings.providers.find(
      (provider) => provider.providerId === 'io.github.tetracoralla.math-anchor',
    )
    const evalsDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'direct-exec-real-evals-')))
    try {
      const suitePath = resolve(evalsDirectory, 'suite.json')
      const planPath = resolve(evalsDirectory, 'plan.json')
      const reportPath = resolve(evalsDirectory, 'report.json')
      const targetRef = { id: 'io.github.tetracoralla.math-anchor.math-run', version: mathBinding.bindingDigest }
      const providerRef = {
        id: mathBinding.providerId,
        version: mathBinding.live.serverVersion.version,
      }
      const suite = {
        schemaVersion: 'openadam.agent-tool-eval.direct-task-suite.v0.1',
        executionMode: 'direct-host',
        id: 'direct-execution-runtime.math-anchor',
        version: '0.1.0',
        title: 'Direct Execution Runtime Math Anchor adapter smoke',
        targetRef,
        tasks: [{
          id: 'expression.evaluate',
          tags: ['local-pilot'],
          invocation: {
            operationId: 'expression.evaluate',
            input: { operation: 'expression.evaluate', arguments: { expression: '6*7' } },
          },
          evaluator: {
            kind: 'string-equality',
            actualPointer: '/exact',
            expected: '42',
            trim: false,
            caseSensitive: true,
          },
        }],
      }
      const plan = {
        schemaVersion: 'openadam.agent-tool-eval.direct-plan.v0.1',
        executionMode: 'direct-host',
        id: 'direct-execution-runtime.math-anchor.smoke',
        title: 'Persistent direct host through Agent Tool Evals',
        purpose: 'development-smoke',
        suiteRef: { id: suite.id, version: suite.version },
        targetRef,
        providerRef,
        repeats: 2,
        budget: {
          perCallTimeoutMs: 5000,
          maxRequestBytes: 65536,
          maxStdoutBytes: 65536,
          maxStderrBytes: 16384,
          maxReportBytes: 1048576,
        },
        capture: { answer: 'digest' },
        driver: {
          id: EVALS_DRIVER_ID,
          version: EVALS_DRIVER_VERSION,
          root,
          command: resolve(root, 'src/evals-driver.mjs'),
          args: [
            '--socket', hostSocketPath,
            '--provider-id', providerRef.id,
            '--provider-version', providerRef.version,
            '--target-id', targetRef.id,
            '--target-version', targetRef.version,
            '--target-kind', 'mcp-operation',
            '--tool-name', 'math.run',
            '--operation-id', 'expression.evaluate',
          ],
        },
        oracleIsolation: { mode: 'deny-read-roots' },
      }
      await Promise.all([
        writeFile(suitePath, `${JSON.stringify(suite)}\n`),
        writeFile(planPath, `${JSON.stringify(plan)}\n`),
      ])
      const evalsCli = resolve(workspace, 'agent-tool-evals/src/cli.mjs')
      await execFileAsync(process.execPath, [
        evalsCli, 'direct-run', '--suite', suitePath, '--plan', planPath, '--output', reportPath,
      ], { maxBuffer: 4 * 1024 * 1024 })
      const evalReport = JSON.parse(await readFile(reportPath, 'utf8'))
      if (
        evalReport.runs?.length !== 2 ||
        evalReport.runs.some((run) => run.transportStatus !== 'completed' || run.invocationStatus !== 'success' || run.grade?.passed !== true)
      ) {
        throw new Error('Agent Tool Evals did not complete and grade both direct-host driver runs')
      }
      evalsSmoke = {
        protocol: 'openadam.agent-tool-eval.direct-driver-request.v0.1',
        runs: evalReport.runs.length,
        completed: evalReport.summary.runCounts.completed,
        passed: evalReport.summary.success.passed,
        costUnknown: evalReport.summary.cost.unknownRuns,
        observedLatencyMs: evalReport.runs.map((run) => run.observedLatencyMs),
      }
    } finally {
      await rm(evalsDirectory, { recursive: true, force: true })
    }
  } finally {
    await hostService.close()
    const socketAfterClose = await lstat(hostSocketPath).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (socketAfterClose !== undefined) throw new Error('real-provider host socket remained after close')
    await rm(hostDirectory, { recursive: true, force: true })
  }

  const packagedDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'direct-exec-real-package-')))
  let packagedRealHostSmoke
  try {
    const packed = await execFileAsync('npm', ['pack', '--json', '--pack-destination', packagedDirectory], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    })
    const packageMetadata = JSON.parse(packed.stdout)[0]
    const tarball = resolve(packagedDirectory, packageMetadata.filename)
    const consumer = resolve(packagedDirectory, 'consumer')
    await execFileAsync('npm', [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball,
    ], { cwd: packagedDirectory, maxBuffer: 4 * 1024 * 1024 })
    const configPath = resolve(packagedDirectory, 'providers.json')
    const firstOrderPath = resolve(packagedDirectory, 'first.json')
    const secondOrderPath = resolve(packagedDirectory, 'second.json')
    const socketPath = resolve(packagedDirectory, 'runtime.sock')
    await Promise.all([
      writeFile(configPath, `${JSON.stringify(config())}\n`),
      writeFile(firstOrderPath, `${JSON.stringify(order('packaged-real-first', [mathCall(), timeCall(), dependencyCall()]))}\n`),
      writeFile(secondOrderPath, `${JSON.stringify(order('packaged-real-second', [mathCall(), timeCall(), dependencyCall()]))}\n`),
    ])
    const installedCli = resolve(consumer, 'node_modules/@openadam/direct-execution-runtime/src/cli.mjs')
    const service = spawn(process.execPath, [installedCli, 'serve', '--config', configPath, '--socket', socketPath], {
      cwd: consumer,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serviceExit = new Promise((resolvePromise) => {
      service.once('exit', (code, signal) => resolvePromise({ code, signal }))
      service.once('error', (error) => resolvePromise({ error }))
    })
    let providerPids = []
    try {
      const ready = await waitForJsonLine(service)
      const firstRun = await execFileAsync(process.execPath, [
        installedCli, 'run', '--socket', socketPath, '--work-order', firstOrderPath,
      ], { maxBuffer: 4 * 1024 * 1024 })
      const secondRun = await execFileAsync(process.execPath, [
        installedCli, 'run', '--socket', socketPath, '--work-order', secondOrderPath,
      ], { maxBuffer: 4 * 1024 * 1024 })
      const first = JSON.parse(firstRun.stdout)
      const second = JSON.parse(secondRun.stdout)
      assertSemanticResult(first)
      assertSemanticResult(second)
      const firstSessions = first.calls.map((call) => call.session)
      const secondSessions = second.calls.map((call) => call.session)
      if (firstSessions.some((session) => session !== 'cold') || secondSessions.some((session) => session !== 'warm')) {
        throw new Error('installed real-provider service did not preserve cold then warm lifecycle')
      }
      const inspected = JSON.parse((await execFileAsync(process.execPath, [
        installedCli, 'inspect', '--socket', socketPath,
      ])).stdout)
      providerPids = inspected.providers.map((provider) => provider.pid).filter(Boolean)
      packagedRealHostSmoke = {
        package: packageMetadata.id,
        ready: ready.status,
        providers: inspected.providers.length,
        firstSessions,
        secondSessions,
        packedBytes: packageMetadata.size,
      }
    } finally {
      if (service.exitCode === null && service.signalCode === null) service.kill('SIGTERM')
      const exited = await serviceExit
      if (exited.error !== undefined) throw exited.error
      if (exited.code !== 0) throw new Error(`installed real-provider service did not stop cleanly: ${exited.code ?? exited.signal}`)
    }
    const [socketAfterClose, processesAfterClose] = await Promise.all([
      lstat(socketPath).catch((error) => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }),
      processTreeRss(providerPids),
    ])
    if (socketAfterClose !== undefined || processesAfterClose.processes !== 0) {
      throw new Error('installed real-provider service retained an owned socket or provider process')
    }
    packagedRealHostSmoke.cleanup = { socketRemoved: true, providerProcesses: 0 }
  } finally {
    await rm(packagedDirectory, { recursive: true, force: true })
  }

  report = {
    schemaVersion: 'openadam.direct-provider-pilot-observation.v0.1',
    observedAt: new Date().toISOString(),
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    scope: {
      providers: inspectedWarm.providers.map((provider) => ({
        providerId: provider.providerId,
        observedVersion: provider.live?.providerVersion ?? provider.live?.serverVersion?.version ?? null,
        versionSource: provider.transport === 'mcp-stdio' ? 'live-mcp-server' : 'current-provider-manifest',
      })),
      modelCallsInsideRuntime: 0,
      coldAgentRoute: { status: 'not_run', tokenUsage: null, reason: 'model or paid harness execution is outside this implementation check' },
      formalSlo: null,
      standardSchemas: 'current Capability Profile v0.3 and Provider Manifest v0.3, Procedure Profile v0.5 and implementation manifest v0.5, and Agent Tool Evals direct-driver v0.1 workspace schemas match bundled bytes',
    },
    bindings: inspectedWarm.providers,
    semantic: {
      status: semantic.result.status,
      resultBytes: semantic.resultBytes,
      latencyMs: semantic.elapsedMs,
    },
    conditionalProcedure,
    cliSmoke,
    hostServiceSmoke,
    evalsSmoke,
    packagedRealHostSmoke,
    routes: {
      coldDirect: cold,
      warmDirect: warm,
      shortLivedJsonl: {
        targetKind: 'capability',
        calls: perCall.calls.length,
        sessions: perCall.calls.map((call) => call.session),
        failed: perCall.summary.failed,
      },
      nativeBatch: {
        provider: 'Math Anchor',
        items: 8,
        status: nativeBatch.result.status,
        latencyMs: nativeBatch.elapsedMs,
        resultBytes: nativeBatch.resultBytes,
      },
    },
    load: {
      mixedBurstCalls: 24,
      failed: burst.result.summary.failed,
      latencyMs: burst.elapsedMs,
      resultBytes: burst.resultBytes,
      admissionAfter: runtime.admissionSnapshot(),
      soak: { first: soakOne, second: soakTwo },
    },
    cancellationRecovery: {
      cancelledCode: cancelled.calls[0].error.code,
      recoveryStatus: cancelRecovery.calls[0].status,
      coldStartupDeadline: startupDeadline,
    },
    providerReplacement: {
      provider: 'Migratory Time',
      recoveryStatus: replacementRecovery.calls[0].status,
      replacementSession: replacementRecovery.calls[0].session,
    },
    resourceObservation: {
      afterStartup: resourcesBefore,
      warmed: resourcesWarm,
      afterSoakOne: resourcesAfterSoakOne,
      afterSoakTwo: resourcesAfterSoakTwo,
      startupToWarmDeltaRssKiB: resourcesWarm.rssKiB - resourcesBefore.rssKiB,
      warmToSoakOneDeltaRssKiB: resourcesAfterSoakOne.rssKiB - resourcesWarm.rssKiB,
      soakOneToSoakTwoDeltaRssKiB: resourcesAfterSoakTwo.rssKiB - resourcesAfterSoakOne.rssKiB,
      note: 'Current process-tree RSS snapshots; two bounded soaks cannot establish leak freedom and no production threshold is declared.',
    },
  }
} finally {
  const cleanupStarted = performance.now()
  await runtime.close()
  if (report !== undefined) {
    const afterClose = await processTreeRss([...observedRootPids])
    report.resourceObservation.afterClose = afterClose
    report.resourceObservation.cleanupLatencyMs = performance.now() - cleanupStarted
    if (afterClose.processes !== 0 || afterClose.rssKiB !== 0) {
      throw new Error('provider process tree remained after runtime.close()')
    }
  }
}

const verifyDirectory = resolve(root, '.verify')
await mkdir(verifyDirectory, { recursive: true })
await writeFile(resolve(verifyDirectory, 'real-providers.latest.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  providers: report.scope.providers.length,
  semantic: report.semantic.status,
  burstFailed: report.load.failed,
  cancellationRecovery: report.cancellationRecovery,
  providerReplacement: report.providerReplacement,
  report: '.verify/real-providers.latest.json',
})}\n`)
