import { HostError } from './errors.mjs'

const CIRCUIT_FAILURE_CODES = new Set([
  'HOST_PROVIDER_UNAVAILABLE',
  'HOST_PROVIDER_EXITED',
  'HOST_TRANSPORT_ERROR',
  'HOST_PROVIDER_RESPONSE_TOO_LARGE',
  'HOST_PROVIDER_PROTOCOL_ERROR',
  'HOST_PROVIDER_STDERR_LIMIT',
  'HOST_PROVIDER_OUTPUT_INVALID',
  'HOST_CLEANUP_FAILED',
])

export class CircuitBreaker {
  #states = new Map()

  constructor({ circuitBreakerFailureThreshold, circuitBreakerCooldownMs }) {
    this.failureThreshold = circuitBreakerFailureThreshold
    this.cooldownMs = circuitBreakerCooldownMs
  }

  #state(providerId) {
    let state = this.#states.get(providerId)
    if (state === undefined) {
      state = { consecutiveFailures: 0, openUntil: 0, trialInFlight: false }
      this.#states.set(providerId, state)
    }
    return state
  }

  assertAvailable(providerId, now = Date.now()) {
    const state = this.#state(providerId)
    if (state.openUntil > now) {
      throw new HostError('HOST_CIRCUIT_OPEN', 'Provider circuit is open after repeated host-level failures', {
        retryable: true,
        details: { retryAfterMs: state.openUntil - now },
      })
    }
    if (state.consecutiveFailures >= this.failureThreshold && state.trialInFlight) {
      throw new HostError('HOST_CIRCUIT_OPEN', 'Provider circuit is waiting for its bounded recovery probe', {
        retryable: true,
        details: { retryAfterMs: 0 },
      })
    }
  }

  beforeCall(providerId, now = Date.now()) {
    const state = this.#state(providerId)
    this.assertAvailable(providerId, now)
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.trialInFlight = true
    }
  }

  recordSuccess(providerId) {
    const state = this.#state(providerId)
    state.consecutiveFailures = 0
    state.openUntil = 0
    state.trialInFlight = false
  }

  recordFailure(providerId, error, now = Date.now()) {
    const state = this.#state(providerId)
    if (error?.code === 'HOST_CIRCUIT_OPEN') return
    if (!CIRCUIT_FAILURE_CODES.has(error?.code)) {
      state.trialInFlight = false
      return
    }
    state.consecutiveFailures += 1
    state.trialInFlight = false
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.openUntil = now + this.cooldownMs
    }
  }

  reset(providerId) {
    this.#states.delete(providerId)
  }

  snapshot(now = Date.now()) {
    return [...this.#states.entries()].map(([providerId, state]) => ({
      providerId,
      state: state.openUntil > now
        ? 'open'
        : state.consecutiveFailures >= this.failureThreshold
          ? 'half-open'
          : 'closed',
      consecutiveFailures: state.consecutiveFailures,
      retryAfterMs: Math.max(0, state.openUntil - now),
      trialInFlight: state.trialInFlight,
    }))
  }
}
