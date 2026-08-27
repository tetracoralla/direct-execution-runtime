import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  capabilityProfileDigest,
  prepareRuntimeConfig,
  procedureProfileDigest,
} from '../src/config.mjs'
import { parseStrictJson } from '../src/json.mjs'
import { fakeConfig, fakeLookupProjectedMcpConfig, fakeMcpConfig, fakeProcedureConfig, fakeProjectedMcpConfig, fakeRoot } from './helpers.mjs'

test('strict JSON rejects duplicate object keys before ordinary JSON parsing', () => {
  assert.throws(
    () => parseStrictJson('{"schemaVersion":"a","schemaVersion":"b"}', 'duplicate fixture'),
    (error) => error.code === 'HOST_INVALID_JSON' && /duplicate object key/.test(error.message),
  )
})

test('strict JSON rejects unsafe integer literals before IEEE-754 parsing can collapse them', () => {
  assert.throws(
    () => parseStrictJson('{"value":9007199254740993}', 'unsafe integer fixture'),
    (error) => error.code === 'HOST_INVALID_JSON' && /safe range/.test(error.message),
  )
  assert.throws(
    () => parseStrictJson('{"value":9007199254740993e0}', 'unsafe scientific integer fixture'),
    (error) => error.code === 'HOST_INVALID_JSON' && /loses IEEE-754 precision/.test(error.message),
  )
})

test('current Profile semantics, manifest binding, annotations, and schema digests prepare one binding', async () => {
  const prepared = await prepareRuntimeConfig(fakeConfig())
  const binding = prepared.providers.get('test.fake-capability')
  assert.equal(binding.capabilityId, 'org.openadam.test.echo')
  assert.equal(binding.operations.size, 1)
  assert.match(binding.bindingDigest, /^sha256:[a-f0-9]{64}$/)
})

test('legacy Provider Manifests are rejected because they do not bind Profile semantics', async () => {
  await assert.rejects(() => prepareRuntimeConfig(fakeConfig({
    manifestPath: new URL('./fixtures/fake-capability/provider-v0.2.json', import.meta.url).pathname,
  })), (error) => error.code === 'HOST_BINDING_INVALID')
})

test('Capability semantic drift is rejected even when operation schemas are unchanged', async () => {
  await assert.rejects(() => prepareRuntimeConfig(fakeConfig({
    profilePath: new URL('./fixtures/fake-capability/capability-profile-semantic-drift.json', import.meta.url).pathname,
  })), (error) => error.code === 'HOST_SCHEMA_DRIFT' && /Profile semantics/.test(error.message))
})

test('Capability manifests must bind the complete Profile operation set', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-capability-set-'))
  const root = resolve(parent, 'fixture')
  try {
    await cp(fakeRoot, root, { recursive: true })
    const profilePath = resolve(root, 'capability-profile.json')
    const manifestPath = resolve(root, 'provider.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    profile.operations.push({
      ...structuredClone(profile.operations[0]),
      id: 'echo-second',
      title: 'Echo a second value',
    })
    manifest.implementations[0].profileDigest = await capabilityProfileDigest(
      profile,
      await realpath(profilePath),
    )
    await Promise.all([
      writeFile(profilePath, `${JSON.stringify(profile)}\n`),
      writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ])
    await assert.rejects(
      () => prepareRuntimeConfig(fakeConfig({ rootPath: root })),
      (error) => error.code === 'HOST_BINDING_INVALID'
        && /does not exactly match the Capability Profile/.test(error.message),
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('Procedure Profile, implementation stages, adapter entry, and schemas prepare one binding', async () => {
  const prepared = await prepareRuntimeConfig(fakeProcedureConfig())
  const binding = prepared.providers.get('test.fake-procedure')
  assert.equal(binding.procedureId, 'org.openadam.test.echo-procedure')
  assert.equal(binding.transport, 'procedure-jsonl-v0.2')
  assert.match(binding.profileDigest, /^sha256:[a-f0-9]{64}$/)
  assert.match(binding.contractDigest, /^sha256:[a-f0-9]{64}$/)
})

test('Procedure direct execution rejects open-world or unspecified semantics', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-procedure-open-world-'))
  const root = resolve(parent, 'fixture')
  try {
    await cp(fakeRoot, root, { recursive: true })
    const profilePath = resolve(root, 'procedure-profile.json')
    const manifestPath = resolve(root, 'procedure-manifest.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    profile.semantics.openWorld = true
    manifest.implementations[0].profileDigest = await procedureProfileDigest(
      profile,
      await realpath(profilePath),
    )
    await Promise.all([
      writeFile(profilePath, `${JSON.stringify(profile)}\n`),
      writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ])
    await assert.rejects(
      () => prepareRuntimeConfig(fakeProcedureConfig({ rootPath: root })),
      (error) => error.code === 'HOST_BINDING_UNSAFE'
        && /closed-world boundary/.test(error.message),
    )

    delete profile.semantics.openWorld
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`)
    await assert.rejects(
      () => prepareRuntimeConfig(fakeProcedureConfig({ rootPath: root })),
      (error) => error.code === 'HOST_BINDING_INVALID',
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('Procedure stage drift is rejected before its adapter starts', async () => {
  const config = fakeProcedureConfig()
  config.providers[0].procedureVersion = '0.2.0'
  await assert.rejects(
    () => prepareRuntimeConfig(config),
    (error) => error.code === 'HOST_BINDING_INVALID',
  )
})

test('a required Procedure stage cannot depend on a conditional stage', async () => {
  const parent = await mkdtemp(resolve(tmpdir(), 'direct-runtime-procedure-graph-'))
  const root = resolve(parent, 'fixture')
  try {
    await cp(fakeRoot, root, { recursive: true })
    const profilePath = resolve(root, 'procedure-profile.json')
    const manifestPath = resolve(root, 'procedure-manifest.json')
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    profile.stages.unshift({
      kind: 'capability',
      id: 'optional',
      title: 'Optional echo',
      purpose: 'Run only when optional input is present.',
      required: false,
      condition: { inputPresent: '/optional' },
      dependsOn: [],
      capability: {
        id: 'org.openadam.test.echo',
        version: '0.1.0',
        operationId: 'echo',
      },
    })
    profile.stages[1].dependsOn = ['optional']
    manifest.implementations[0].stages.unshift({
      ...structuredClone(manifest.implementations[0].stages[0]),
      stageId: 'optional',
    })
    manifest.implementations[0].profileDigest = await procedureProfileDigest(
      profile,
      await realpath(profilePath),
    )
    await Promise.all([
      writeFile(profilePath, `${JSON.stringify(profile)}\n`),
      writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
    ])
    await assert.rejects(
      () => prepareRuntimeConfig(fakeProcedureConfig({ rootPath: root })),
      (error) => error.code === 'HOST_BINDING_INVALID'
        && /depends on optional stage optional/.test(error.message),
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('MCP execution identity binds command arguments and declared provider files', async () => {
  const ordinary = await prepareRuntimeConfig(fakeMcpConfig())
  const delayed = await prepareRuntimeConfig(fakeMcpConfig({ args: ['--startup-delay=20'] }))
  const ordinaryBinding = ordinary.providers.get('test.fake-mcp')
  const delayedBinding = delayed.providers.get('test.fake-mcp')
  assert.notEqual(ordinaryBinding.bindingDigest, delayedBinding.bindingDigest)
  assert.match(ordinaryBinding.identityDigests[0].digest, /^sha256:[a-f0-9]{64}$/)
})

test('MCP operation projection and native batch declarations are explicit binding identity', async () => {
  const ordinary = await prepareRuntimeConfig(fakeMcpConfig())
  const projected = await prepareRuntimeConfig(fakeProjectedMcpConfig())
  const binding = projected.providers.get('test.fake-mcp')
  assert.equal(binding.projectionDefinitions.get('dispatch').operationField, 'operation')
  assert.equal(binding.batchProjectionDefinitions.get('dispatch.batch').toolName, 'dispatch')
  assert.notEqual(
    ordinary.providers.get('test.fake-mcp').bindingDigest,
    binding.bindingDigest,
  )

  const invalid = fakeProjectedMcpConfig()
  invalid.providers[0].operationProjections[0].batchToolName = 'missing.batch'
  await assert.rejects(
    () => prepareRuntimeConfig(invalid),
    (error) => error.code === 'HOST_CONFIG_INVALID' && /distinct allowed tool/.test(error.message),
  )
})

test('MCP operation schema lookup is explicit binding identity and must name an allowed tool', async () => {
  const prepared = await prepareRuntimeConfig(fakeLookupProjectedMcpConfig())
  const binding = prepared.providers.get('test.fake-mcp')
  assert.equal(binding.projectionDefinitions.get('dispatch.compact').schemaLookup.toolName, 'dispatch.describe')

  const invalid = fakeLookupProjectedMcpConfig()
  invalid.providers[0].operationProjections[0].schemaLookup.toolName = 'missing.describe'
  await assert.rejects(
    () => prepareRuntimeConfig(invalid),
    (error) => error.code === 'HOST_CONFIG_INVALID' && /schema lookup tool/.test(error.message),
  )
})

test('MCP configuration cannot omit provider-owned execution identity files', async () => {
  const config = fakeMcpConfig()
  delete config.providers[0].identityFiles
  await assert.rejects(
    () => prepareRuntimeConfig(config),
    (error) => error.code === 'HOST_CONFIG_INVALID',
  )
})

test('Capability and Procedure configurations cannot omit provider-owned execution identity files', async () => {
  for (const config of [fakeConfig(), fakeProcedureConfig()]) {
    delete config.providers[0].identityFiles
    await assert.rejects(
      () => prepareRuntimeConfig(config),
      (error) => error.code === 'HOST_CONFIG_INVALID',
    )
  }
})

test('schema drift is rejected before the adapter starts', async () => {
  const config = fakeConfig()
  config.providers[0].contracts[0].outputSchemaPath = config.providers[0].contracts[0].inputSchemaPath
  await assert.rejects(
    () => prepareRuntimeConfig(config),
    (error) => error.code === 'HOST_SCHEMA_DRIFT' && /Output schema/.test(error.message),
  )
})

test('unknown configuration fields are rejected', async () => {
  const config = fakeConfig()
  config.futureMarketplace = true
  await assert.rejects(
    () => prepareRuntimeConfig(config),
    (error) => error.code === 'HOST_CONFIG_INVALID',
  )
})
