import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { boundedMessage, HostError } from '../errors.mjs'
import { digestJson, jsonBytes } from '../json.mjs'
import { assertSchema, createValidator } from '../schema.mjs'

function safeAnnotations(tool) {
  const annotations = tool.annotations ?? {}
  return (
    annotations.readOnlyHint === true &&
    annotations.destructiveHint === false &&
    annotations.idempotentHint === true &&
    annotations.openWorldHint === false
  )
}

async function awaitWithDeadline(promise, { signal, deadlineAt } = {}) {
  if (signal?.aborted) throw new HostError('HOST_CANCELLED', 'MCP session startup wait was cancelled')
  if (deadlineAt === undefined) return await promise
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new HostError('HOST_TIMEOUT', 'Call deadline expired during MCP session startup')
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settle(reject, new HostError('HOST_TIMEOUT', 'Call deadline expired during MCP session startup', { retryable: true })),
      remaining,
    )
    const abort = () => settle(reject, new HostError('HOST_CANCELLED', 'MCP session startup wait was cancelled'))
    const settle = (method, value) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      method(value)
    }
    signal?.addEventListener('abort', abort, { once: true })
    promise.then((value) => settle(resolve, value), (error) => settle(reject, error))
  })
}

function pidExists(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForPidExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !pidExists(pid)
}

export class McpSession {
  #client
  #transport
  #tools = new Map()
  #stderr = Buffer.alloc(0)
  #generation = 0
  #serverVersion
  #starting
  #catalogBytes = 0
  #contractAcquiredAt
  #lastResponseAt
  #contractDigest
  #fatalError
  #closing

  constructor(binding) {
    this.binding = binding
  }

  get pid() {
    return this.#transport?.pid ?? null
  }

  get generation() {
    return this.#generation
  }

  async ensureStarted(options = {}) {
    if (this.#starting !== undefined) {
      try {
        await awaitWithDeadline(this.#starting, options)
      } catch (error) {
        if (error?.code === 'HOST_TIMEOUT' || error?.code === 'HOST_CANCELLED') await this.close()
        throw error
      }
      return { sessionState: 'cold' }
    }
    if (this.#client !== undefined) return { sessionState: 'warm' }
    const starting = this.#start()
    this.#starting = starting
    starting.then(
      () => { if (this.#starting === starting) this.#starting = undefined },
      () => { if (this.#starting === starting) this.#starting = undefined },
    )
    try {
      await awaitWithDeadline(starting, options)
    } catch (error) {
      if (error?.code === 'HOST_TIMEOUT' || error?.code === 'HOST_CANCELLED') await this.close()
      throw error
    }
    return { sessionState: 'cold' }
  }

  async #start() {
    this.#stderr = Buffer.alloc(0)
    this.#fatalError = undefined
    this.#contractDigest = undefined
    const transport = new StdioClientTransport({
      command: this.binding.command,
      args: this.binding.args,
      cwd: this.binding.cwd,
      stderr: 'pipe',
      maxBufferSize: this.binding.limits.maxProviderResponseBytes,
    })
    this.#transport = transport
    transport.stderr?.on('data', (chunk) => {
      if (this.#transport !== transport) return
      this.#stderr = Buffer.concat([this.#stderr, chunk])
      if (this.#stderr.length > this.binding.limits.maxStderrBytes) {
        this.#fatalError = new HostError('HOST_PROVIDER_STDERR_LIMIT', 'MCP provider exceeded the stderr byte limit')
        void this.close().catch((error) => {
          this.#fatalError = error instanceof HostError
            ? error
            : new HostError('HOST_CLEANUP_FAILED', 'MCP provider did not close after stderr overflow', { cause: error })
        })
      }
    })
    const client = new Client({ name: 'openadam-direct-execution-runtime', version: '0.1.0' })
    try {
      await client.connect(transport, {
        timeout: this.binding.limits.defaultTimeoutMs,
        maxTotalTimeout: this.binding.limits.defaultTimeoutMs,
      })
      const serverVersion = client.getServerVersion()
      if (
        serverVersion?.name !== this.binding.expectedServer.name ||
        serverVersion?.version !== this.binding.expectedServer.version
      ) {
        throw new HostError('HOST_BINDING_INVALID', 'Live MCP server identity does not match the configured expected server')
      }
      const listed = await client.listTools(undefined, {
        timeout: this.binding.limits.defaultTimeoutMs,
        maxTotalTimeout: this.binding.limits.defaultTimeoutMs,
      })
      this.#catalogBytes = jsonBytes(listed)
      if (this.#catalogBytes > this.binding.limits.maxProviderResponseBytes) {
        throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP tools listing exceeds the configured byte limit')
      }
      const selected = new Map()
      const ajv = createValidator()
      for (const name of this.binding.allowedTools) {
        const tool = listed.tools.find((candidate) => candidate.name === name)
        if (tool === undefined) throw new HostError('HOST_BINDING_INVALID', `Allowed MCP tool ${name} is absent from the live server`)
        if (!safeAnnotations(tool)) {
          throw new HostError('HOST_BINDING_UNSAFE', `MCP tool ${name} is outside the v0.1 read-only execution boundary`)
        }
        if (tool.inputSchema === undefined || tool.outputSchema === undefined) {
          throw new HostError('HOST_BINDING_INVALID', `MCP tool ${name} must advertise input and output schemas`)
        }
        selected.set(name, {
          tool,
          validateInput: ajv.compile(tool.inputSchema),
          validateOutput: ajv.compile(tool.outputSchema),
        })
      }
      if (this.#transport !== transport) {
        await client.close().catch(() => {})
        throw new HostError('HOST_PROVIDER_REPLACED', 'MCP session was replaced during startup', { retryable: true })
      }
      this.#client = client
      this.#tools = selected
      this.#contractDigest = digestJson({
        serverVersion,
        tools: [...selected.values()].map(({ tool }) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations ?? {},
        })),
      })
      this.#generation += 1
      this.#serverVersion = serverVersion
      this.#contractAcquiredAt = new Date().toISOString()
      this.#lastResponseAt = undefined
    } catch (error) {
      const pid = transport.pid
      let cleanupError
      try {
        await client.close()
      } catch (closeError) {
        cleanupError = new HostError('HOST_CLEANUP_FAILED', 'MCP provider failed during startup cleanup', { cause: closeError })
      }
      if (cleanupError === undefined && pid !== null && !(await waitForPidExit(pid))) {
        cleanupError = new HostError('HOST_CLEANUP_FAILED', 'MCP provider process remained after failed startup')
      }
      if (this.#transport === transport) this.#transport = undefined
      if (cleanupError !== undefined) throw cleanupError
      throw this.#fatalError ?? error
    }
  }

  async validateCall(call, options = {}) {
    if (call.target.kind !== 'mcp-tool') {
      throw new HostError('HOST_BINDING_MISMATCH', 'Call target is not an MCP tool')
    }
    await this.ensureStarted(options)
    const selected = this.#tools.get(call.target.toolName)
    if (selected === undefined) throw new HostError('HOST_UNKNOWN_OPERATION', `MCP tool ${call.target.toolName} is not admitted`)
    assertSchema(selected.validateInput, call.input, 'HOST_INPUT_INVALID', `${call.target.toolName} input`)
    return selected
  }

  async invoke(call, { signal, deadlineAt }) {
    const beforeGeneration = this.#generation
    const selected = await this.validateCall(call, { signal, deadlineAt })
    const sessionState = beforeGeneration === this.#generation ? 'warm' : 'cold'
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new HostError('HOST_TIMEOUT', 'Call deadline expired before MCP invocation')
    const started = performance.now()
    let response
    try {
      response = await this.#client.callTool(
        { name: call.target.toolName, arguments: call.input },
        undefined,
        { signal, timeout: remaining, maxTotalTimeout: remaining },
      )
    } catch (error) {
      const cancelled = signal?.aborted === true
      const timeout = !cancelled && Date.now() >= deadlineAt
      const fatal = this.#fatalError
      await this.close()
      if (fatal !== undefined) throw fatal
      if (cancelled) throw new HostError('HOST_CANCELLED', 'MCP call was cancelled', { cause: error })
      if (timeout || /timed? ?out|timeout/i.test(error instanceof Error ? error.message : String(error))) {
        throw new HostError('HOST_TIMEOUT', 'MCP call exceeded its whole-call deadline', { cause: error, retryable: true })
      }
      throw new HostError('HOST_TRANSPORT_ERROR', boundedMessage(error instanceof Error ? error.message : String(error)), {
        cause: error,
        retryable: true,
      })
    }
    if (this.#fatalError !== undefined) {
      const fatal = this.#fatalError
      await this.close()
      throw fatal
    }
    if (jsonBytes(response) > this.binding.limits.maxProviderResponseBytes) {
      await this.close()
      throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP response exceeds the configured byte limit')
    }
    this.#lastResponseAt = new Date().toISOString()
    const structured = response.structuredContent
    if (structured === undefined) {
      await this.close()
      throw new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'MCP tool returned no structuredContent')
    }
    try {
      assertSchema(selected.validateOutput, structured, 'HOST_PROVIDER_OUTPUT_INVALID', `${call.target.toolName} output`)
    } catch (error) {
      await this.close()
      throw error
    }
    if (response.isError === true) {
      const error = structured.error ?? {
        code: 'MCP_TOOL_ERROR',
        message: response.content?.find((item) => item.type === 'text')?.text ?? 'MCP tool failed',
      }
      return {
        ok: false,
        error,
        sessionState,
        providerRoundTripMs: performance.now() - started,
        contractDigest: this.#contractDigest,
      }
    }
    return {
      ok: true,
      result: structured,
      sessionState,
      providerRoundTripMs: performance.now() - started,
      contractDigest: this.#contractDigest,
    }
  }

  observation() {
    return {
      serverVersion: this.#serverVersion ?? null,
      tools: [...this.#tools.keys()],
      catalogBytes: this.#catalogBytes,
      contractAcquiredAt: this.#contractAcquiredAt ?? null,
      lastResponseAt: this.#lastResponseAt ?? null,
      pid: this.pid,
      generation: this.#generation,
      liveContractDigest: this.#contractDigest ?? null,
    }
  }

  async close() {
    if (this.#closing !== undefined) return await this.#closing
    const closing = this.#closeOwned()
    this.#closing = closing
    try {
      await closing
    } finally {
      if (this.#closing === closing) this.#closing = undefined
    }
  }

  async #closeOwned() {
    const client = this.#client
    const transport = this.#transport
    const pid = transport?.pid ?? null
    this.#client = undefined
    this.#transport = undefined
    this.#tools = new Map()
    this.#serverVersion = undefined
    this.#catalogBytes = 0
    this.#contractAcquiredAt = undefined
    this.#lastResponseAt = undefined
    this.#contractDigest = undefined
    try {
      if (client !== undefined) await client.close()
      else if (transport !== undefined) await transport.close()
    } catch (error) {
      throw new HostError('HOST_CLEANUP_FAILED', 'MCP provider session did not close cleanly', { cause: error })
    }
    if (pid !== null && !(await waitForPidExit(pid))) {
      throw new HostError('HOST_CLEANUP_FAILED', 'MCP provider process remained after session close')
    }
  }
}
