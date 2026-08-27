#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(resolve(tmpdir(), 'direct-execution-package-'))

function waitForJsonLine(child, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => finish(reject, new Error(`packaged service readiness timed out: ${stderr}`)), timeoutMs)
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
    const onExit = (code, signal) => finish(reject, new Error(`packaged service exited before readiness: ${code ?? signal}: ${stderr}`))
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
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function packagedProviderConfig(fakeRoot) {
  return {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    limits: {
      maxConcurrentCalls: 2,
      maxQueuedCalls: 4,
      maxWorkOrderCalls: 16,
      maxWorkOrderBytes: 262144,
      maxProviderResponseBytes: 65536,
      maxResultBytes: 262144,
      maxProtocolLineBytes: 1048576,
      maxStderrBytes: 4096,
      defaultTimeoutMs: 1000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 50,
    },
    providers: [{
      providerId: 'test.fake-capability',
      transport: 'capability-jsonl-v0.1',
      lifecycle: 'persistent',
      rootPath: fakeRoot,
      profilePath: resolve(fakeRoot, 'capability-profile.json'),
      manifestPath: resolve(fakeRoot, 'provider.json'),
      identityFiles: [resolve(fakeRoot, 'adapter.mjs')],
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      contracts: [{
        operationId: 'echo',
        inputSchemaPath: resolve(fakeRoot, 'echo.input.schema.json'),
        outputSchemaPath: resolve(fakeRoot, 'echo.output.schema.json'),
      }],
    }],
  }
}

function packagedWorkOrder(id) {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id,
    calls: [{
      id: 'echo',
      providerId: 'test.fake-capability',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        operationId: 'echo',
      },
      input: { value: 'packaged-host', delayMs: 0 },
    }],
  }
}

try {
  const packed = await execFileAsync('npm', ['pack', '--json', '--pack-destination', directory], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  })
  const metadata = JSON.parse(packed.stdout)[0]
  const paths = metadata.files.map((file) => file.path)
  for (const forbidden of ['AGENTS.md', 'test/', 'scripts/', '.verify/', 'node_modules/']) {
    if (paths.some((path) => path === forbidden || path.startsWith(forbidden))) {
      throw new Error(`private development surface entered package: ${forbidden}`)
    }
  }
  const cli = metadata.files.find((file) => file.path === 'src/cli.mjs')
  if (cli === undefined || (cli.mode & 0o111) === 0) throw new Error('packaged CLI is absent or not executable')
  const evalsDriver = metadata.files.find((file) => file.path === 'src/evals-driver.mjs')
  if (evalsDriver === undefined || (evalsDriver.mode & 0o111) === 0) {
    throw new Error('packaged evaluator driver is absent or not executable')
  }
  for (const required of [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'SECURITY.md',
    'src/index.mjs',
    'src/host-client.mjs',
    'src/host-protocol.mjs',
    'src/host-service.mjs',
    'schemas/host-request.schema.json',
    'schemas/host-response.schema.json',
    'schemas/host-service-observation.schema.json',
    'schemas/contract-selection.schema.json',
    'schemas/execution-observation.schema.json',
    'schemas/evals-direct-driver-request.schema.json',
    'schemas/evals-direct-driver-result.schema.json',
    'schemas/provider-config.schema.json',
    'schemas/work-order.schema.json',
    'schemas/capability-profile.schema.v0.3.json',
    'schemas/capability-jsonl-envelope.schema.v0.1.json',
    'schemas/provider-manifest.schema.v0.3.json',
    'schemas/procedure-profile.schema.v0.5.json',
    'schemas/procedure-implementation-manifest.schema.v0.5.json',
  ]) {
    if (!paths.includes(required)) throw new Error(`required package file is absent: ${required}`)
  }

  const consumer = resolve(directory, 'consumer')
  const tarball = resolve(directory, metadata.filename)
  await execFileAsync('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', consumer, tarball,
  ], { cwd: directory, maxBuffer: 4 * 1024 * 1024 })
  await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    "import('@openadam/direct-execution-runtime').then((module) => { if (typeof module.DirectExecutionRuntime !== 'function' || typeof module.DirectHostService !== 'function' || typeof module.requestDirectHost !== 'function' || typeof module.JsonlObservationSink !== 'function' || module.EVALS_DRIVER_VERSION !== '0.1.0') process.exit(2) })",
  ], { cwd: consumer, maxBuffer: 1024 * 1024 })

  const fakeRoot = resolve(root, 'test/fixtures/fake-capability')
  const configPath = resolve(directory, 'provider-config.json')
  const firstOrderPath = resolve(directory, 'work-order-first.json')
  const secondOrderPath = resolve(directory, 'work-order-second.json')
  const socketPath = resolve(directory, 'runtime.sock')
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(packagedProviderConfig(fakeRoot))}\n`),
    writeFile(firstOrderPath, `${JSON.stringify(packagedWorkOrder('packaged-first'))}\n`),
    writeFile(secondOrderPath, `${JSON.stringify(packagedWorkOrder('packaged-second'))}\n`),
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
  let ready
  let first
  let second
  try {
    ready = await waitForJsonLine(service)
    const firstRun = await execFileAsync(process.execPath, [installedCli, 'run', '--socket', socketPath, '--work-order', firstOrderPath])
    const secondRun = await execFileAsync(process.execPath, [installedCli, 'run', '--socket', socketPath, '--work-order', secondOrderPath])
    first = JSON.parse(firstRun.stdout)
    second = JSON.parse(secondRun.stdout)
    if (first.calls?.[0]?.result?.value !== 'packaged-host' || first.calls[0].session !== 'cold') {
      throw new Error('first packaged host call did not execute against a cold provider session')
    }
    if (second.calls?.[0]?.result?.value !== 'packaged-host' || second.calls[0].session !== 'warm') {
      throw new Error('second packaged host call did not reuse the provider session')
    }
  } finally {
    if (service.exitCode === null && service.signalCode === null) service.kill('SIGTERM')
    const exited = await serviceExit
    if (exited.error !== undefined) throw exited.error
    if (exited.code !== 0) throw new Error(`packaged service did not stop cleanly: ${exited.code ?? exited.signal}`)
  }
  const socketAfterClose = await lstat(socketPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (socketAfterClose !== undefined) throw new Error('packaged service socket remained after shutdown')

  process.stdout.write(JSON.stringify({
    package: metadata.id,
    files: metadata.entryCount,
    packedBytes: metadata.size,
    unpackedBytes: metadata.unpackedSize,
    installedImport: 'ok',
    installedHostService: {
      ready: ready.status,
      firstSession: first.calls[0].session,
      secondSession: second.calls[0].session,
      cleanShutdown: true,
    },
  }) + '\n')
} finally {
  await rm(directory, { recursive: true, force: true })
}
