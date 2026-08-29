import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { createValidator, loadBundledSchema } from '../src/schema.mjs'
import {
  fakeDualCapabilityConfig,
  fakeMcpConfig,
  fakeProjectedMcpConfig,
  fakeProcedureConfig,
} from './helpers.mjs'

function requirement(target, constraints = {}) {
  return {
    schemaVersion: 'openadam.direct-resolution-request.v0.1',
    target,
    constraints: {
      effectAllowance: 'read-only',
      dataLocality: 'local-process',
      ...constraints,
    },
  }
}

const capabilityTarget = {
  kind: 'capability',
  capabilityId: 'org.openadam.test.echo',
  capabilityVersion: '0.1.0',
  operationId: 'echo',
}

async function withRuntime(config, task) {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  try {
    return await task(runtime)
  } finally {
    await runtime.close()
  }
}

async function publicResolutionResultValidator() {
  const ajv = createValidator()
  ajv.addSchema(await loadBundledSchema('resolution-request.schema.json'))
  return ajv.compile(await loadBundledSchema('resolution-result.schema.json'))
}

function assertPublicSchemaRejects(validate, value, label) {
  assert.equal(validate(value), false, `${label} unexpectedly satisfied the public resolution-result schema`)
}

test('resolver returns only exact semantic candidates without starting JSONL target processes', async () => {
  const config = fakeDualCapabilityConfig()
  config.providers.push(fakeProcedureConfig().providers[0])
  await withRuntime(config, async (runtime) => {
    const result = await runtime.resolveBindings(requirement(capabilityTarget))
    assert.equal(result.status, 'eligible_for_this_request')
    assert.deepEqual(result.summary, {
      configuredProviders: 3,
      configuredMatches: 2,
      exactCandidates: 2,
      eligible: 2,
      ineligible: 0,
      unknown: 0,
    })
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.provider.id),
      ['test.fake-capability', 'test.fake-capability-second'],
    )
    assert.equal(JSON.stringify(result).includes('test.fake-procedure'), false)
    assert.equal(JSON.stringify(result).includes('inputSchema'), false)
    assert.equal(result.candidates.every((candidate) => candidate.observation.targetOperationInvoked === false), true)
    assert.equal(result.candidates.every((candidate) => candidate.observation.executionAvailability === 'not_observed'), true)
    assert.equal(result.candidates.every((candidate) => candidate.checks.projectionEnvelopeMatch === 'not_applicable'), true)

    const snapshots = runtime.sessionSnapshot()
      .filter((snapshot) => snapshot.providerId.startsWith('test.fake-capability'))
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots.every((snapshot) => snapshot.present && snapshot.pid === null && snapshot.generation === 0), true)
  })
})

test('resolver applies exact contract and schema-budget constraints mechanically', async () => {
  await withRuntime(fakeDualCapabilityConfig(), async (runtime) => {
    const initial = await runtime.resolveBindings(requirement(capabilityTarget))
    const digest = initial.candidates[0].observation.contractDigest
    const allowed = await runtime.resolveBindings(requirement(capabilityTarget, {
      requiredContractDigest: digest,
      maxContractSchemaBytes: initial.candidates[0].observation.contractSchemaBytes,
    }))
    assert.equal(allowed.summary.eligible, 2)
    assert.equal(allowed.candidates.every((candidate) => candidate.checks.requiredContractDigest === 'satisfied'), true)

    const rejected = await runtime.resolveBindings(requirement(capabilityTarget, {
      requiredContractDigest: `sha256:${'0'.repeat(64)}`,
      maxContractSchemaBytes: 1,
    }))
    assert.equal(rejected.status, 'ineligible')
    assert.equal(rejected.summary.ineligible, 2)
    assert.deepEqual(rejected.candidates[0].reasonCodes, [
      'REQUIRED_CONTRACT_DIGEST_MISMATCH',
      'CONTRACT_SCHEMA_BYTES_EXCEEDED',
    ])
  })
})

test('live MCP contract digest can distinguish two providers without invoking the target tool', async () => {
  const config = fakeMcpConfig({ limits: { defaultTimeoutMs: 10000 } })
  config.providers.push(fakeMcpConfig({
    providerId: 'test.fake-mcp-narrow',
    args: ['--narrow-schema'],
    limits: { defaultTimeoutMs: 10000 },
  }).providers[0])
  const target = { kind: 'mcp-tool', toolName: 'echo' }
  await withRuntime(config, async (runtime) => {
    const initial = await runtime.resolveBindings(requirement(target))
    assert.equal(initial.summary.eligible, 2)
    assert.equal(initial.candidates.every((candidate) => candidate.checks.projectionEnvelopeMatch === 'not_applicable'), true)
    assert.notEqual(
      initial.candidates[0].observation.contractDigest,
      initial.candidates[1].observation.contractDigest,
    )

    const selectedDigest = initial.candidates[0].observation.contractDigest
    const constrained = await runtime.resolveBindings(requirement(target, {
      requiredContractDigest: selectedDigest,
    }))
    assert.equal(constrained.summary.eligible, 1)
    assert.equal(constrained.summary.ineligible, 1)
    assert.equal(constrained.candidates[0].status, 'eligible_for_this_request')
    assert.deepEqual(constrained.candidates[1].reasonCodes, ['REQUIRED_CONTRACT_DIGEST_MISMATCH'])

    const snapshots = runtime.sessionSnapshot().filter((snapshot) => snapshot.providerId.startsWith('test.fake-mcp'))
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots.every((snapshot) => snapshot.live?.lastResponseAt === null), true)
  })
})

test('current provider startup failure stays unknown and does not become an eligibility rejection', async () => {
  const config = fakeMcpConfig({
    args: ['--startup-fail'],
    limits: { defaultTimeoutMs: 10000 },
  })
  await withRuntime(config, async (runtime) => {
    const result = await runtime.resolveBindings(requirement({ kind: 'mcp-tool', toolName: 'echo' }))
    assert.equal(result.status, 'unknown')
    assert.equal(result.summary.unknown, 1)
    assert.equal(result.candidates[0].observation.projectionStatus, 'failed')
    assert.equal(result.candidates[0].checks.requiredContractDigest, 'not_requested')
    assert.equal(result.candidates[0].observation.targetOperationInvoked, false)
    assert.equal(result.candidates[0].observation.error.code, 'HOST_PROVIDER_UNAVAILABLE')
    assert.equal(result.candidates[0].observation.error.retryable, true)
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
  })
})

test('post-initialization MCP catalog connection loss is a retryable transport observation', async () => {
  const config = fakeMcpConfig({
    args: ['--list-tools-close'],
    limits: { defaultTimeoutMs: 10000 },
  })
  await withRuntime(config, async (runtime) => {
    const result = await runtime.resolveBindings(requirement({ kind: 'mcp-tool', toolName: 'echo' }))
    assert.equal(result.status, 'unknown')
    assert.equal(result.candidates[0].observation.error.code, 'HOST_TRANSPORT_ERROR')
    assert.equal(result.candidates[0].observation.error.retryable, true)
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
  })
})

test('unavailable projected MCP envelope does not establish or count exact operation identity', async () => {
  const config = fakeProjectedMcpConfig({
    args: ['--startup-fail'],
    limits: { defaultTimeoutMs: 10000 },
  })
  await withRuntime(config, async (runtime) => {
    const result = await runtime.resolveBindings(requirement({
      kind: 'mcp-operation',
      toolName: 'dispatch',
      operationId: 'text.absent',
    }))
    assert.equal(result.status, 'unknown')
    assert.deepEqual(result.summary, {
      configuredProviders: 1,
      configuredMatches: 1,
      exactCandidates: 0,
      eligible: 0,
      ineligible: 0,
      unknown: 1,
    })
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].checks.projectionEnvelopeMatch, 'satisfied')
    assert.equal(result.candidates[0].checks.semanticIdentity, 'not_observed')
    assert.equal(result.candidates[0].observation.error.code, 'HOST_PROVIDER_UNAVAILABLE')
    assert.equal(result.candidates[0].observation.error.retryable, true)
    assert.equal(result.candidates[0].observation.targetOperationInvoked, false)
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
  })
})

test('resolver snapshots caller input before returning a reusable exact selection', async () => {
  const config = fakeMcpConfig()
  config.providers[0].allowedTools = ['echo', 'dispatch']
  const callerRequirement = requirement({ kind: 'mcp-tool', toolName: 'echo' })
  await withRuntime(config, async (runtime) => {
    const result = await runtime.resolveBindings(callerRequirement)
    const resolvedDigest = result.candidates[0].observation.contractDigest

    callerRequirement.target.toolName = 'dispatch'
    callerRequirement.constraints.requiredContractDigest = `sha256:${'0'.repeat(64)}`

    assert.equal(result.request.target.toolName, 'echo')
    assert.equal(result.request.constraints.requiredContractDigest, undefined)
    assert.equal(result.candidates[0].target.toolName, 'echo')
    assert.equal(result.candidates[0].selection.target.toolName, 'echo')
    const projected = await runtime.projectContract(result.candidates[0].selection)
    assert.equal(projected.contract.contractDigest, resolvedDigest)
    assert.equal(runtime.sessionSnapshot()[0].live.lastResponseAt, null)
  })
})

test('caller cancellation terminates resolution instead of becoming provider eligibility', async () => {
  await withRuntime(fakeDualCapabilityConfig(), async (runtime) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => runtime.resolveBindings(requirement(capabilityTarget), { signal: controller.signal }),
      (error) => error.code === 'HOST_CANCELLED',
    )
    assert.equal(runtime.sessionSnapshot().every((snapshot) => snapshot.present === false), true)
  })

  const config = fakeMcpConfig({
    args: ['--startup-delay=200'],
    limits: { defaultTimeoutMs: 10000 },
  })
  await withRuntime(config, async (runtime) => {
    const controller = new AbortController()
    const pending = runtime.resolveBindings(
      requirement({ kind: 'mcp-tool', toolName: 'echo' }),
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error) => error.code === 'HOST_CANCELLED')
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
  })
})

test('a projected MCP operation absent from the live contract is not an exact candidate', async () => {
  await withRuntime(fakeProjectedMcpConfig(), async (runtime) => {
    const result = await runtime.resolveBindings(requirement({
      kind: 'mcp-operation',
      toolName: 'dispatch',
      operationId: 'text.absent',
    }))
    assert.equal(result.status, 'ineligible')
    assert.deepEqual(result.summary, {
      configuredProviders: 1,
      configuredMatches: 1,
      exactCandidates: 0,
      eligible: 0,
      ineligible: 0,
      unknown: 0,
    })
    assert.deepEqual(result.candidates, [])
    assert.deepEqual(result.reasonCodes, ['NO_EXACT_BINDING'])
    assert.equal(runtime.sessionSnapshot()[0].live.lastResponseAt, null)
  })
})

test('no exact binding and invalid outer input fail closed without listing unrelated providers', async () => {
  await withRuntime(fakeDualCapabilityConfig(), async (runtime) => {
    const missing = await runtime.resolveBindings(requirement({
      ...capabilityTarget,
      operationId: 'absent',
    }))
    assert.equal(missing.status, 'ineligible')
    assert.equal(missing.summary.configuredMatches, 0)
    assert.equal(missing.summary.exactCandidates, 0)
    assert.deepEqual(missing.candidates, [])
    assert.deepEqual(missing.reasonCodes, ['NO_EXACT_BINDING'])

    await assert.rejects(
      () => runtime.resolveBindings({
        schemaVersion: 'openadam.direct-resolution-request.v0.1',
        target: capabilityTarget,
        constraints: { effectAllowance: 'read-only', dataLocality: 'remote' },
      }),
      (error) => error.code === 'HOST_RESOLUTION_REQUEST_INVALID',
    )
  })
})

test('public resolution result schema rejects contradictory eligibility, projection, effect, contract, and error states', async () => {
  const validate = await publicResolutionResultValidator()
  let eligible
  let constrained
  let unavailable
  let missing

  await withRuntime(fakeDualCapabilityConfig(), async (runtime) => {
    eligible = await runtime.resolveBindings(requirement(capabilityTarget))
    constrained = await runtime.resolveBindings(requirement(capabilityTarget, {
      requiredContractDigest: eligible.candidates[0].observation.contractDigest,
    }))
    missing = await runtime.resolveBindings(requirement({ ...capabilityTarget, operationId: 'absent' }))
  })
  await withRuntime(fakeMcpConfig({ args: ['--startup-fail'] }), async (runtime) => {
    unavailable = await runtime.resolveBindings(requirement({ kind: 'mcp-tool', toolName: 'echo' }))
  })

  for (const current of [eligible, constrained, unavailable, missing]) {
    assert.equal(validate(current), true, JSON.stringify(validate.errors))
  }

  const eligibleWithoutEffect = structuredClone(eligible)
  eligibleWithoutEffect.candidates[0].checks.effectAllowance = 'not_observed'
  assertPublicSchemaRejects(validate, eligibleWithoutEffect, 'eligible candidate without an observed safe effect contract')

  const eligibleWithoutContract = structuredClone(eligible)
  eligibleWithoutContract.candidates[0].observation.contractDigest = null
  assertPublicSchemaRejects(validate, eligibleWithoutContract, 'eligible candidate without a contract digest')

  const observedWithError = structuredClone(eligible)
  observedWithError.candidates[0].observation.error = {
    code: 'HOST_TRANSPORT_ERROR',
    message: 'contradiction',
    retryable: true,
  }
  assertPublicSchemaRejects(validate, observedWithError, 'observed contract carrying a projection error')

  const eligibleWithReason = structuredClone(eligible)
  eligibleWithReason.candidates[0].reasonCodes = ['HOST_TRANSPORT_ERROR']
  assertPublicSchemaRejects(validate, eligibleWithReason, 'eligible candidate carrying a rejection reason')

  const wrongProjectionKind = structuredClone(eligible)
  wrongProjectionKind.candidates[0].checks.projectionEnvelopeMatch = 'satisfied'
  assertPublicSchemaRejects(validate, wrongProjectionKind, 'non-projected target claiming an envelope match')

  const failedWithoutError = structuredClone(unavailable)
  failedWithoutError.candidates[0].observation.error = null
  assertPublicSchemaRejects(validate, failedWithoutError, 'failed projection without a Host error')

  const failedWithEffect = structuredClone(unavailable)
  failedWithEffect.candidates[0].checks.effectAllowance = 'satisfied'
  assertPublicSchemaRejects(validate, failedWithEffect, 'failed projection claiming observed effect safety')

  const failedWithContract = structuredClone(unavailable)
  failedWithContract.candidates[0].observation.contractSource = 'live-session'
  assertPublicSchemaRejects(validate, failedWithContract, 'failed projection claiming a live contract source')

  const requestedContractNotChecked = structuredClone(constrained)
  requestedContractNotChecked.candidates[0].checks.requiredContractDigest = 'not_requested'
  assertPublicSchemaRejects(validate, requestedContractNotChecked, 'requested digest reported as not requested')

  const impossibleEligibleSummary = structuredClone(eligible)
  impossibleEligibleSummary.summary.eligible = 0
  assertPublicSchemaRejects(validate, impossibleEligibleSummary, 'eligible result with zero eligible summary')

  const emptyWithoutExactBindingReason = structuredClone(missing)
  emptyWithoutExactBindingReason.reasonCodes = []
  assertPublicSchemaRejects(validate, emptyWithoutExactBindingReason, 'empty result without NO_EXACT_BINDING')
})
