import { AdmissionController } from './admission.mjs'
import { CircuitBreaker } from './circuit-breaker.mjs'
import { asHostError, HostError, hostErrorPayload } from './errors.mjs'
import { digestJson, jsonBytes, snapshotJsonValue } from './json.mjs'
import { isDeterministicResolutionRejection, validateResolutionResult } from './resolution-result.mjs'
import { assertSchema, createValidator, loadBundledSchema } from './schema.mjs'
import { JsonlSession } from './sessions/jsonl-session.mjs'
import { McpSession } from './sessions/mcp-session.mjs'

let validateWorkOrderSchema
let validateContractSelectionSchema
let validateResolutionRequestSchema
let providerRequestCounter = 0
let workOrderRunCounter = 0

async function workOrderValidator() {
  if (validateWorkOrderSchema === undefined) {
    validateWorkOrderSchema = createValidator().compile(await loadBundledSchema('work-order.schema.json'))
  }
  return validateWorkOrderSchema
}

async function contractSelectionValidator() {
  if (validateContractSelectionSchema === undefined) {
    validateContractSelectionSchema = createValidator().compile(
      await loadBundledSchema('contract-selection.schema.json'),
    )
  }
  return validateContractSelectionSchema
}

async function resolutionRequestValidator() {
  if (validateResolutionRequestSchema === undefined) {
    validateResolutionRequestSchema = createValidator().compile(
      await loadBundledSchema('resolution-request.schema.json'),
    )
  }
  return validateResolutionRequestSchema
}

function configuredTargetMatch(binding, target) {
  if (target.kind === 'capability') {
    return binding.transport === 'capability-jsonl-v0.1' &&
      binding.capabilityId === target.capabilityId &&
      binding.capabilityVersion === target.capabilityVersion &&
      binding.operations.has(target.operationId)
  }
  if (target.kind === 'procedure') {
    return binding.transport === 'procedure-jsonl-v0.2' &&
      binding.procedureId === target.procedureId &&
      binding.procedureVersion === target.procedureVersion
  }
  if (binding.transport !== 'mcp-stdio' || !binding.allowedTools.includes(target.toolName)) return false
  if (target.kind === 'mcp-operation') return binding.projectionDefinitions.has(target.toolName)
  return target.kind === 'mcp-tool' && !binding.projectionDefinitions.has(target.toolName)
}

function projectionEnvelopeMatch(target) {
  return target.kind === 'mcp-operation' ? 'satisfied' : 'not_applicable'
}

function failedConstraintStatus(requested) {
  return requested ? 'not_observed' : 'not_requested'
}

function assertResolutionActive(signal, cause) {
  if (signal?.aborted !== true) return
  throw new HostError('HOST_CANCELLED', 'Resolution was cancelled by the caller', { cause })
}

function createSession(binding) {
  return binding.transport === 'mcp-stdio' ? new McpSession(binding) : new JsonlSession(binding)
}

function callBase(call, binding, contractDigest) {
  return {
    id: call.id,
    providerId: call.providerId,
    target: call.target,
    binding: {
      transport: binding.transport,
      lifecycle: binding.lifecycle,
      digest: binding.bindingDigest,
      providerVersion: binding.providerVersion ?? binding.expectedServer.version,
      ...(contractDigest === undefined ? {} : {
        contractDigest,
        contractSource: binding.transport === 'mcp-stdio' ? 'live-session' : 'configured-files',
      }),
    },
  }
}

class ProviderManager {
  #sessions = new Map()
  #closing = false

  constructor(config) {
    this.config = config
  }

  binding(providerId) {
    const binding = this.config.providers.get(providerId)
    if (binding === undefined) throw new HostError('HOST_UNKNOWN_PROVIDER', `Unknown provider ${providerId}`)
    return binding
  }

  async withSession(providerId, task) {
    if (this.#closing) throw new HostError('HOST_RUNTIME_CLOSED', 'Direct execution runtime is closing or closed')
    const binding = this.binding(providerId)
    if (binding.lifecycle === 'per-call') {
      const session = createSession(binding)
      try {
        return await task(session, binding)
      } finally {
        await session.close()
      }
    }
    let session = this.#sessions.get(providerId)
    if (session === undefined) {
      session = createSession(binding)
      this.#sessions.set(providerId, session)
    }
    return await task(session, binding)
  }

  async replace(providerId) {
    if (this.#closing) throw new HostError('HOST_RUNTIME_CLOSED', 'Direct execution runtime is closing or closed')
    this.binding(providerId)
    const session = this.#sessions.get(providerId)
    this.#sessions.delete(providerId)
    if (session !== undefined) await session.close()
  }

  beginClose() {
    this.#closing = true
  }

  async close() {
    this.#closing = true
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    const closed = await Promise.allSettled(sessions.map((session) => session.close()))
    const failed = closed.find((result) => result.status === 'rejected')
    if (failed !== undefined) {
      throw new HostError('HOST_CLEANUP_FAILED', 'One or more provider sessions did not close cleanly', {
        cause: failed.reason,
      })
    }
  }

  sessionSnapshots() {
    return [...this.config.providers.values()].map((binding) => {
      const session = this.#sessions.get(binding.providerId)
      return {
        providerId: binding.providerId,
        transport: binding.transport,
        present: session !== undefined,
        pid: session?.pid ?? null,
        generation: session?.generation ?? 0,
        live: typeof session?.observation === 'function' ? session.observation() : null,
      }
    })
  }
}

export class DirectExecutionRuntime {
  #state = 'open'
  #lifecycle = new AbortController()
  #inFlight = new Set()
  #closePromise

  constructor(config, options = {}) {
    this.config = config
    this.admission = new AdmissionController(config.limits)
    this.circuits = new CircuitBreaker(config.limits)
    this.providers = new ProviderManager(config)
    this.observationSink = options.observationSink ?? null
    this.observationState = {
      enabled: this.observationSink !== null,
      attempted: 0,
      written: 0,
      failed: 0,
      lastErrorCode: null,
    }
  }

  #enterOperation(externalSignal) {
    if (this.#state !== 'open') {
      throw new HostError('HOST_RUNTIME_CLOSED', 'Direct execution runtime is closing or closed')
    }
    let signal
    try {
      signal = externalSignal === undefined
        ? this.#lifecycle.signal
        : AbortSignal.any([externalSignal, this.#lifecycle.signal])
    } catch (error) {
      throw new HostError('HOST_INPUT_INVALID', 'Operation signal must be an AbortSignal', { cause: error })
    }
    let settle
    const completed = new Promise((resolve) => { settle = resolve })
    this.#inFlight.add(completed)
    let left = false
    return {
      signal,
      leave: () => {
        if (left) return
        left = true
        this.#inFlight.delete(completed)
        settle()
      },
    }
  }

  async #normalizeWorkOrder(workOrder) {
    const snapshot = snapshotJsonValue(workOrder, {
      code: 'HOST_INVALID_JSON_VALUE',
      label: 'work order',
    })
    assertSchema(await workOrderValidator(), snapshot, 'HOST_WORK_ORDER_INVALID', 'work order')
    if (jsonBytes(snapshot) > this.config.limits.maxWorkOrderBytes) {
      throw new HostError('HOST_INPUT_TOO_LARGE', 'Complete work order exceeds the configured byte limit')
    }
    if (snapshot.calls.length > this.config.limits.maxWorkOrderCalls) {
      throw new HostError('HOST_TOO_MANY_CALLS', 'Work order exceeds the configured call-count limit')
    }
    const ids = new Set()
    for (const call of snapshot.calls) {
      if (ids.has(call.id)) throw new HostError('HOST_WORK_ORDER_INVALID', `Duplicate call id ${call.id}`)
      ids.add(call.id)
      const binding = this.providers.binding(call.providerId)
      if (binding.transport === 'capability-jsonl-v0.1' && call.target.kind !== 'capability') {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires a Capability target`)
      }
      if (binding.transport === 'procedure-jsonl-v0.2' && call.target.kind !== 'procedure') {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires a Procedure target`)
      }
      if (
        binding.transport === 'mcp-stdio' &&
        !['mcp-tool', 'mcp-operation'].includes(call.target.kind)
      ) {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires an MCP target`)
      }
    }
    return snapshot
  }

  async projectContract(selection, options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
      const snapshot = snapshotJsonValue(selection, {
        code: 'HOST_CONTRACT_SELECTION_INVALID',
        label: 'contract selection',
        maxBytes: this.config.limits.maxWorkOrderBytes,
      })
      assertSchema(
        await contractSelectionValidator(),
        snapshot,
        'HOST_CONTRACT_SELECTION_INVALID',
        'contract selection',
      )
      const binding = this.providers.binding(snapshot.providerId)
      if (
        (binding.transport === 'capability-jsonl-v0.1' && snapshot.target.kind !== 'capability') ||
        (binding.transport === 'procedure-jsonl-v0.2' && snapshot.target.kind !== 'procedure') ||
        (binding.transport === 'mcp-stdio' && !['mcp-tool', 'mcp-operation'].includes(snapshot.target.kind))
      ) {
        throw new HostError('HOST_BINDING_MISMATCH', 'Contract selection target does not match the provider transport')
      }
      const deadlineAt = Date.now() + this.config.limits.defaultTimeoutMs
      const contract = await this.providers.withSession(snapshot.providerId, async (session) => (
        await session.projectContract(snapshot.target, { signal: operation.signal, deadlineAt })
      ))
      const projection = {
        schemaVersion: 'openadam.direct-contract-projection.v0.1',
        projectedAt: new Date().toISOString(),
        provider: {
          id: binding.providerId,
          version: binding.providerVersion ?? binding.expectedServer.version,
          transport: binding.transport,
        },
        target: snapshot.target,
        contract,
      }
      if (jsonBytes(projection) > this.config.limits.maxResultBytes) {
        throw new HostError('HOST_RESULT_TOO_LARGE', 'Selected operation contract exceeds the configured result limit')
      }
      return snapshotJsonValue(projection, { code: 'HOST_INTERNAL', label: 'contract projection' })
    } finally {
      operation.leave()
    }
  }

  async resolveBindings(requirement, options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
      assertResolutionActive(operation.signal)
      const request = snapshotJsonValue(requirement, {
        code: 'HOST_RESOLUTION_REQUEST_INVALID',
        label: 'resolution request',
        maxBytes: this.config.limits.maxWorkOrderBytes,
      })
      const validateRequest = await resolutionRequestValidator()
      assertResolutionActive(operation.signal)
      assertSchema(
        validateRequest,
        request,
        'HOST_RESOLUTION_REQUEST_INVALID',
        'resolution request',
      )
      if (jsonBytes(request) > this.config.limits.maxWorkOrderBytes) {
        throw new HostError('HOST_INPUT_TOO_LARGE', 'Resolution request exceeds the configured input byte limit')
      }

      const deadlineMs = Math.min(
        request.constraints.deadlineMs ?? this.config.limits.defaultTimeoutMs,
        this.config.limits.defaultTimeoutMs,
      )
      const deadlineAt = Date.now() + deadlineMs
      const configuredMatches = [...this.config.providers.values()]
        .filter((binding) => configuredTargetMatch(binding, request.target))
      const candidates = []

      for (const binding of configuredMatches) {
        assertResolutionActive(operation.signal)
        const selection = {
          schemaVersion: 'openadam.direct-contract-selection.v0.1',
          providerId: binding.providerId,
          target: structuredClone(request.target),
        }
        const provider = {
          id: binding.providerId,
          version: binding.providerVersion ?? binding.expectedServer.version,
          transport: binding.transport,
          lifecycle: binding.lifecycle,
        }
        try {
          const contract = await this.providers.withSession(binding.providerId, async (session) => (
            await session.projectContract(request.target, { signal: operation.signal, deadlineAt })
          ))
          assertResolutionActive(operation.signal)
          const requiredDigest = request.constraints.requiredContractDigest
          const maximumSchemaBytes = request.constraints.maxContractSchemaBytes
          const digestStatus = requiredDigest === undefined
            ? 'not_requested'
            : contract.contractDigest === requiredDigest ? 'satisfied' : 'failed'
          const schemaBytesStatus = maximumSchemaBytes === undefined
            ? 'not_requested'
            : contract.schemaBytes <= maximumSchemaBytes ? 'satisfied' : 'failed'
          const reasonCodes = []
          if (digestStatus === 'failed') reasonCodes.push('REQUIRED_CONTRACT_DIGEST_MISMATCH')
          if (schemaBytesStatus === 'failed') reasonCodes.push('CONTRACT_SCHEMA_BYTES_EXCEEDED')
          const status = reasonCodes.length === 0 ? 'eligible_for_this_request' : 'ineligible'
          candidates.push({
            provider,
            target: structuredClone(request.target),
            selection,
            status,
            checks: {
              semanticIdentity: 'satisfied',
              projectionEnvelopeMatch: projectionEnvelopeMatch(request.target),
              effectAllowance: 'satisfied',
              dataLocality: 'satisfied',
              requiredContractDigest: digestStatus,
              maxContractSchemaBytes: schemaBytesStatus,
            },
            observation: {
              observedAt: new Date().toISOString(),
              projectionStatus: 'observed',
              bindingDigest: binding.bindingDigest,
              contractSource: contract.contractSource,
              contractDigest: contract.contractDigest,
              contractSchemaBytes: contract.schemaBytes,
              executionAvailability: binding.transport === 'mcp-stdio'
                ? 'contract_session_observed'
                : 'not_observed',
              targetOperationInvoked: false,
              error: null,
            },
            reasonCodes,
          })
        } catch (error) {
          const normalized = asHostError(error)
          if (normalized.code === 'HOST_CANCELLED' || operation.signal.aborted === true) {
            assertResolutionActive(operation.signal, normalized)
            throw normalized
          }
          if (request.target.kind === 'mcp-operation' && normalized.code === 'HOST_UNKNOWN_OPERATION') {
            continue
          }
          const status = isDeterministicResolutionRejection(normalized.code) ? 'ineligible' : 'unknown'
          const semanticIdentity = request.target.kind === 'mcp-operation'
            ? 'not_observed'
            : 'satisfied'
          candidates.push({
            provider,
            target: structuredClone(request.target),
            selection,
            status,
            checks: {
              semanticIdentity,
              projectionEnvelopeMatch: projectionEnvelopeMatch(request.target),
              effectAllowance: 'not_observed',
              dataLocality: 'satisfied',
              requiredContractDigest: failedConstraintStatus(
                request.constraints.requiredContractDigest !== undefined,
              ),
              maxContractSchemaBytes: failedConstraintStatus(
                request.constraints.maxContractSchemaBytes !== undefined,
              ),
            },
            observation: {
              observedAt: new Date().toISOString(),
              projectionStatus: 'failed',
              bindingDigest: binding.bindingDigest,
              contractSource: null,
              contractDigest: null,
              contractSchemaBytes: null,
              executionAvailability: 'unknown',
              targetOperationInvoked: false,
              error: hostErrorPayload(normalized),
            },
            reasonCodes: [normalized.code],
          })
        }
      }

      const eligible = candidates.filter((candidate) => candidate.status === 'eligible_for_this_request').length
      const ineligible = candidates.filter((candidate) => candidate.status === 'ineligible').length
      const unknown = candidates.length - eligible - ineligible
      const exactCandidates = candidates.filter(
        (candidate) => candidate.checks.semanticIdentity === 'satisfied',
      ).length
      const status = eligible > 0
        ? 'eligible_for_this_request'
        : unknown > 0 ? 'unknown' : 'ineligible'
      const resolvedAt = new Date().toISOString()
      const result = {
        schemaVersion: 'openadam.direct-resolution-result.v0.1',
        resolvedAt,
        freshness: {
          kind: 'point-in-time',
          observedAt: resolvedAt,
          expiresAt: null,
          reuseRequiresRevalidation: true,
        },
        request: structuredClone(request),
        status,
        summary: {
          configuredProviders: this.config.providers.size,
          configuredMatches: configuredMatches.length,
          exactCandidates,
          eligible,
          ineligible,
          unknown,
        },
        candidates,
        reasonCodes: candidates.length === 0 ? ['NO_EXACT_BINDING'] : [],
      }
      assertResolutionActive(operation.signal)
      let validatedResult
      try {
        validatedResult = await validateResolutionResult(result)
      } catch (error) {
        throw new HostError('HOST_INTERNAL', 'Runtime produced an invalid resolution result', { cause: error })
      }
      if (jsonBytes(result) > this.config.limits.maxResultBytes) {
        throw new HostError('HOST_RESULT_TOO_LARGE', 'Resolution result exceeds the configured result byte limit')
      }
      assertResolutionActive(operation.signal)
      return validatedResult
    } finally {
      operation.leave()
    }
  }

  async validateWorkOrder(workOrder, options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
      const snapshot = await this.#normalizeWorkOrder(workOrder)
      const calls = []
      for (const call of snapshot.calls) {
        try {
          const timeoutMs = call.timeoutMs ?? this.config.limits.defaultTimeoutMs
          await this.providers.withSession(call.providerId, async (session) => {
            await session.validateCall(call, { signal: operation.signal, deadlineAt: Date.now() + timeoutMs })
          })
          calls.push({ id: call.id, providerId: call.providerId, target: call.target, status: 'valid' })
        } catch (error) {
          calls.push({
            id: call.id,
            providerId: call.providerId,
            target: call.target,
            status: 'host_error',
            error: hostErrorPayload(error),
          })
        }
      }
      return snapshotJsonValue({
        schemaVersion: 'openadam.direct-validation-result.v0.1',
        workOrderId: snapshot.id,
        status: calls.every((call) => call.status === 'valid') ? 'valid' : 'invalid',
        calls,
      }, { code: 'HOST_INTERNAL', label: 'validation result' })
    } finally {
      operation.leave()
    }
  }

  async runWorkOrder(workOrder, options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
    const snapshot = await this.#normalizeWorkOrder(workOrder)
    const started = performance.now()
    const startedAtMs = Date.now()
    workOrderRunCounter += 1
    const runSequence = workOrderRunCounter
    const fairnessKey = `${runSequence}-${digestJson({ workOrderId: snapshot.id }).slice(7, 23)}`
    const calls = await Promise.all(
      snapshot.calls.map((call) => this.#runCall(snapshot.id, call, operation.signal, fairnessKey)),
    )
    const succeeded = calls.filter((call) => call.status === 'ok').length
    const failed = calls.length - succeeded
    const result = {
      schemaVersion: 'openadam.direct-result.v0.1',
      workOrderId: snapshot.id,
      status: failed === 0 ? 'ok' : succeeded === 0 ? 'error' : 'partial',
      execution: {
        mode: 'direct-host',
        modelCalls: 0,
        tokenUsage: null,
        monetaryCost: null,
        externalCostStatus: 'not_observed',
      },
      summary: { calls: calls.length, succeeded, failed },
      calls,
      timingMs: { total: performance.now() - started },
    }
    await this.#observeCalls(snapshot, calls, startedAtMs, runSequence)
    if (this.observationSink !== null) result.execution.observation = this.observationSnapshot()
    return snapshotJsonValue(this.#boundResult(result), { code: 'HOST_INTERNAL', label: 'execution result' })
    } finally {
      operation.leave()
    }
  }

  async #observeCalls(workOrder, calls, startedAtMs, runSequence) {
    if (this.observationSink === null) return
    const workOrderHash = digestJson({ workOrderId: workOrder.id })
    for (let index = 0; index < calls.length; index += 1) {
      const sourceCall = workOrder.calls[index]
      const resultCall = calls[index]
      const binding = this.config.providers.get(sourceCall.providerId)
      const durationMs = Math.max(0, resultCall.timingMs?.total ?? 0)
      const completedAtMs = Math.max(startedAtMs, Math.round(startedAtMs + durationMs))
      const responsePayload = resultCall.status === 'ok' ? resultCall.result : resultCall.error
      const providerVersion = resultCall.binding?.providerVersion
        ?? binding?.providerVersion
        ?? binding?.expectedServer?.version
        ?? null
      const observation = {
        schemaVersion: 'openadam.direct-execution-observation.v0.1',
        eventId: digestJson({ workOrderHash, callId: sourceCall.id, completedAtMs, runSequence, status: resultCall.status }),
        workOrderHash,
        callHash: digestJson({ workOrderHash, callId: sourceCall.id }),
        occurredAtMs: startedAtMs,
        completedAtMs,
        target: sourceCall.target,
        provider: {
          id: sourceCall.providerId,
          version: providerVersion,
          transport: binding?.transport,
          lifecycle: binding?.lifecycle,
        },
        status: resultCall.status,
        errorCode: resultCall.error?.code ?? null,
        timingMs: {
          total: durationMs,
          queue: resultCall.timingMs?.queue ?? null,
          providerRoundTrip: resultCall.timingMs?.providerRoundTrip ?? null,
        },
        payloadBytes: {
          request: jsonBytes(sourceCall.input),
          response: responsePayload === undefined ? null : jsonBytes(responsePayload),
        },
        sessionState: resultCall.session ?? null,
        bindingDigest: resultCall.binding?.digest ?? binding?.bindingDigest ?? null,
        contractDigest: resultCall.binding?.contractDigest ?? null,
        execution: {
          modelCalls: 0,
          tokenUsage: null,
          monetaryCost: null,
          externalCostStatus: 'not_observed',
        },
      }
      this.observationState.attempted += 1
      try {
        await this.observationSink.write(snapshotJsonValue(observation, {
          code: 'HOST_INTERNAL',
          label: 'execution observation',
        }))
        this.observationState.written += 1
        this.observationState.lastErrorCode = null
      } catch (error) {
        this.observationState.failed += 1
        this.observationState.lastErrorCode = error?.code ?? 'HOST_OBSERVATION_WRITE_FAILED'
      }
    }
  }

  observationSnapshot() {
    return { ...this.observationState }
  }

  async #runCall(workOrderId, call, signal, fairnessKey) {
    const started = performance.now()
    let binding
    try {
      binding = this.providers.binding(call.providerId)
    } catch (error) {
      return {
        id: call.id,
        providerId: call.providerId,
        target: call.target,
        status: 'host_error',
        error: hostErrorPayload(error),
        timingMs: { queue: 0, providerRoundTrip: null, total: performance.now() - started },
      }
    }
    const timeoutMs = call.timeoutMs ?? this.config.limits.defaultTimeoutMs
    const deadlineAt = Date.now() + timeoutMs
    try {
      this.circuits.assertAvailable(call.providerId)
    } catch (error) {
      return {
        ...callBase(call, binding),
        status: 'host_error',
        error: hostErrorPayload(error),
        timingMs: { queue: 0, providerRoundTrip: null, total: performance.now() - started },
      }
    }
    let admission
    try {
      admission = await this.admission.acquire({ signal, deadlineAt, fairnessKey })
    } catch (error) {
      return {
        ...callBase(call, binding),
        status: 'host_error',
        error: hostErrorPayload(error),
        timingMs: { queue: performance.now() - started, providerRoundTrip: null, total: performance.now() - started },
      }
    }
    try {
      this.circuits.beforeCall(call.providerId)
      providerRequestCounter += 1
      const providerRequestId = `dx-${providerRequestCounter}-${digestJson({ workOrderId, callId: call.id }).slice(7, 23)}`
      const invocation = await this.providers.withSession(call.providerId, async (session) => {
        return await session.invoke(call, { signal, deadlineAt, providerRequestId })
      })
      this.circuits.recordSuccess(call.providerId)
      const common = {
        ...callBase(call, binding, invocation.contractDigest),
        session: invocation.sessionState,
        timingMs: {
          queue: admission.queueMs,
          providerRoundTrip: invocation.providerRoundTripMs,
          total: performance.now() - started,
        },
      }
      if (invocation.ok) return { ...common, status: 'ok', result: invocation.result }
      return { ...common, status: 'provider_error', error: invocation.error }
    } catch (error) {
      const normalized = asHostError(error)
      this.circuits.recordFailure(call.providerId, normalized)
      return {
        ...callBase(call, binding),
        status: 'host_error',
        error: hostErrorPayload(normalized),
        timingMs: { queue: admission.queueMs, providerRoundTrip: null, total: performance.now() - started },
      }
    } finally {
      admission.release()
    }
  }

  #boundResult(result) {
    const limit = this.config.limits.maxResultBytes
    if (jsonBytes(result) <= limit) return result
    const bounded = structuredClone(result)
    const candidates = bounded.calls
      .map((call, index) => ({ index, bytes: jsonBytes(call) }))
      .sort((left, right) => right.bytes - left.bytes)
    for (const candidate of candidates) {
      if (jsonBytes(bounded) <= limit) break
      const previous = bounded.calls[candidate.index]
      bounded.calls[candidate.index] = {
        id: previous.id,
        providerId: previous.providerId,
        target: previous.target,
        binding: previous.binding,
        status: 'host_error',
        error: {
          code: 'HOST_RESULT_TOO_LARGE',
          message: 'The read-only provider call completed, but its semantic result did not fit the whole-order output limit',
          retryable: false,
          details: { executed: true },
        },
        timingMs: previous.timingMs,
      }
    }
    const succeeded = bounded.calls.filter((call) => call.status === 'ok').length
    bounded.summary = { calls: bounded.calls.length, succeeded, failed: bounded.calls.length - succeeded }
    bounded.status = succeeded === bounded.calls.length ? 'ok' : succeeded === 0 ? 'error' : 'partial'
    if (jsonBytes(bounded) > limit) {
      throw new HostError('HOST_RESULT_TOO_LARGE', 'Even the bounded correlated result envelope exceeds the configured limit')
    }
    return bounded
  }

  async inspectBindings(options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
      const providers = []
      for (const binding of this.config.providers.values()) {
        try {
          const observation = await this.providers.withSession(binding.providerId, async (session) => {
            const started = await session.ensureStarted({ signal: operation.signal })
            return {
              sessionState: started.sessionState,
              pid: session.pid,
              generation: session.generation,
              live: typeof session.observation === 'function' ? session.observation() : null,
            }
          })
          const observedState = observation.live?.lastResponseAt !== null && observation.live?.lastResponseAt !== undefined
            ? 'live_call_response_observed'
            : binding.transport === 'mcp-stdio'
              ? 'live_contract_observed'
              : 'process_started_unprobed'
          providers.push({
            providerId: binding.providerId,
            transport: binding.transport,
            lifecycle: binding.lifecycle,
            bindingDigest: binding.bindingDigest,
            circuit: this.circuits.snapshot().find((item) => item.providerId === binding.providerId) ?? {
              providerId: binding.providerId,
              state: 'closed',
              consecutiveFailures: 0,
              retryAfterMs: 0,
              trialInFlight: false,
            },
            observation: observedState,
            ...observation,
          })
        } catch (error) {
          providers.push({
            providerId: binding.providerId,
            transport: binding.transport,
            lifecycle: binding.lifecycle,
            bindingDigest: binding.bindingDigest,
            observation: 'start_failed_observation',
            error: hostErrorPayload(error),
          })
        }
      }
      return snapshotJsonValue({
        schemaVersion: 'openadam.direct-binding-observation.v0.1',
        observedAt: new Date().toISOString(),
        providers,
      }, { code: 'HOST_INTERNAL', label: 'binding observation' })
    } finally {
      operation.leave()
    }
  }

  async replaceProvider(providerId, options = {}) {
    const operation = this.#enterOperation(options.signal)
    try {
      if (typeof providerId !== 'string') throw new HostError('HOST_INPUT_INVALID', 'providerId must be a string')
      await this.providers.replace(providerId)
      this.circuits.reset(providerId)
    } finally {
      operation.leave()
    }
  }

  admissionSnapshot() {
    return this.admission.snapshot()
  }

  circuitSnapshot() {
    return this.circuits.snapshot()
  }

  sessionSnapshot() {
    return this.providers.sessionSnapshots()
  }

  async close() {
    if (this.#closePromise !== undefined) return await this.#closePromise
    this.#state = 'closing'
    this.providers.beginClose()
    this.#lifecycle.abort()
    const operations = [...this.#inFlight]
    const closing = (async () => {
      try {
        await Promise.allSettled(operations)
        await this.providers.close()
      } finally {
        this.#state = 'closed'
      }
    })()
    this.#closePromise = closing
    return await closing
  }
}
