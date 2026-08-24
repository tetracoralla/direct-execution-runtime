import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import {
  fakeCall,
  fakeConfig,
  fakeMcpCall,
  fakeMcpConfig,
  fakeProcedureCall,
  fakeProcedureConfig,
  workOrder,
} from './helpers.mjs'

async function withRuntime(config, task) {
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  try {
    return await task(runtime)
  } finally {
    await runtime.close()
  }
}

test('ordered independent calls preserve success and provider-owned error semantics', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const result = await runtime.runWorkOrder(workOrder('partial', [
      fakeCall('first', { value: 'alpha' }),
      fakeCall('second', { value: 'beta', behavior: 'provider-error' }),
      fakeCall('third', { value: 'gamma' }),
    ]))
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.calls.map((call) => call.id), ['first', 'second', 'third'])
    assert.equal(result.calls[0].result.value, 'alpha')
    assert.equal(result.calls[1].status, 'provider_error')
    assert.equal(result.calls[1].error.code, 'FAKE_REJECTED')
    assert.equal(result.calls[2].result.value, 'gamma')
    assert.deepEqual(result.execution, {
      mode: 'direct-host',
      modelCalls: 0,
      tokenUsage: null,
      monetaryCost: null,
      externalCostStatus: 'not_observed',
    })
  })
})

test('a structured Procedure call runs directly and preserves provider-owned errors', async () => {
  await withRuntime(fakeProcedureConfig(), async (runtime) => {
    const result = await runtime.runWorkOrder(workOrder('procedure', [
      fakeProcedureCall('ok', { value: 'procedure-ok' }),
      fakeProcedureCall('rejected', { value: 'x', behavior: 'provider-error' }),
    ]))
    assert.equal(result.status, 'partial')
    assert.equal(result.calls[0].result.value, 'procedure-ok')
    assert.equal(result.calls[0].binding.transport, 'procedure-jsonl-v0.2')
    assert.match(result.calls[0].binding.contractDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(result.calls[0].binding.contractSource, 'configured-files')
    assert.equal(result.calls[1].status, 'provider_error')
    assert.equal(result.calls[1].error.code, 'FAKE_REJECTED')
    assert.equal(result.calls[1].error.retryable, false)
  })
})

test('invalid operation input is a host error and a later valid call recovers', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const invalid = await runtime.runWorkOrder(workOrder('invalid', [fakeCall('bad', { value: 3 })]))
    assert.equal(invalid.calls[0].status, 'host_error')
    assert.equal(invalid.calls[0].error.code, 'HOST_INPUT_INVALID')
    const valid = await runtime.runWorkOrder(workOrder('valid', [fakeCall('good', { value: 'ok' })]))
    assert.equal(valid.calls[0].result.value, 'ok')
  })
})

test('binding inspection distinguishes process start from an observed live call response', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const before = await runtime.inspectBindings()
    assert.equal(before.providers[0].observation, 'process_started_unprobed')
    await runtime.runWorkOrder(workOrder('observe-call', [fakeCall('call', { value: 'observed' })]))
    const after = await runtime.inspectBindings()
    assert.equal(after.providers[0].observation, 'live_call_response_observed')
  })
})

test('duplicate call ids reject the complete work order before execution', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    await assert.rejects(
      () => runtime.runWorkOrder(workOrder('duplicate', [
        fakeCall('same', { value: 'a' }),
        fakeCall('same', { value: 'b' }),
      ])),
      (error) => error.code === 'HOST_WORK_ORDER_INVALID',
    )
  })
})

test('library callers cannot bypass the JSON carrier with cyclic or non-finite values', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const cyclic = { value: 'cycle' }
    cyclic.self = cyclic
    for (const input of [cyclic, { value: 'number', extra: Number.POSITIVE_INFINITY }]) {
      await assert.rejects(
        () => runtime.runWorkOrder(workOrder('non-json', [fakeCall('bad', input)])),
        (error) => error.code === 'HOST_INVALID_JSON_VALUE',
      )
    }
  })
})

test('bounded FIFO admission rejects overload while admitted calls complete in order', async () => {
  const config = fakeConfig({ limits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } })
  await withRuntime(config, async (runtime) => {
    const result = await runtime.runWorkOrder(workOrder('overload', [
      fakeCall('active', { value: 'a', delayMs: 40 }),
      fakeCall('queued', { value: 'b', delayMs: 40 }),
      fakeCall('rejected', { value: 'c' }),
    ]))
    assert.deepEqual(result.calls.map((call) => call.id), ['active', 'queued', 'rejected'])
    assert.equal(result.calls[0].status, 'ok')
    assert.equal(result.calls[1].status, 'ok')
    assert.equal(result.calls[2].error.code, 'HOST_OVERLOADED')
    assert.deepEqual(runtime.admissionSnapshot().active, 0)
    assert.deepEqual(runtime.admissionSnapshot().queued, 0)
  })
})

test('admission round-robins queued work orders so one large order cannot monopolize the host', async () => {
  const config = fakeConfig({ limits: { maxConcurrentCalls: 1, maxQueuedCalls: 12 } })
  await withRuntime(config, async (runtime) => {
    const large = runtime.runWorkOrder(workOrder('large-group', Array.from(
      { length: 6 },
      (_, index) => fakeCall(`large-${index}`, { value: String(index), delayMs: 20 }),
    )))
    await delay(5)
    const small = runtime.runWorkOrder(workOrder('small-group', [
      fakeCall('small', { value: 'small', delayMs: 1 }),
    ]))
    const firstCompleted = await Promise.race([
      large.then(() => 'large'),
      small.then(() => 'small'),
    ])
    assert.equal(firstCompleted, 'small')
    assert.equal((await small).calls[0].result.value, 'small')
    assert.equal((await large).summary.failed, 0)
  })
})

test('JSONL timeout replaces the session and the next ordinary call recovers', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const timedOut = await runtime.runWorkOrder(workOrder('timeout', [
      fakeCall('slow', { value: 'late', delayMs: 100 }, 10),
    ]))
    assert.equal(timedOut.calls[0].error.code, 'HOST_TIMEOUT')
    const recovered = await runtime.runWorkOrder(workOrder('recover', [fakeCall('next', { value: 'ready' })]))
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].session, 'cold')
  })
})

test('running cancellation replaces the JSONL session and releases admission', async () => {
  await withRuntime(fakeConfig(), async (runtime) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 15)
    const cancelled = await runtime.runWorkOrder(
      workOrder('cancel', [fakeCall('slow', { value: 'late', delayMs: 200 })]),
      { signal: controller.signal },
    )
    assert.equal(cancelled.calls[0].error.code, 'HOST_CANCELLED')
    assert.equal(runtime.admissionSnapshot().active, 0)
    const recovered = await runtime.runWorkOrder(workOrder('cancel-recover', [fakeCall('next', { value: 'ready' })]))
    assert.equal(recovered.calls[0].status, 'ok')
  })
})

test('one JSONL timeout reports collateral calls as session replacement, not false cancellation', async () => {
  await withRuntime(fakeConfig({ limits: { maxConcurrentCalls: 2 } }), async (runtime) => {
    const result = await runtime.runWorkOrder(workOrder('collateral-replacement', [
      fakeCall('timed-out', { value: 'late', delayMs: 100 }, 10),
      fakeCall('collateral', { value: 'also-late', delayMs: 100 }, 1000),
    ]))
    assert.equal(result.calls[0].error.code, 'HOST_TIMEOUT')
    assert.equal(result.calls[1].error.code, 'HOST_PROVIDER_REPLACED')
    const recovered = await runtime.runWorkOrder(workOrder('collateral-recovery', [fakeCall('next', { value: 'ready' })]))
    assert.equal(recovered.calls[0].status, 'ok')
  })
})

test('malformed output, crash, stderr overflow, and large response each recover through replacement', async () => {
  for (const behavior of ['malformed', 'crash', 'stderr', 'large']) {
    await withRuntime(fakeConfig(), async (runtime) => {
      const failed = await runtime.runWorkOrder(workOrder(`failure-${behavior}`, [
        fakeCall('failure', { value: 'x', behavior }),
      ]))
      assert.equal(failed.calls[0].status, 'host_error', behavior)
      const recovered = await runtime.runWorkOrder(workOrder(`recovery-${behavior}`, [
        fakeCall('recovery', { value: behavior }),
      ]))
      assert.equal(recovered.calls[0].result.value, behavior)
    })
  }
})

test('repeated host failures open a provider circuit and one bounded half-open call recovers it', async () => {
  const config = fakeConfig({ limits: { circuitBreakerFailureThreshold: 2, circuitBreakerCooldownMs: 50 } })
  await withRuntime(config, async (runtime) => {
    for (const id of ['failure-one', 'failure-two']) {
      const failed = await runtime.runWorkOrder(workOrder(id, [
        fakeCall(id, { value: 'crash', behavior: 'crash' }),
      ]))
      assert.equal(failed.calls[0].error.code, 'HOST_PROVIDER_EXITED')
    }
    const open = await runtime.runWorkOrder(workOrder('circuit-open', [fakeCall('blocked', { value: 'blocked' })]))
    assert.equal(open.calls[0].error.code, 'HOST_CIRCUIT_OPEN')
    assert.equal(runtime.circuitSnapshot()[0].state, 'open')
    await delay(60)
    const recovered = await runtime.runWorkOrder(workOrder('half-open-recovery', [fakeCall('recovered', { value: 'ok' })]))
    assert.equal(recovered.calls[0].result.value, 'ok')
    assert.equal(runtime.circuitSnapshot()[0].state, 'closed')
  })
})

test('caller-selected short deadlines do not open the shared provider circuit', async () => {
  const config = fakeConfig({ limits: { circuitBreakerFailureThreshold: 2, circuitBreakerCooldownMs: 50 } })
  await withRuntime(config, async (runtime) => {
    for (const id of ['short-one', 'short-two']) {
      const timedOut = await runtime.runWorkOrder(workOrder(id, [
        fakeCall(id, { value: 'late', delayMs: 100 }, 10),
      ]))
      assert.equal(timedOut.calls[0].error.code, 'HOST_TIMEOUT')
    }
    assert.equal(runtime.circuitSnapshot()[0].state, 'closed')
    const recovered = await runtime.runWorkOrder(workOrder('deadline-recovery', [fakeCall('ready', { value: 'ready' })]))
    assert.equal(recovered.calls[0].result.value, 'ready')
  })
})

test('cold MCP startup deadline terminates the child before a later cold recovery', async () => {
  await withRuntime(fakeMcpConfig({ args: ['--startup-delay=100'] }), async (runtime) => {
    const timedOut = await runtime.runWorkOrder(workOrder('mcp-startup-timeout', [
      fakeMcpCall('timeout', { value: 'late' }, 10),
    ]))
    assert.equal(timedOut.calls[0].error.code, 'HOST_TIMEOUT')
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
    const recovered = await runtime.runWorkOrder(workOrder('mcp-startup-recovery', [
      fakeMcpCall('recovered', { value: 'ready' }),
    ]))
    assert.equal(recovered.calls[0].session, 'cold')
    assert.equal(recovered.calls[0].result.value, 'ready')
    assert.match(recovered.calls[0].binding.contractDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(recovered.calls[0].binding.contractSource, 'live-session')
  })
})

test('MCP stderr overflow poisons the generation and the next call starts cleanly', async () => {
  await withRuntime(fakeMcpConfig(), async (runtime) => {
    const failed = await runtime.runWorkOrder(workOrder('mcp-stderr', [
      fakeMcpCall('stderr', { value: 'bad', behavior: 'stderr' }),
    ]))
    assert.equal(failed.calls[0].error.code, 'HOST_PROVIDER_STDERR_LIMIT')
    assert.equal(runtime.sessionSnapshot()[0].pid, null)
    const recovered = await runtime.runWorkOrder(workOrder('mcp-stderr-recovery', [
      fakeMcpCall('ready', { value: 'ready' }),
    ]))
    assert.equal(recovered.calls[0].result.value, 'ready')
    assert.equal(recovered.calls[0].session, 'cold')
  })
})

test('per-call lifecycle starts a cold adapter for every independent call', async () => {
  await withRuntime(fakeConfig({ lifecycle: 'per-call' }), async (runtime) => {
    const result = await runtime.runWorkOrder(workOrder('per-call', [
      fakeCall('one', { value: '1' }),
      fakeCall('two', { value: '2' }),
    ]))
    assert.deepEqual(result.calls.map((call) => call.session), ['cold', 'cold'])
  })
})

test('whole-order output budget replaces large semantic payloads without truncating them', async () => {
  const config = fakeConfig({
    limits: {
      maxWorkOrderBytes: 1024 * 1024,
      maxQueuedCalls: 16,
      maxProviderResponseBytes: 64 * 1024,
      maxResultBytes: 262144,
    },
  })
  await withRuntime(config, async (runtime) => {
    const calls = Array.from({ length: 8 }, (_, index) => fakeCall(`wide-${index}`, { value: 'v'.repeat(40_000) }))
    const result = await runtime.runWorkOrder(workOrder('bounded-result', calls))
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= config.limits.maxResultBytes)
    assert.ok(result.calls.some((call) => call.error?.code === 'HOST_RESULT_TOO_LARGE'))
    assert.ok(result.calls.every((call) => call.result === undefined || call.result.value.length === 40_000))
  })
})
