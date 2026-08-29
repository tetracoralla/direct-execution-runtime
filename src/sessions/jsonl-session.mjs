import { spawn } from 'node:child_process'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { revalidatePreparedBinding } from '../config.mjs'
import { boundedMessage, HostError } from '../errors.mjs'
import { decodeUtf8Strict, jsonBytes, parseStrictJson } from '../json.mjs'
import { createLaunchSnapshot } from '../launch-snapshot.mjs'
import { assertSchema } from '../schema.mjs'

function killProcessGroup(child, signal = 'SIGKILL') {
  if (child?.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The explicit child already exited.
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function awaitWithDeadline(promise, { signal, deadlineAt } = {}) {
  if (signal?.aborted) throw new HostError('HOST_CANCELLED', 'JSONL session startup wait was cancelled')
  if (deadlineAt === undefined) return await promise
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new HostError('HOST_TIMEOUT', 'Call deadline expired during JSONL session startup')
  return await new Promise((resolve, reject) => {
    const settle = (method, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      method(value)
    }
    const timer = setTimeout(
      () => settle(reject, new HostError('HOST_TIMEOUT', 'Call deadline expired during JSONL session startup', { retryable: true })),
      remaining,
    )
    const abort = () => settle(reject, new HostError('HOST_CANCELLED', 'JSONL session startup wait was cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    promise.then((value) => settle(resolve, value), (error) => settle(reject, error))
  })
}

async function awaitCancelledStartup(starting) {
  if (starting === undefined) return
  try {
    await starting
  } catch (error) {
    if (error?.code === 'HOST_CLEANUP_FAILED') throw error
  }
}

export class JsonlSession {
  #child
  #buffer = Buffer.alloc(0)
  #pending = new Map()
  #stderr = Buffer.alloc(0)
  #closing = false
  #generation = 0
  #starting
  #cleanup = Promise.resolve()
  #closePromise
  #startedAt
  #lastResponseAt
  #launchSnapshot

  constructor(binding) {
    this.binding = binding
  }

  get pid() {
    return this.#child?.pid ?? null
  }

  get generation() {
    return this.#generation
  }

  observation() {
    if (this.binding.transport === 'procedure-jsonl-v0.2') {
      return {
        procedureId: this.binding.procedureId,
        procedureVersion: this.binding.procedureVersion,
        providerVersion: this.binding.providerVersion,
        contractSchemaBytes: this.binding.contractSchemaBytes,
        contractDigest: this.binding.contractDigest,
        pid: this.pid,
        generation: this.#generation,
        processStartedAt: this.#startedAt ?? null,
        lastResponseAt: this.#lastResponseAt ?? null,
      }
    }
    return {
      capabilityId: this.binding.capabilityId,
      capabilityVersion: this.binding.capabilityVersion,
      providerVersion: this.binding.providerVersion,
      operations: [...this.binding.operations.keys()],
      contractSchemaBytes: this.binding.contractSchemaBytes,
      contractDigest: this.binding.contractDigest,
      pid: this.pid,
      generation: this.#generation,
      processStartedAt: this.#startedAt ?? null,
      lastResponseAt: this.#lastResponseAt ?? null,
    }
  }

  async ensureStarted(options = {}) {
    await awaitWithDeadline(this.#cleanup, options)
    if (this.#starting !== undefined) {
      try {
        await awaitWithDeadline(this.#starting, options)
      } catch (error) {
        if (error?.code === 'HOST_TIMEOUT' || error?.code === 'HOST_CANCELLED') await this.close()
        throw error
      }
      return { sessionState: 'cold' }
    }
    if (this.#child !== undefined && this.#child.exitCode === null) return { sessionState: 'warm' }
    const starting = (async () => {
      await revalidatePreparedBinding(this.binding)
      if (this.#starting !== starting) {
        throw new HostError('HOST_PROVIDER_REPLACED', 'JSONL session startup was replaced', { retryable: true })
      }
      await this.#start(starting)
    })()
    this.#starting = starting
    try {
      await awaitWithDeadline(starting, options)
    } catch (error) {
      if (error?.code === 'HOST_TIMEOUT' || error?.code === 'HOST_CANCELLED') await this.close()
      throw error
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
    return { sessionState: 'cold' }
  }

  async #start(starting) {
    this.#closing = false
    this.#buffer = Buffer.alloc(0)
    this.#stderr = Buffer.alloc(0)
    const launchSnapshot = await createLaunchSnapshot(this.binding)
    if (this.#starting !== starting) {
      await this.#releaseLaunchSnapshot(launchSnapshot)
      throw new HostError('HOST_PROVIDER_REPLACED', 'JSONL session startup was replaced', { retryable: true })
    }
    this.#launchSnapshot = launchSnapshot
    let child
    try {
      child = spawn(launchSnapshot.command, launchSnapshot.args, {
        cwd: launchSnapshot.cwd,
        env: launchSnapshot.prepareEnvironment(getDefaultEnvironment()),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (error) {
      await this.#releaseLaunchSnapshot(launchSnapshot)
      throw error
    }
    this.#child = child
    this.#generation += 1
    this.#startedAt = new Date().toISOString()
    this.#lastResponseAt = undefined
    child.stdout.on('data', (chunk) => {
      if (this.#child === child) this.#consumeStdout(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (this.#child === child) this.#consumeStderr(chunk)
    })
    child.stdin.on('error', (error) => {
      if (this.#child === child) {
        this.#replace(new HostError('HOST_TRANSPORT_ERROR', boundedMessage(error.message), {
          cause: error,
          retryable: true,
        }))
      }
    })
    child.on('error', (error) => {
      if (this.#child === child) {
        this.#failSession(new HostError('HOST_PROVIDER_UNAVAILABLE', boundedMessage(error.message), { cause: error }))
      }
    })
    child.on('exit', (code, signal) => {
      if (this.#child === child && !this.#closing) {
        this.#failSession(new HostError(
          'HOST_PROVIDER_EXITED',
          `Capability adapter exited unexpectedly (${signal ?? code ?? 'unknown'})`,
          { retryable: true, details: { stderr: boundedMessage(this.#stderr.toString('utf8')) } },
        ))
      }
    })
    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (error) => {
          cleanup()
          reject(new HostError('HOST_PROVIDER_UNAVAILABLE', error.message, { cause: error }))
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (error) {
      await this.#releaseLaunchSnapshot(launchSnapshot)
      throw error
    }
  }

  async validateCall(call, options = {}) {
    await awaitWithDeadline(revalidatePreparedBinding(this.binding), options)
    return this.#validateCallShape(call)
  }

  #validateCallShape(call) {
    if (this.binding.transport === 'procedure-jsonl-v0.2') {
      if (
        call.target.kind !== 'procedure' ||
        call.target.procedureId !== this.binding.procedureId ||
        call.target.procedureVersion !== this.binding.procedureVersion
      ) {
        throw new HostError('HOST_BINDING_MISMATCH', 'Call Procedure identity does not match the selected provider binding')
      }
      assertSchema(this.binding.validateInput, call.input, 'HOST_INPUT_INVALID', `${call.target.procedureId} input`)
      return {
        validateOutput: this.binding.validateOutput,
        label: call.target.procedureId,
        contractDigest: this.binding.contractDigest,
      }
    }
    const operation = this.binding.operations.get(call.target.operationId)
    if (operation === undefined) {
      throw new HostError('HOST_UNKNOWN_OPERATION', `Unknown Capability operation ${call.target.operationId}`)
    }
    if (
      call.target.kind !== 'capability' ||
      call.target.capabilityId !== this.binding.capabilityId ||
      call.target.capabilityVersion !== this.binding.capabilityVersion
    ) {
      throw new HostError('HOST_BINDING_MISMATCH', 'Call Capability identity does not match the selected provider binding')
    }
    assertSchema(operation.validateInput, call.input, 'HOST_INPUT_INVALID', `${call.target.operationId} input`)
    return { ...operation, label: call.target.operationId }
  }

  async projectContract(target, options = {}) {
    await awaitWithDeadline(revalidatePreparedBinding(this.binding), options)
    if (this.binding.transport === 'procedure-jsonl-v0.2') {
      if (
        target.kind !== 'procedure' ||
        target.procedureId !== this.binding.procedureId ||
        target.procedureVersion !== this.binding.procedureVersion
      ) {
        throw new HostError('HOST_BINDING_MISMATCH', 'Projection Procedure identity does not match the selected provider binding')
      }
      return {
        inputSchema: structuredClone(this.binding.inputSchema),
        outputSchema: structuredClone(this.binding.outputSchema),
        errors: [...this.binding.procedureErrors.values()].map(({ code, retryable }) => ({ code, retryable })),
        contractDigest: this.binding.contractDigest,
        contractSource: 'configured-files',
        schemaBytes: this.binding.contractSchemaBytes,
      }
    }
    if (
      target.kind !== 'capability' ||
      target.capabilityId !== this.binding.capabilityId ||
      target.capabilityVersion !== this.binding.capabilityVersion
    ) {
      throw new HostError('HOST_BINDING_MISMATCH', 'Projection Capability identity does not match the selected provider binding')
    }
    const operation = this.binding.operations.get(target.operationId)
    if (operation === undefined) {
      throw new HostError('HOST_UNKNOWN_OPERATION', `Unknown Capability operation ${target.operationId}`)
    }
    return {
      inputSchema: structuredClone(operation.inputSchema),
      outputSchema: structuredClone(operation.outputSchema),
      errors: [...operation.errors.values()].map(({ code, retryable }) => ({ code, retryable })),
      contractDigest: operation.contractDigest,
      contractSource: 'configured-files',
      schemaBytes: operation.schemaBytes,
    }
  }

  async invoke(call, { signal, deadlineAt, providerRequestId }) {
    const contract = this.#validateCallShape(call)
    const { sessionState } = await this.ensureStarted({ signal, deadlineAt })
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new HostError('HOST_TIMEOUT', 'Call deadline expired before provider invocation')
    const request = this.binding.transport === 'procedure-jsonl-v0.2'
      ? {
          id: providerRequestId,
          procedureId: call.target.procedureId,
          procedureVersion: call.target.procedureVersion,
          input: call.input,
        }
      : {
          id: providerRequestId,
          operationId: call.target.operationId,
          input: call.input,
        }
    const line = Buffer.from(`${JSON.stringify(request)}\n`)
    if (line.length > this.binding.limits.maxProtocolLineBytes) {
      throw new HostError('HOST_INPUT_TOO_LARGE', 'Provider request exceeds the configured protocol line limit')
    }
    const roundTripStarted = performance.now()
    let response
    try {
      response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#replace(
            new HostError('HOST_TIMEOUT', 'Capability adapter call exceeded its whole-call deadline', { retryable: true }),
            providerRequestId,
          )
        }, remaining)
        const abort = () => {
          this.#replace(new HostError('HOST_CANCELLED', 'Capability adapter call was cancelled'), providerRequestId)
        }
        const settle = (method, value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          method(value)
        }
        this.#pending.set(providerRequestId, {
          resolve: (value) => settle(resolve, value),
          reject: (error) => settle(reject, error),
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
          abort()
          return
        }
        this.#child.stdin.write(line, (error) => {
          if (error !== null && error !== undefined) {
            this.#replace(new HostError('HOST_TRANSPORT_ERROR', boundedMessage(error.message), {
              cause: error,
              retryable: true,
            }))
          }
        })
      })
    } catch (error) {
      await this.#cleanup
      throw error
    }
    this.#lastResponseAt = new Date().toISOString()
    if (jsonBytes(response) > this.binding.limits.maxProviderResponseBytes) {
      const error = new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'Capability adapter response exceeds the configured byte limit')
      this.#replace(error)
      throw error
    }
    if (response.ok === true) {
      if (JSON.stringify(Object.keys(response).sort()) !== JSON.stringify(['id', 'ok', 'result'])) {
        const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Provider success response has unexpected fields')
        this.#replace(error)
        throw error
      }
      try {
        assertSchema(contract.validateOutput, response.result, 'HOST_PROVIDER_OUTPUT_INVALID', `${contract.label} output`)
      } catch (error) {
        this.#replace(error)
        throw error
      }
      return {
        ok: true,
        result: response.result,
        sessionState,
        providerRoundTripMs: performance.now() - roundTripStarted,
        contractDigest: contract.contractDigest,
      }
    }
    if (response.ok === false && response.error !== null && typeof response.error === 'object') {
      if (JSON.stringify(Object.keys(response).sort()) !== JSON.stringify(['error', 'id', 'ok'])) {
        const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Provider error response has unexpected fields')
        this.#replace(error)
        throw error
      }
      if (
        Array.isArray(response.error) ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(response.error.code) ||
        typeof response.error.message !== 'string' ||
        response.error.message.length === 0
      ) {
        const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Provider returned an invalid error envelope')
        this.#replace(error)
        throw error
      }
      let providerError = response.error
      if (this.binding.transport === 'procedure-jsonl-v0.2') {
        if (JSON.stringify(Object.keys(response.error).sort()) !== JSON.stringify(['code', 'message'])) {
          const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Procedure returned an inexact error envelope')
          this.#replace(error)
          throw error
        }
        const declaration = this.binding.procedureErrors.get(response.error.code)
        if (declaration === undefined) {
          const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Procedure returned an undeclared error code')
          this.#replace(error)
          throw error
        }
        providerError = { ...response.error, retryable: declaration.retryable }
      } else {
        const errorFields = Object.keys(response.error).sort()
        const exactLegacyFields =
          JSON.stringify(errorFields) === JSON.stringify(['code', 'message'])
        const exactEchoFields =
          JSON.stringify(errorFields) === JSON.stringify(['code', 'message', 'retryable'])
        if (!exactLegacyFields && !exactEchoFields) {
          const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability returned an inexact error envelope')
          this.#replace(error)
          throw error
        }
        const declaration = contract.errors.get(response.error.code)
        if (declaration === undefined) {
          const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability returned an undeclared error code')
          this.#replace(error)
          throw error
        }
        if (
          Object.hasOwn(response.error, 'retryable') &&
          (typeof response.error.retryable !== 'boolean' ||
            response.error.retryable !== declaration.retryable)
        ) {
          const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability error retryability differs from the Profile')
          this.#replace(error)
          throw error
        }
        providerError = {
          code: response.error.code,
          message: response.error.message,
          retryable: declaration.retryable,
        }
      }
      return {
        ok: false,
        error: providerError,
        sessionState,
        providerRoundTripMs: performance.now() - roundTripStarted,
        contractDigest: contract.contractDigest,
      }
    }
    const error = new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter returned neither success nor provider error')
    this.#replace(error)
    throw error
  }

  #consumeStdout(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    let newline = this.#buffer.indexOf(0x0a)
    while (newline !== -1) {
      const line = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (line.length > this.binding.limits.maxProtocolLineBytes) {
        this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter emitted an oversized protocol line'))
        return
      }
      if (line.length === 0) {
        this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter emitted an empty protocol line'))
        return
      }
      this.#consumeLine(line)
      newline = this.#buffer.indexOf(0x0a)
    }
    if (this.#buffer.length > this.binding.limits.maxProtocolLineBytes) {
      this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter emitted an oversized protocol line'))
    }
  }

  #consumeLine(line) {
    let response
    try {
      response = parseStrictJson(
        decodeUtf8Strict(line, 'Capability adapter response', 'HOST_PROVIDER_PROTOCOL_ERROR'),
        'Capability adapter response',
      )
    } catch (error) {
      this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', boundedMessage(error.message), { cause: error }))
      return
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response) || typeof response.id !== 'string') {
      this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter response has no valid correlation id'))
      return
    }
    const pending = this.#pending.get(response.id)
    if (pending === undefined) {
      this.#replace(new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'Capability adapter returned an unknown correlation id'))
      return
    }
    this.#pending.delete(response.id)
    pending.resolve(response)
  }

  #consumeStderr(chunk) {
    this.#stderr = Buffer.concat([this.#stderr, chunk])
    if (this.#stderr.length > this.binding.limits.maxStderrBytes) {
      this.#replace(new HostError('HOST_PROVIDER_STDERR_LIMIT', 'Capability adapter exceeded the stderr byte limit'))
    }
  }

  #failSession(error, primaryRequestId, releaseSnapshot = true) {
    const pending = [...this.#pending.entries()]
    this.#pending.clear()
    for (const [requestId, item] of pending) {
      if (primaryRequestId === undefined || requestId === primaryRequestId) item.reject(error)
      else {
        item.reject(new HostError(
          'HOST_PROVIDER_REPLACED',
          'Another call forced replacement of the shared Capability adapter session',
          { retryable: true },
        ))
      }
    }
    this.#child = undefined
    if (releaseSnapshot) {
      const launchSnapshot = this.#launchSnapshot
      this.#cleanup = this.#releaseLaunchSnapshot(launchSnapshot)
    }
  }

  async #releaseLaunchSnapshot(snapshot) {
    if (snapshot === undefined) return
    if (this.#launchSnapshot === snapshot) this.#launchSnapshot = undefined
    try {
      await snapshot.dispose()
    } catch (error) {
      throw new HostError('HOST_CLEANUP_FAILED', 'JSONL provider launch snapshot was not removed', { cause: error })
    }
  }

  #replace(error, primaryRequestId) {
    const child = this.#child
    const launchSnapshot = this.#launchSnapshot
    this.#closing = true
    this.#failSession(error, primaryRequestId, false)
    if (child !== undefined) {
      killProcessGroup(child)
      this.#cleanup = (async () => {
        if (!(await waitForExit(child, 750))) {
          throw new HostError('HOST_CLEANUP_FAILED', 'Capability adapter process did not exit after forced replacement')
        }
        await this.#releaseLaunchSnapshot(launchSnapshot)
      })()
    } else {
      this.#cleanup = this.#releaseLaunchSnapshot(launchSnapshot)
    }
  }

  async close() {
    if (this.#closePromise !== undefined) return await this.#closePromise
    const closing = this.#closeOwned()
    this.#closePromise = closing
    try {
      await closing
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined
    }
  }

  async #closeOwned() {
    const starting = this.#starting
    this.#starting = undefined
    const child = this.#child
    this.#closing = true
    this.#child = undefined
    for (const pending of this.#pending.values()) {
      pending.reject(new HostError('HOST_PROVIDER_REPLACED', 'Capability adapter session was replaced', { retryable: true }))
    }
    this.#pending.clear()

    let cleanupError
    const cleanup = async (action, message) => {
      try {
        await action()
      } catch (error) {
        cleanupError ??= error instanceof HostError && error.code === 'HOST_CLEANUP_FAILED'
          ? error
          : new HostError('HOST_CLEANUP_FAILED', message, { cause: error })
      }
    }

    if (child !== undefined) {
      await cleanup(async () => {
        child.stdin.end()
        if (!(await waitForExit(child, 250))) {
          killProcessGroup(child)
          if (!(await waitForExit(child, 750))) {
            throw new HostError('HOST_CLEANUP_FAILED', 'Capability adapter process did not exit after forced termination')
          }
        }
      }, 'Capability adapter process did not close cleanly')
    }
    await cleanup(() => this.#cleanup, 'Capability adapter replacement cleanup did not finish')
    await cleanup(() => awaitCancelledStartup(starting), 'JSONL session startup cleanup did not finish')
    await cleanup(
      () => this.#releaseLaunchSnapshot(this.#launchSnapshot),
      'JSONL provider launch snapshot was not removed',
    )
    if (cleanupError !== undefined) throw cleanupError
  }
}
