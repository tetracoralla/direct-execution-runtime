import { isDeepStrictEqual } from 'node:util'
import { HostError } from './errors.mjs'
import { snapshotJsonValue } from './json.mjs'
import { assertSchema, createValidator, loadBundledSchema } from './schema.mjs'

let validateSchema

const deterministicResolutionRejections = new Set([
  'HOST_BINDING_INVALID',
  'HOST_BINDING_MISMATCH',
  'HOST_BINDING_UNSAFE',
  'HOST_PROVIDER_OUTPUT_INVALID',
  'HOST_RESULT_TOO_LARGE',
  'HOST_SCHEMA_DRIFT',
  'HOST_UNKNOWN_OPERATION',
])

export function isDeterministicResolutionRejection(code) {
  return deterministicResolutionRejections.has(code)
}

async function schemaValidator() {
  if (validateSchema === undefined) {
    const ajv = createValidator()
    ajv.addSchema(await loadBundledSchema('resolution-request.schema.json'))
    validateSchema = ajv.compile(await loadBundledSchema('resolution-result.schema.json'))
  }
  return validateSchema
}

function fail(message) {
  throw new HostError('HOST_RESOLUTION_RESULT_INVALID', `resolution result: ${message}`)
}

function transportMatchesTarget(transport, target) {
  if (target.kind === 'capability') return transport === 'capability-jsonl-v0.1'
  if (target.kind === 'procedure') return transport === 'procedure-jsonl-v0.2'
  return transport === 'mcp-stdio'
}

function expectedConstraintStatus(requested, observed, satisfied) {
  if (!requested) return 'not_requested'
  if (!observed) return 'not_observed'
  return satisfied ? 'satisfied' : 'failed'
}

function assertSemantics(result) {
  if (result.resolvedAt !== result.freshness.observedAt) {
    fail('resolvedAt and freshness.observedAt must identify the same observation')
  }

  const providerIds = new Set()
  let eligible = 0
  let ineligible = 0
  let unknown = 0
  let exactCandidates = 0
  for (const candidate of result.candidates) {
    if (providerIds.has(candidate.provider.id)) fail('candidate provider identities must be unique')
    providerIds.add(candidate.provider.id)
    if (candidate.selection.providerId !== candidate.provider.id) {
      fail('candidate selection providerId must equal candidate provider id')
    }
    if (
      !isDeepStrictEqual(candidate.target, candidate.selection.target) ||
      !isDeepStrictEqual(candidate.target, result.request.target)
    ) {
      fail('candidate, selection, and request targets must be identical')
    }
    if (!transportMatchesTarget(candidate.provider.transport, candidate.target)) {
      fail('candidate provider transport must implement the selected target kind')
    }

    if (candidate.status === 'eligible_for_this_request') eligible += 1
    else if (candidate.status === 'ineligible') ineligible += 1
    else unknown += 1
    if (candidate.checks.semanticIdentity === 'satisfied') exactCandidates += 1

    const observed = candidate.observation.projectionStatus === 'observed'
    if (
      result.request.target.kind === 'mcp-operation' &&
      !observed &&
      candidate.observation.error.code === 'HOST_UNKNOWN_OPERATION'
    ) {
      fail('an unobserved projected operation cannot be reported as a candidate')
    }
    if (Date.parse(candidate.observation.observedAt) > Date.parse(result.resolvedAt)) {
      fail('candidate observations cannot occur after resolvedAt')
    }
    const expectedAvailability = observed
      ? candidate.provider.transport === 'mcp-stdio' ? 'contract_session_observed' : 'not_observed'
      : 'unknown'
    if (candidate.observation.executionAvailability !== expectedAvailability) {
      fail('execution availability must follow projection observation and provider transport')
    }
    const digestRequested = result.request.constraints.requiredContractDigest !== undefined
    const schemaBudgetRequested = result.request.constraints.maxContractSchemaBytes !== undefined
    const expectedDigestStatus = expectedConstraintStatus(
      digestRequested,
      observed,
      candidate.observation.contractDigest === result.request.constraints.requiredContractDigest,
    )
    const expectedSchemaBudgetStatus = expectedConstraintStatus(
      schemaBudgetRequested,
      observed,
      candidate.observation.contractSchemaBytes <= result.request.constraints.maxContractSchemaBytes,
    )
    if (candidate.checks.requiredContractDigest !== expectedDigestStatus) {
      fail('required-contract-digest check must match the request and observed contract')
    }
    if (candidate.checks.maxContractSchemaBytes !== expectedSchemaBudgetStatus) {
      fail('schema-budget check must match the request and observed contract')
    }

    if (observed) {
      const expectedReasonCodes = []
      if (expectedDigestStatus === 'failed') expectedReasonCodes.push('REQUIRED_CONTRACT_DIGEST_MISMATCH')
      if (expectedSchemaBudgetStatus === 'failed') expectedReasonCodes.push('CONTRACT_SCHEMA_BYTES_EXCEEDED')
      const expectedCandidateStatus = expectedReasonCodes.length === 0
        ? 'eligible_for_this_request'
        : 'ineligible'
      if (candidate.status !== expectedCandidateStatus || !isDeepStrictEqual(candidate.reasonCodes, expectedReasonCodes)) {
        fail('observed candidate status and reasonCodes must follow its exact constraint checks')
      }
    } else {
      const expectedCandidateStatus = isDeterministicResolutionRejection(candidate.observation.error.code)
        ? 'ineligible'
        : 'unknown'
      if (
        candidate.status !== expectedCandidateStatus ||
        !isDeepStrictEqual(candidate.reasonCodes, [candidate.observation.error.code])
      ) {
        fail('failed candidate status and reasonCodes must follow its projection error')
      }
    }

    if (candidate.status === 'eligible_for_this_request') {
      const checks = candidate.checks
      if (
        checks.semanticIdentity !== 'satisfied' ||
        !['satisfied', 'not_applicable'].includes(checks.projectionEnvelopeMatch) ||
        checks.effectAllowance !== 'satisfied' ||
        checks.dataLocality !== 'satisfied' ||
        !['satisfied', 'not_requested'].includes(checks.requiredContractDigest) ||
        !['satisfied', 'not_requested'].includes(checks.maxContractSchemaBytes) ||
        candidate.reasonCodes.length !== 0
      ) {
        fail('eligible candidate checks and reasonCodes are contradictory')
      }
    }
  }

  if (
    result.summary.eligible !== eligible ||
    result.summary.ineligible !== ineligible ||
    result.summary.unknown !== unknown ||
    result.summary.exactCandidates !== exactCandidates
  ) {
    fail('summary counts must equal the candidate population')
  }
  if (result.summary.configuredMatches < result.candidates.length) {
    fail('configuredMatches cannot be smaller than the candidate population')
  }
  if (
    result.request.target.kind !== 'mcp-operation' &&
    result.summary.configuredMatches !== result.candidates.length
  ) {
    fail('configuredMatches must equal the candidate population for exact configured targets')
  }
  if (result.summary.configuredProviders < result.summary.configuredMatches) {
    fail('configuredProviders cannot be smaller than configuredMatches')
  }
  const expectedStatus = eligible > 0
    ? 'eligible_for_this_request'
    : unknown > 0 ? 'unknown' : 'ineligible'
  if (result.status !== expectedStatus) fail('result status does not follow eligible, unknown, ineligible precedence')
  const expectedReasons = result.candidates.length === 0 ? ['NO_EXACT_BINDING'] : []
  if (!isDeepStrictEqual(result.reasonCodes, expectedReasons)) {
    fail('top-level reasonCodes do not match the candidate population')
  }
}

export async function validateResolutionResult(value) {
  const snapshot = snapshotJsonValue(value, {
    code: 'HOST_RESOLUTION_RESULT_INVALID',
    label: 'resolution result',
  })
  assertSchema(
    await schemaValidator(),
    snapshot,
    'HOST_RESOLUTION_RESULT_INVALID',
    'resolution result',
  )
  assertSemantics(snapshot)
  return snapshot
}
