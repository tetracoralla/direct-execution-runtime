import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { revalidatePreparedBinding } from '../config.mjs'
import { boundedMessage, HostError } from '../errors.mjs'
import { digestJson, jsonBytes, snapshotJsonValue } from '../json.mjs'
import { createLaunchSnapshot } from '../launch-snapshot.mjs'
import { prepareMcpOperationProjection, projectMcpOperation } from '../operation-projection.mjs'
import { assertSchema, createValidator } from '../schema.mjs'
import { StrictMcpStdioTransport } from '../strict-mcp-stdio-transport.mjs'

function safeAnnotations(tool) {
  const annotations = tool.annotations ?? {}
  return (
    annotations.readOnlyHint === true &&
    annotations.destructiveHint === false &&
    annotations.idempotentHint === true &&
    annotations.openWorldHint === false
  )
}

function ordinaryObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function valueAtPath(value, path) {
  let current = value
  for (const field of path) {
    if (!ordinaryObject(current) || !Object.hasOwn(current, field)) return undefined
    current = current[field]
  }
  return current
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

async function awaitCancelledStartup(starting) {
  if (starting === undefined) return
  try {
    await starting
  } catch (error) {
    if (error?.code === 'HOST_CLEANUP_FAILED') throw error
  }
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

const MAX_TOOL_CATALOG_PAGES = 1024

async function observeConcurrentStderr() {
  // stdout and stderr are separate pipes. A provider can write stderr before
  // its response while the parent observes the stdout response first. Yield
  // through the I/O phase before accepting the response so a stderr overflow
  // from the same provider turn deterministically poisons that turn.
  await new Promise((resolve) => setImmediate(resolve))
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
  #startupWaiters = 0
  #launchSnapshot

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
    let starting = this.#starting
    if (starting === undefined) {
      if (this.#client !== undefined) return { sessionState: 'warm' }
      starting = (async () => {
        await revalidatePreparedBinding(this.binding)
        if (this.#starting !== starting) {
          throw new HostError('HOST_PROVIDER_REPLACED', 'MCP session startup was replaced', { retryable: true })
        }
        await this.#start(starting)
      })()
      this.#starting = starting
      starting.then(
        () => { if (this.#starting === starting) this.#starting = undefined },
        () => { if (this.#starting === starting) this.#starting = undefined },
      )
    }
    this.#startupWaiters += 1
    let abandoned = false
    try {
      await awaitWithDeadline(starting, options)
    } catch (error) {
      abandoned = error?.code === 'HOST_TIMEOUT' || error?.code === 'HOST_CANCELLED'
      throw error
    } finally {
      this.#startupWaiters -= 1
      // The startup promise can settle in the same event-loop turn as the
      // caller deadline. In that race its completion handler clears
      // #starting before this finally block runs, even though the caller has
      // already timed out. Close the just-created live client as well so an
      // abandoned cold start cannot leave an unowned warm provider behind.
      if (
        abandoned && this.#startupWaiters === 0 &&
        (this.#starting === starting || (this.#starting === undefined && this.#client !== undefined))
      ) {
        await this.close()
      }
    }
    return { sessionState: 'cold' }
  }

  async #start(starting) {
    this.#stderr = Buffer.alloc(0)
    this.#fatalError = undefined
    this.#contractDigest = undefined
    const launchSnapshot = await createLaunchSnapshot(this.binding)
    if (this.#starting !== starting) {
      await this.#releaseLaunchSnapshot(launchSnapshot)
      throw new HostError('HOST_PROVIDER_REPLACED', 'MCP session startup was replaced', { retryable: true })
    }
    this.#launchSnapshot = launchSnapshot
    const environment = await launchSnapshot.prepareEnvironment(getDefaultEnvironment())
    const transport = new StrictMcpStdioTransport({
      command: launchSnapshot.command,
      args: launchSnapshot.args,
      cwd: launchSnapshot.cwd,
      env: environment,
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
    let connected = false
    try {
      await client.connect(transport, {
        timeout: this.binding.limits.defaultTimeoutMs,
        maxTotalTimeout: this.binding.limits.defaultTimeoutMs,
      })
      connected = true
      const serverVersion = snapshotJsonValue(client.getServerVersion(), {
        code: 'HOST_BINDING_INVALID',
        label: 'MCP server identity',
      })
      if (
        serverVersion?.name !== this.binding.expectedServer.name ||
        serverVersion?.version !== this.binding.expectedServer.version
      ) {
        throw new HostError('HOST_BINDING_INVALID', 'Live MCP server identity does not match the configured expected server')
      }
      const catalogTools = []
      const missingTools = new Set(this.binding.allowedTools)
      const seenCursors = new Set()
      let catalogBytes = 0
      let cursor
      let catalogTerminated = false
      for (let page = 0; page < MAX_TOOL_CATALOG_PAGES; page += 1) {
        const listed = snapshotJsonValue(
          await client.listTools(cursor === undefined ? undefined : { cursor }, {
            timeout: this.binding.limits.defaultTimeoutMs,
            maxTotalTimeout: this.binding.limits.defaultTimeoutMs,
          }),
          { code: 'HOST_BINDING_INVALID', label: 'MCP tool catalog page' },
        )
        catalogBytes += jsonBytes({ tools: listed.tools })
        if (catalogBytes > this.binding.limits.maxProviderResponseBytes) {
          throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP tools listing exceeds the configured byte limit')
        }
        for (const tool of listed.tools) {
          catalogTools.push(tool)
          missingTools.delete(tool.name)
        }
        if (listed.nextCursor === undefined || missingTools.size === 0) {
          catalogTerminated = true
          break
        }
        if (
          typeof listed.nextCursor !== 'string' || listed.nextCursor.length === 0 ||
          seenCursors.has(listed.nextCursor)
        ) {
          throw new HostError('HOST_BINDING_INVALID', 'MCP tool catalog pagination did not advance')
        }
        seenCursors.add(listed.nextCursor)
        cursor = listed.nextCursor
      }
      if (!catalogTerminated) {
        throw new HostError('HOST_BINDING_INVALID', 'MCP tool catalog pagination exceeded its page limit')
      }
      this.#catalogBytes = catalogBytes
      const selected = new Map()
      const ajv = createValidator()
      for (const name of this.binding.allowedTools) {
        const tool = catalogTools.find((candidate) => candidate.name === name)
        if (tool === undefined) throw new HostError('HOST_BINDING_INVALID', `Allowed MCP tool ${name} is absent from the live server`)
        if (!safeAnnotations(tool)) {
          throw new HostError('HOST_BINDING_UNSAFE', `MCP tool ${name} is outside the direct read-only execution boundary`)
        }
        if (tool.inputSchema === undefined || tool.outputSchema === undefined) {
          throw new HostError('HOST_BINDING_INVALID', `MCP tool ${name} must advertise input and output schemas`)
        }
        const projectionDeclaration = this.binding.projectionDefinitions.get(name)
        selected.set(name, {
          tool,
          validateInput: projectionDeclaration === undefined ? ajv.compile(tool.inputSchema) : null,
          validateOutput: ajv.compile(tool.outputSchema),
          contractDigest: digestJson({
            serverVersion,
            name: tool.name,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations ?? {},
          }),
          operationProjection: projectionDeclaration === undefined
            ? null
            : prepareMcpOperationProjection(tool, projectionDeclaration),
          compileInput: (schema) => ajv.compile(schema),
          batchProjection: null,
        })
      }
      for (const [batchToolName, declaration] of this.binding.batchProjectionDefinitions) {
        const batch = selected.get(batchToolName)
        const source = selected.get(declaration.toolName)
        const items = batch?.tool.inputSchema?.properties?.[declaration.batchItemsField]
        if (
          batch === undefined || source?.operationProjection === null ||
          items?.type !== 'array' || !items.items
        ) {
          throw new HostError(
            'HOST_BINDING_INVALID',
            `MCP batch projection ${batchToolName} does not expose the declared item array`,
          )
        }
        batch.batchProjection = {
          sourceToolName: declaration.toolName,
          itemsField: declaration.batchItemsField,
        }
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
      const replaced = this.#transport !== transport
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
      await this.#releaseLaunchSnapshot(launchSnapshot)
      if (cleanupError !== undefined) throw cleanupError
      if (this.#fatalError !== undefined) throw this.#fatalError
      if (error instanceof HostError) throw error
      if (replaced) {
        throw new HostError('HOST_PROVIDER_REPLACED', 'MCP session was replaced during startup', {
          cause: error,
          retryable: true,
        })
      }
      throw new HostError(
        connected ? 'HOST_TRANSPORT_ERROR' : 'HOST_PROVIDER_UNAVAILABLE',
        boundedMessage(error instanceof Error ? error.message : String(error)),
        { cause: error, retryable: true },
      )
    }
  }

  async #releaseLaunchSnapshot(snapshot) {
    if (snapshot === undefined) return
    if (this.#launchSnapshot === snapshot) this.#launchSnapshot = undefined
    try {
      await snapshot.dispose()
    } catch (error) {
      throw new HostError('HOST_CLEANUP_FAILED', 'MCP provider launch snapshot was not removed', { cause: error })
    }
  }

  async validateCall(call, options = {}) {
    if (!['mcp-tool', 'mcp-operation'].includes(call.target.kind)) {
      throw new HostError('HOST_BINDING_MISMATCH', 'Call target is not an MCP tool or projected operation')
    }
    await this.ensureStarted(options)
    const selected = this.#tools.get(call.target.toolName)
    if (selected === undefined) throw new HostError('HOST_UNKNOWN_OPERATION', `MCP tool ${call.target.toolName} is not admitted`)
    if (call.target.kind === 'mcp-operation') {
      if (selected.operationProjection === null) {
        throw new HostError('HOST_BINDING_MISMATCH', `MCP tool ${call.target.toolName} has no operation projection`)
      }
      const operationField = selected.operationProjection.declaration.operationField
      if (call.input[operationField] !== call.target.operationId) {
        throw new HostError('HOST_BINDING_MISMATCH', 'Projected MCP target and input operation differ')
      }
      const projected = await this.#projectOperation(selected, call.target.operationId, options)
      assertSchema(projected.validateInput, call.input, 'HOST_INPUT_INVALID', `${call.target.operationId} input`)
      return { ...selected, contractDigest: projected.contractDigest }
    }
    if (selected.operationProjection !== null) {
      throw new HostError(
        'HOST_BINDING_MISMATCH',
        `MCP tool ${call.target.toolName} requires an explicit mcp-operation target`,
      )
    }
    assertSchema(selected.validateInput, call.input, 'HOST_INPUT_INVALID', `${call.target.toolName} input`)
    if (selected.batchProjection !== null) {
      const source = this.#tools.get(selected.batchProjection.sourceToolName)
      const items = call.input[selected.batchProjection.itemsField]
      const itemContracts = []
      for (let index = 0; index < items.length; index += 1) {
        const operationField = source.operationProjection.declaration.operationField
        const operationId = items[index][operationField]
        if (typeof operationId !== 'string') {
          throw new HostError('HOST_INPUT_INVALID', `Batch item ${index} has no operation identity`)
        }
        const projected = await this.#projectOperation(source, operationId, options)
        assertSchema(projected.validateInput, items[index], 'HOST_INPUT_INVALID', `batch item ${index} ${operationId}`)
        itemContracts.push(projected.contractDigest)
      }
      return {
        ...selected,
        contractDigest: digestJson({ batchContract: selected.contractDigest, itemContracts: [...new Set(itemContracts)].sort() }),
      }
    }
    return selected
  }

  async #projectOperation(selected, operationId, options = {}) {
    const prepared = selected.operationProjection
    const cached = prepared.cache.get(operationId)
    if (cached !== undefined) return cached
    if (!prepared.operationIds.has(operationId)) {
      throw new HostError('HOST_UNKNOWN_OPERATION', `Unknown projected MCP operation ${operationId}`)
    }
    let projectionOptions = {}
    if (prepared.branches === null) {
      projectionOptions = await this.#lookupOperationSchema(prepared.declaration.schemaLookup, operationId, options)
    }
    const projected = projectMcpOperation(selected.tool, prepared, operationId, projectionOptions)
    if (projected.validateInput === undefined) {
      projected.validateInput = selected.compileInput(projected.inputSchema)
    }
    return projected
  }

  async #lookupOperationSchema(declaration, operationId, options) {
    const selected = this.#tools.get(declaration.toolName)
    if (selected === undefined || selected.operationProjection !== null) {
      throw new HostError('HOST_BINDING_INVALID', `MCP schema lookup tool ${declaration.toolName} is unavailable`)
    }
    const input = { [declaration.operationField]: operationId }
    assertSchema(selected.validateInput, input, 'HOST_BINDING_INVALID', `${declaration.toolName} schema lookup input`)
    const deadlineAt = options.deadlineAt ?? Date.now() + this.binding.limits.defaultTimeoutMs
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new HostError('HOST_TIMEOUT', 'Call deadline expired before MCP schema lookup')
    let response
    try {
      response = snapshotJsonValue(
        await this.#client.callTool(
          { name: declaration.toolName, arguments: input },
          undefined,
          { signal: options.signal, timeout: remaining, maxTotalTimeout: remaining },
        ),
        { code: 'HOST_PROVIDER_PROTOCOL_ERROR', label: 'MCP schema lookup response' },
      )
      await observeConcurrentStderr()
    } catch (error) {
      const cancelled = options.signal?.aborted === true
      const timeout = !cancelled && Date.now() >= deadlineAt
      const message = error instanceof Error ? error.message : String(error)
      await this.close()
      if (cancelled) throw new HostError('HOST_CANCELLED', 'MCP schema lookup was cancelled', { cause: error })
      if (timeout || /timed? ?out|timeout/i.test(error instanceof Error ? error.message : String(error))) {
        throw new HostError('HOST_TIMEOUT', 'MCP schema lookup exceeded its whole-call deadline', { cause: error, retryable: true })
      }
      if (/structured content does not match.+output schema/iu.test(message)) {
        throw new HostError('HOST_PROVIDER_OUTPUT_INVALID', 'MCP schema lookup returned content outside its advertised output contract', { cause: error })
      }
      throw new HostError('HOST_TRANSPORT_ERROR', boundedMessage(message), {
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
      throw new HostError('HOST_PROVIDER_RESPONSE_TOO_LARGE', 'MCP schema lookup response exceeds the configured byte limit')
    }
    const structured = response.structuredContent
    if (structured === undefined) {
      await this.close()
      throw new HostError('HOST_PROVIDER_PROTOCOL_ERROR', 'MCP schema lookup returned no structuredContent')
    }
    assertSchema(selected.validateOutput, structured, 'HOST_PROVIDER_OUTPUT_INVALID', `${declaration.toolName} output`)
    if (response.isError === true) {
      throw new HostError('HOST_BINDING_INVALID', `MCP schema lookup rejected operation ${operationId}`)
    }
    const argumentsSchema = valueAtPath(structured, declaration.resultPath)
    if (!ordinaryObject(argumentsSchema)) {
      throw new HostError('HOST_BINDING_INVALID', `MCP schema lookup returned no input schema for ${operationId}`)
    }
    this.#lastResponseAt = new Date().toISOString()
    return {
      argumentsSchema,
      schemaLookupContractDigest: selected.contractDigest,
    }
  }

  async projectContract(target, options = {}) {
    await this.ensureStarted(options)
    const selected = this.#tools.get(target.toolName)
    if (selected === undefined) throw new HostError('HOST_UNKNOWN_OPERATION', `MCP tool ${target.toolName} is not admitted`)
    if (target.kind === 'mcp-operation') {
      if (selected.operationProjection === null) {
        throw new HostError('HOST_BINDING_MISMATCH', `MCP tool ${target.toolName} has no operation projection`)
      }
      const projected = await this.#projectOperation(selected, target.operationId, options)
      return {
        inputSchema: structuredClone(projected.inputSchema),
        outputSchema: structuredClone(projected.outputSchema),
        errors: projected.errorSchema === null
          ? null
          : { source: 'tool-output-schema', schema: structuredClone(projected.errorSchema) },
        contractDigest: projected.contractDigest,
        contractSource: 'live-session',
        schemaBytes: projected.schemaBytes,
      }
    }
    if (target.kind !== 'mcp-tool') {
      throw new HostError('HOST_BINDING_MISMATCH', 'Projection target is not an MCP tool')
    }
    if (selected.operationProjection !== null) {
      throw new HostError(
        'HOST_BINDING_MISMATCH',
        `MCP tool ${target.toolName} requires a selected operation before projection`,
      )
    }
    return {
      inputSchema: structuredClone(selected.tool.inputSchema),
      outputSchema: structuredClone(selected.tool.outputSchema),
      errors: null,
      contractDigest: selected.contractDigest,
      contractSource: 'live-session',
      schemaBytes: jsonBytes(selected.tool.inputSchema) + jsonBytes(selected.tool.outputSchema),
    }
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
      response = snapshotJsonValue(
        await this.#client.callTool(
          { name: call.target.toolName, arguments: call.input },
          undefined,
          { signal, timeout: remaining, maxTotalTimeout: remaining },
        ),
        { code: 'HOST_PROVIDER_PROTOCOL_ERROR', label: 'MCP tool response' },
      )
      await observeConcurrentStderr()
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
        contractDigest: selected.contractDigest,
      }
    }
    return {
      ok: true,
      result: structured,
      sessionState,
      providerRoundTripMs: performance.now() - started,
      contractDigest: selected.contractDigest,
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
      projectedOperationContracts: [...this.#tools.values()]
        .reduce((total, selected) => total + (selected.operationProjection?.cache.size ?? 0), 0),
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
    const starting = this.#starting
    this.#starting = undefined
    const client = this.#client
    const transport = this.#transport
    const launchSnapshot = this.#launchSnapshot
    const pid = transport?.pid ?? null
    this.#client = undefined
    this.#transport = undefined
    this.#launchSnapshot = undefined
    this.#tools = new Map()
    this.#serverVersion = undefined
    this.#catalogBytes = 0
    this.#contractAcquiredAt = undefined
    this.#lastResponseAt = undefined
    this.#contractDigest = undefined
    let cleanupError
    try {
      if (client !== undefined) await client.close()
      else if (transport !== undefined) await transport.close()
    } catch (error) {
      cleanupError = new HostError('HOST_CLEANUP_FAILED', 'MCP provider session did not close cleanly', { cause: error })
    }
    try {
      await awaitCancelledStartup(starting)
    } catch (error) {
      cleanupError ??= error instanceof HostError && error.code === 'HOST_CLEANUP_FAILED'
        ? error
        : new HostError('HOST_CLEANUP_FAILED', 'MCP session startup cleanup did not finish', { cause: error })
    }
    if (pid !== null && !(await waitForPidExit(pid))) {
      cleanupError ??= new HostError('HOST_CLEANUP_FAILED', 'MCP provider process remained after session close')
    }
    try {
      await this.#releaseLaunchSnapshot(launchSnapshot)
    } catch (error) {
      cleanupError ??= new HostError('HOST_CLEANUP_FAILED', 'MCP provider launch snapshot was not removed', { cause: error })
    }
    if (cleanupError !== undefined) throw cleanupError
  }
}
