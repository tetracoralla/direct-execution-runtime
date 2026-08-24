import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { parseStrictJson } from '../src/json.mjs'
import { fakeConfig, fakeMcpConfig, fakeProcedureConfig, fakeRoot } from './helpers.mjs'

test('strict JSON rejects duplicate object keys before ordinary JSON parsing', () => {
  assert.throws(
    () => parseStrictJson('{"schemaVersion":"a","schemaVersion":"b"}', 'duplicate fixture'),
    (error) => error.code === 'HOST_INVALID_JSON' && /duplicate object key/.test(error.message),
  )
})

test('current manifest, safe annotations, and schema digests prepare one binding', async () => {
  const prepared = await prepareRuntimeConfig(fakeConfig())
  const binding = prepared.providers.get('test.fake-capability')
  assert.equal(binding.capabilityId, 'org.openadam.test.echo')
  assert.equal(binding.operations.size, 1)
  assert.match(binding.bindingDigest, /^sha256:[a-f0-9]{64}$/)
})

test('current Provider Manifest v0.2 adapter bindings prepare one binding', async () => {
  const prepared = await prepareRuntimeConfig(fakeConfig({
    manifestPath: new URL('./fixtures/fake-capability/provider-v0.2.json', import.meta.url).pathname,
  }))
  const binding = prepared.providers.get('test.fake-capability')
  assert.equal(binding.capabilityId, 'org.openadam.test.echo')
  assert.equal(binding.operations.size, 1)
  assert.equal(binding.adapterCommand, `${fakeRoot}/adapter.mjs`)
})

test('Procedure Profile, implementation stages, adapter entry, and schemas prepare one binding', async () => {
  const prepared = await prepareRuntimeConfig(fakeProcedureConfig())
  const binding = prepared.providers.get('test.fake-procedure')
  assert.equal(binding.procedureId, 'org.openadam.test.echo-procedure')
  assert.equal(binding.transport, 'procedure-jsonl-v0.2')
  assert.match(binding.profileDigest, /^sha256:[a-f0-9]{64}$/)
  assert.match(binding.contractDigest, /^sha256:[a-f0-9]{64}$/)
})

test('Procedure stage drift is rejected before its adapter starts', async () => {
  const config = fakeProcedureConfig()
  config.providers[0].procedureVersion = '0.2.0'
  await assert.rejects(
    () => prepareRuntimeConfig(config),
    (error) => error.code === 'HOST_BINDING_INVALID',
  )
})

test('MCP execution identity binds command arguments and declared provider files', async () => {
  const ordinary = await prepareRuntimeConfig(fakeMcpConfig())
  const delayed = await prepareRuntimeConfig(fakeMcpConfig({ args: ['--startup-delay=20'] }))
  const ordinaryBinding = ordinary.providers.get('test.fake-mcp')
  const delayedBinding = delayed.providers.get('test.fake-mcp')
  assert.notEqual(ordinaryBinding.bindingDigest, delayedBinding.bindingDigest)
  assert.match(ordinaryBinding.identityDigests[0].digest, /^sha256:[a-f0-9]{64}$/)
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
