import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { digestFile, digestJson, jsonBytes, parseStrictJson } from '../src/json.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(root, '..')
const procedureRoot = resolve(workspace, 'structured-data-preflight')
const dataProviderRoot = resolve(workspace, 'data-transformer')
const dataProviderManifestPath = resolve(dataProviderRoot, 'capabilities/provider.json')
const procedureProfilePath = resolve(
  workspace,
  'procedure-contracts/catalog/procedures/structured-data-preflight.v0.3.json',
)
const sourceManifestPath = resolve(procedureRoot, 'procedure/implementation-manifest.json')
const sourceSchemaRoot = resolve(procedureRoot, 'src/structured_data_preflight/schemas')
const procedurePython = resolve(procedureRoot, '.venv/bin/python')
const dataProviderPython = resolve(dataProviderRoot, '.venv/bin/python')

export const verifyDirectory = resolve(root, '.verify')

const limits = {
  maxConcurrentCalls: 4,
  maxQueuedCalls: 16,
  maxWorkOrderCalls: 32,
  maxWorkOrderBytes: 1024 * 1024,
  maxProviderResponseBytes: 512 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  maxProtocolLineBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  defaultTimeoutMs: 30_000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 250,
}

export function quantiles(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
  return { samples: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}

async function findOnly(directory, expression, label) {
  const matches = (await readdir(directory))
    .filter((name) => expression.test(name))
    .map((name) => resolve(directory, name))
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`)
  return matches[0]
}

async function fileProviderRoot() {
  for (const name of ['file-vitals', 'universal-inspector']) {
    try {
      return await realpath(resolve(workspace, name))
    } catch {
      // Continue to the compatibility checkout name.
    }
  }
  throw new Error('File Vitals source checkout is unavailable')
}

async function sourceSnapshot(repositoryRoot) {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: repositoryRoot }),
  ])
  const dirty = []
  for (const line of status.split('\n').filter(Boolean)) {
    const state = line.slice(0, 2)
    const displayedPath = line.slice(3)
    const path = displayedPath.includes(' -> ') ? displayedPath.split(' -> ').at(-1) : displayedPath
    const contentDigest = await digestFile(resolve(repositoryRoot, path)).catch(() => null)
    if (!state.includes('D')) {
      assert.notEqual(contentDigest, null, `dirty source path is unavailable for hashing: ${path}`)
    }
    dirty.push({
      state,
      path,
      contentDigest,
    })
  }
  return { revision: revision.trim(), dirty }
}

async function writePythonEntrypoint(path, python, module) {
  await writeFile(path, [
    `#!${python}`,
    'import sys',
    'from pathlib import Path',
    'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site"))',
    `from ${module} import main`,
    "if __name__ == '__main__':",
    '    raise SystemExit(main())',
    '',
  ].join('\n'))
  await chmod(path, 0o755)
}

function requireCapabilityImplementation(manifest, expected) {
  assert.equal(manifest.provider?.id, expected.providerId)
  assert.equal(manifest.provider?.version, expected.providerVersion)
  const implementation = manifest.implementations?.find(
    (candidate) =>
      candidate.capabilityId === expected.capabilityId &&
      candidate.capabilityVersion === expected.capabilityVersion,
  )
  assert.ok(implementation, `Capability implementation is absent: ${expected.capabilityId}`)
  assert.equal(implementation.adapter?.protocol, 'openadam.capability-jsonl.v0.1')
  assert.deepEqual(
    implementation.adapterBindings.map((binding) => binding.operationId).sort(),
    [...expected.operationIds].sort(),
  )
  return implementation
}

export function providerConfig(bindingRoot, identityFiles, overrides = {}) {
  return {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    limits: { ...limits, ...(overrides.limits ?? {}) },
    providers: [{
      providerId: 'org.openadam.structured-data-preflight',
      transport: 'procedure-jsonl-v0.2',
      lifecycle: overrides.lifecycle ?? 'persistent',
      rootPath: bindingRoot,
      profilePath: procedureProfilePath,
      implementationManifestPath: resolve(bindingRoot, 'procedure/implementation-manifest.json'),
      identityFiles,
      procedureId: 'org.openadam.structured-data.preflight',
      procedureVersion: '0.3.0',
      inputSchemaPath: resolve(bindingRoot, 'schemas/structured-data.preflight.input.schema.json'),
      outputSchemaPath: resolve(bindingRoot, 'schemas/structured-data.preflight.output.schema.json'),
    }],
  }
}

export function procedureCall(id, input, timeoutMs) {
  const call = {
    id,
    providerId: 'org.openadam.structured-data-preflight',
    target: {
      kind: 'procedure',
      procedureId: 'org.openadam.structured-data.preflight',
      procedureVersion: '0.3.0',
    },
    input,
  }
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return call
}

export function workOrder(id, calls) {
  return { schemaVersion: 'openadam.direct-work-order.v0.1', id, calls }
}

export function readyInput(validation) {
  const input = { path: 'fixtures/users.json', sample_rows: 1, select: 'data.users[*]' }
  if (validation !== undefined) input.validation = validation
  return input
}

export async function timedRun(runtime, order) {
  const started = performance.now()
  const result = await runtime.runWorkOrder(order)
  return { elapsedMs: performance.now() - started, result, resultBytes: jsonBytes(result) }
}

export async function processGroupMembers(processGroupId) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid='])
  return stdout.trim().split('\n').flatMap((line) => {
    const [pid, group] = line.trim().split(/\s+/u).map(Number)
    return group === processGroupId ? [pid] : []
  })
}

export async function buildPackagedBinding(temporaryRoot) {
  const bindingRoot = resolve(temporaryRoot, 'binding')
  const artifacts = resolve(bindingRoot, 'artifacts')
  const commands = resolve(bindingRoot, 'bin')
  const site = resolve(bindingRoot, 'site')
  await Promise.all([
    ...['artifacts', 'bin', 'site', 'fixtures', 'procedure', 'schemas']
      .map((name) => mkdir(resolve(bindingRoot, name), { recursive: true })),
  ])

  const buildStarted = performance.now()
  const fileRoot = await fileProviderRoot()
  const snapshotBefore = {
    procedureImplementation: await sourceSnapshot(procedureRoot),
    structuredDataProvider: await sourceSnapshot(dataProviderRoot),
    fileProvider: await sourceSnapshot(fileRoot),
    procedureProfile: await sourceSnapshot(resolve(workspace, 'procedure-contracts')),
  }
  for (const providerRoot of [procedureRoot, dataProviderRoot]) {
    await execFileAsync('uv', [
      'build', '--offline', '--wheel', '--no-create-gitignore', '--out-dir', artifacts, providerRoot,
    ], { maxBuffer: 4 * 1024 * 1024 })
  }
  const fileProviderManifestPath = resolve(fileRoot, 'capabilities/provider.json')
  const [fileManifestText, dataManifestText] = await Promise.all([
    readFile(fileProviderManifestPath, 'utf8'),
    readFile(dataProviderManifestPath, 'utf8'),
  ])
  const fileManifest = parseStrictJson(fileManifestText, 'File Vitals Provider Manifest')
  const dataManifest = parseStrictJson(dataManifestText, 'BatchTicket Provider Manifest')
  const fileImplementation = requireCapabilityImplementation(fileManifest, {
    providerId: 'io.github.tetracoralla.file-vitals',
    providerVersion: '0.3.2',
    capabilityId: 'org.openadam.file.inspect',
    capabilityVersion: '0.1.0',
    operationIds: ['inspect'],
  })
  const dataImplementation = requireCapabilityImplementation(dataManifest, {
    providerId: 'io.github.tetracoralla.batchticket',
    providerVersion: '0.2.0',
    capabilityId: 'org.openadam.structured-data.analyze',
    capabilityVersion: '0.1.0',
    operationIds: ['inspect', 'validate'],
  })
  const fileBinary = resolve(commands, 'file-vitals-capability')
  await execFileAsync('go', ['build', '-o', fileBinary, './cmd/capability-adapter'], {
    cwd: fileRoot,
    maxBuffer: 4 * 1024 * 1024,
  })

  const procedureWheel = await findOnly(
    artifacts, /^structured_data_preflight-0\.1\.0-.*\.whl$/u, 'Structured Data Preflight wheel',
  )
  const dataWheel = await findOnly(
    artifacts, /^agent_data_transformer-0\.2\.0-.*\.whl$/u, 'BatchTicket wheel',
  )
  await execFileAsync('uv', [
    'pip', 'install', '--offline', '--target', site, '--no-deps', procedureWheel, dataWheel,
  ], { maxBuffer: 4 * 1024 * 1024 })
  await Promise.all([
    writePythonEntrypoint(resolve(commands, 'sdp-procedure'), procedurePython, 'structured_data_preflight.adapter'),
    writePythonEntrypoint(resolve(commands, 'adt-capability'), dataProviderPython, 'data_transformer.capability_adapter'),
    copyFile(resolve(procedureRoot, 'fixtures/users.json'), resolve(bindingRoot, 'fixtures/users.json')),
    copyFile(resolve(procedureRoot, 'fixtures/invalid.json'), resolve(bindingRoot, 'fixtures/invalid.json')),
    copyFile(
      resolve(sourceSchemaRoot, 'structured-data.preflight.input.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.input.schema.json'),
    ),
    copyFile(
      resolve(sourceSchemaRoot, 'structured-data.preflight.output.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.output.schema.json'),
    ),
    copyFile(fileProviderManifestPath, resolve(artifacts, 'file-vitals.provider.json')),
    copyFile(dataProviderManifestPath, resolve(artifacts, 'batchticket.provider.json')),
  ])

  const manifest = parseStrictJson(
    await readFile(sourceManifestPath, 'utf8'),
    'Structured Data Preflight implementation manifest',
  )
  const implementation = manifest.implementations.find(
    (candidate) =>
      candidate.procedureId === 'org.openadam.structured-data.preflight' &&
      candidate.procedureVersion === '0.3.0',
  )
  assert.ok(implementation, 'current Procedure implementation is absent')
  const capabilityProviders = new Map([
    [fileManifest.provider.id, { manifest: fileManifest, implementation: fileImplementation }],
    [dataManifest.provider.id, { manifest: dataManifest, implementation: dataImplementation }],
  ])
  for (const stage of implementation.stages) {
    const provider = capabilityProviders.get(stage.provider.id)
    assert.ok(provider, `Procedure stage provider is not the rebuilt provider: ${stage.stageId}`)
    assert.equal(stage.provider.version, provider.manifest.provider.version)
    assert.equal(stage.capabilityId, provider.implementation.capabilityId)
    assert.equal(stage.capabilityVersion, provider.implementation.capabilityVersion)
    assert.equal(stage.transport, 'capability-jsonl')
    const adapterBinding = provider.implementation.adapterBindings.find(
      (binding) => binding.operationId === stage.operationId,
    )
    assert.ok(adapterBinding, `Procedure stage operation is absent from its provider: ${stage.stageId}`)
    assert.equal(stage.target, adapterBinding.target)
  }
  implementation.adapter = {
    protocol: 'openadam.procedure-jsonl.v0.2',
    command: './bin/sdp-procedure',
    args: [],
  }
  await writeFile(
    resolve(bindingRoot, 'procedure/implementation-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  const identityFiles = [
    resolve(commands, 'sdp-procedure'),
    resolve(commands, 'adt-capability'),
    fileBinary,
    procedureWheel,
    dataWheel,
    resolve(artifacts, 'file-vitals.provider.json'),
    resolve(artifacts, 'batchticket.provider.json'),
  ]
  const snapshotAfter = {
    procedureImplementation: await sourceSnapshot(procedureRoot),
    structuredDataProvider: await sourceSnapshot(dataProviderRoot),
    fileProvider: await sourceSnapshot(fileRoot),
    procedureProfile: await sourceSnapshot(resolve(workspace, 'procedure-contracts')),
  }
  assert.deepEqual(snapshotAfter, snapshotBefore, 'Provider source changed while artifacts were being rebuilt')
  return {
    bindingRoot: await realpath(bindingRoot),
    commands,
    identityFiles,
    stageBindings: implementation.stages.map((stage) => ({
      stageId: stage.stageId,
      capabilityId: stage.capabilityId,
      capabilityVersion: stage.capabilityVersion,
      operationId: stage.operationId,
      providerId: stage.provider.id,
      providerVersion: stage.provider.version,
      transport: stage.transport,
      target: stage.target,
    })),
    packageArtifacts: {
      procedureWheel: basename(procedureWheel),
      dataProviderWheel: basename(dataWheel),
      fileProviderBinary: basename(fileBinary),
      providerManifestDigests: {
        fileVitals: digestJson(fileManifest),
        batchTicket: digestJson(dataManifest),
      },
      sourceSnapshot: snapshotBefore,
      buildMs: performance.now() - buildStarted,
      dependencyRuntime: 'The Python entry points import provider code from rebuilt wheels while using each sibling checkout virtual environment for third-party dependencies.',
      note: 'Wheels and the native Capability adapter were rebuilt from the recorded current sibling source into a temporary binding root; dirty paths and content digests record identity without attributing ownership.',
    },
  }
}
