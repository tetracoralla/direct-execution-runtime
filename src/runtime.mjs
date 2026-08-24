import { AdmissionController } from './admission.mjs'
import { CircuitBreaker } from './circuit-breaker.mjs'
import { asHostError, HostError, hostErrorPayload } from './errors.mjs'
import { digestJson, jsonBytes } from './json.mjs'
import { assertSchema, createValidator, loadBundledSchema } from './schema.mjs'
import { JsonlSession } from './sessions/jsonl-session.mjs'
import { McpSession } from './sessions/mcp-session.mjs'

let validateWorkOrderSchema
let providerRequestCounter = 0
let workOrderRunCounter = 0

async function workOrderValidator() {
  if (validateWorkOrderSchema === undefined) {
    validateWorkOrderSchema = createValidator().compile(await loadBundledSchema('work-order.schema.json'))
  }
  return validateWorkOrderSchema
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

  constructor(config) {
    this.config = config
  }

  binding(providerId) {
    const binding = this.config.providers.get(providerId)
    if (binding === undefined) throw new HostError('HOST_UNKNOWN_PROVIDER', `Unknown provider ${providerId}`)
    return binding
  }

  async withSession(providerId, task) {
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
    this.binding(providerId)
    const session = this.#sessions.get(providerId)
    this.#sessions.delete(providerId)
    if (session !== undefined) await session.close()
  }

  async close() {
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
  constructor(config) {
    this.config = config
    this.admission = new AdmissionController(config.limits)
    this.circuits = new CircuitBreaker(config.limits)
    this.providers = new ProviderManager(config)
  }

  async assertWorkOrder(workOrder) {
    assertSchema(await workOrderValidator(), workOrder, 'HOST_WORK_ORDER_INVALID', 'work order')
    if (jsonBytes(workOrder) > this.config.limits.maxWorkOrderBytes) {
      throw new HostError('HOST_INPUT_TOO_LARGE', 'Complete work order exceeds the configured byte limit')
    }
    if (workOrder.calls.length > this.config.limits.maxWorkOrderCalls) {
      throw new HostError('HOST_TOO_MANY_CALLS', 'Work order exceeds the configured call-count limit')
    }
    const ids = new Set()
    for (const call of workOrder.calls) {
      if (ids.has(call.id)) throw new HostError('HOST_WORK_ORDER_INVALID', `Duplicate call id ${call.id}`)
      ids.add(call.id)
      const binding = this.providers.binding(call.providerId)
      if (binding.transport === 'capability-jsonl-v0.1' && call.target.kind !== 'capability') {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires a Capability target`)
      }
      if (binding.transport === 'procedure-jsonl-v0.2' && call.target.kind !== 'procedure') {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires a Procedure target`)
      }
      if (binding.transport === 'mcp-stdio' && call.target.kind !== 'mcp-tool') {
        throw new HostError('HOST_BINDING_MISMATCH', `Provider ${call.providerId} requires an MCP tool target`)
      }
    }
    return workOrder
  }

  async validateWorkOrder(workOrder) {
    await this.assertWorkOrder(workOrder)
    const calls = []
    for (const call of workOrder.calls) {
      try {
        const timeoutMs = call.timeoutMs ?? this.config.limits.defaultTimeoutMs
        await this.providers.withSession(call.providerId, async (session) => {
          await session.validateCall(call, { deadlineAt: Date.now() + timeoutMs })
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
    return {
      schemaVersion: 'openadam.direct-validation-result.v0.1',
      workOrderId: workOrder.id,
      status: calls.every((call) => call.status === 'valid') ? 'valid' : 'invalid',
      calls,
    }
  }

  async runWorkOrder(workOrder, options = {}) {
    await this.assertWorkOrder(workOrder)
    const started = performance.now()
    workOrderRunCounter += 1
    const fairnessKey = `${workOrderRunCounter}-${digestJson({ workOrderId: workOrder.id }).slice(7, 23)}`
    const calls = await Promise.all(
      workOrder.calls.map((call) => this.#runCall(workOrder.id, call, options.signal, fairnessKey)),
    )
    const succeeded = calls.filter((call) => call.status === 'ok').length
    const failed = calls.length - succeeded
    const result = {
      schemaVersion: 'openadam.direct-result.v0.1',
      workOrderId: workOrder.id,
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
    return this.#boundResult(result)
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

  async inspectBindings() {
    const providers = []
    for (const binding of this.config.providers.values()) {
      try {
        const observation = await this.providers.withSession(binding.providerId, async (session) => {
          const started = await session.ensureStarted()
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
    return {
      schemaVersion: 'openadam.direct-binding-observation.v0.1',
      observedAt: new Date().toISOString(),
      providers,
    }
  }

  async replaceProvider(providerId) {
    await this.providers.replace(providerId)
    this.circuits.reset(providerId)
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
    await this.providers.close()
  }
}
