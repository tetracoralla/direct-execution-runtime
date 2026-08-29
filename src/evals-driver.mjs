#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { boundedMessage, HostError } from './errors.mjs'
import { EVALS_DRIVER_ID, EVALS_DRIVER_VERSION } from './evals-driver-identity.mjs'
import { requestDirectHost } from './host-client.mjs'
import { decodeUtf8Strict, parseStrictJson } from './json.mjs'
import { assertSchema, createValidator, loadBundledSchema } from './schema.mjs'

const MAX_REQUEST_BYTES = 1024 * 1024
const RUNTIME_MAX_TIMEOUT_MS = 300_000

function usage() {
  return `Usage:
  openadam-direct-evals-driver --socket PATH --provider-id ID --provider-version VERSION \\
    --target-id ID --target-version VERSION --target-kind capability|procedure|mcp-tool|mcp-operation \\
    --operation-id ID [--capability-id ID --capability-version VERSION] \\
    [--procedure-id ID --procedure-version VERSION] [--tool-name NAME]`
}

function parseArguments(argv) {
  const names = new Set([
    '--socket', '--provider-id', '--provider-version', '--target-id', '--target-version',
    '--target-kind', '--operation-id', '--capability-id', '--capability-version',
    '--procedure-id', '--procedure-version', '--tool-name',
  ])
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.has(name) || value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new HostError('HOST_EVAL_DRIVER_USAGE', usage())
    }
    const key = name.slice(2).replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (options[key] !== undefined) throw new HostError('HOST_EVAL_DRIVER_USAGE', `${name} may appear only once`)
    options[key] = value
  }
  for (const required of [
    'socket', 'providerId', 'providerVersion', 'targetId', 'targetVersion', 'targetKind', 'operationId',
  ]) {
    if (options[required] === undefined) throw new HostError('HOST_EVAL_DRIVER_USAGE', usage())
  }
  if (!isAbsolute(options.socket)) throw new HostError('HOST_EVAL_DRIVER_USAGE', '--socket must be absolute')
  if (!['capability', 'procedure', 'mcp-tool', 'mcp-operation'].includes(options.targetKind)) {
    throw new HostError('HOST_EVAL_DRIVER_USAGE', '--target-kind is invalid')
  }
  const hasCapability = options.capabilityId !== undefined || options.capabilityVersion !== undefined
  const hasProcedure = options.procedureId !== undefined || options.procedureVersion !== undefined
  const hasToolName = options.toolName !== undefined
  if (
    (options.targetKind === 'capability' && (!options.capabilityId || !options.capabilityVersion || hasProcedure || hasToolName)) ||
    (options.targetKind === 'procedure' && (!options.procedureId || !options.procedureVersion || hasCapability || hasToolName)) ||
    (options.targetKind === 'mcp-tool' && (hasCapability || hasProcedure || hasToolName)) ||
    (options.targetKind === 'mcp-operation' && (hasCapability || hasProcedure || !hasToolName))
  ) {
    throw new HostError('HOST_EVAL_DRIVER_USAGE', 'Semantic identity arguments do not match --target-kind')
  }
  return options
}

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_REQUEST_BYTES) throw new HostError('HOST_INPUT_TOO_LARGE', 'Evaluator request exceeds one MiB')
    chunks.push(chunk)
  }
  const request = parseStrictJson(decodeUtf8Strict(Buffer.concat(chunks), 'evaluator request'), 'evaluator request')
  const validate = createValidator().compile(await loadBundledSchema('evals-direct-driver-request.schema.json'))
  assertSchema(validate, request, 'HOST_EVAL_REQUEST_INVALID', 'evaluator request')
  return request
}

function expectedSemanticRef(options) {
  if (options.targetKind === 'capability') {
    return { key: 'targetCapability', value: { id: options.capabilityId, version: options.capabilityVersion } }
  }
  if (options.targetKind === 'procedure') {
    return { key: 'targetProcedure', value: { id: options.procedureId, version: options.procedureVersion } }
  }
  return undefined
}

function assertPinnedRequest(request, options) {
  if (!isDeepStrictEqual(request.driverRef, { id: EVALS_DRIVER_ID, version: EVALS_DRIVER_VERSION })) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Evaluator driver identity is not pinned to this implementation')
  }
  if (!isDeepStrictEqual(request.providerRef, { id: options.providerId, version: options.providerVersion })) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Evaluator provider identity differs from the configured driver binding')
  }
  if (!isDeepStrictEqual(request.target, { id: options.targetId, version: options.targetVersion })) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Evaluator target identity differs from the configured driver binding')
  }
  if (request.task.invocation.operationId !== options.operationId) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Evaluator operation differs from the configured driver binding')
  }
  const semantic = expectedSemanticRef(options)
  if (semantic === undefined) {
    if (request.targetCapability !== undefined || request.targetProcedure !== undefined) {
      throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'MCP evaluation request contains an unexpected semantic reference')
    }
  } else if (
    !isDeepStrictEqual(request[semantic.key], semantic.value) ||
    request[semantic.key === 'targetCapability' ? 'targetProcedure' : 'targetCapability'] !== undefined
  ) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Evaluator semantic identity differs from the configured driver binding')
  }
  if (request.budget.timeoutMs > RUNTIME_MAX_TIMEOUT_MS) {
    throw new HostError('HOST_EVAL_BUDGET_UNSUPPORTED', `Runtime call deadline cannot exceed ${RUNTIME_MAX_TIMEOUT_MS} milliseconds`)
  }
}

function workTarget(options) {
  if (options.targetKind === 'capability') {
    return {
      kind: 'capability',
      capabilityId: options.capabilityId,
      capabilityVersion: options.capabilityVersion,
      operationId: options.operationId,
    }
  }
  if (options.targetKind === 'procedure') {
    return { kind: 'procedure', procedureId: options.procedureId, procedureVersion: options.procedureVersion }
  }
  if (options.targetKind === 'mcp-operation') {
    return { kind: 'mcp-operation', toolName: options.toolName, operationId: options.operationId }
  }
  return { kind: 'mcp-tool', toolName: options.operationId }
}

function runtimeIdentity(request) {
  return {
    driver: request.driverRef,
    provider: request.providerRef,
    target: request.target,
    ...(request.targetCapability === undefined ? {} : { capability: request.targetCapability }),
    ...(request.targetProcedure === undefined ? {} : { procedure: request.targetProcedure }),
  }
}

function providerError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : 'PROVIDER_ERROR'
  return {
    code,
    message: boundedMessage(error?.message ?? 'Provider reported an error', 1900),
    retryable: error?.retryable === true,
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const request = await readRequest()
  assertPinnedRequest(request, options)
  const suffix = createHash('sha256').update(`${request.runId}\0${request.task.id}\0${request.repeat}`).digest('hex').slice(0, 24)
  const result = await requestDirectHost({
    socketPath: options.socket,
    action: 'run',
    timeoutMs: Math.min(600_000, request.budget.timeoutMs + 5_000),
    workOrder: {
      schemaVersion: 'openadam.direct-work-order.v0.1',
      id: `eval-${suffix}`,
      calls: [{
        id: `eval-${suffix}`,
        providerId: options.providerId,
        target: workTarget(options),
        input: request.task.invocation.input,
        timeoutMs: request.budget.timeoutMs,
      }],
    },
  })
  const call = result.calls?.[0]
  if (result.calls?.length !== 1 || call?.providerId !== options.providerId) {
    throw new HostError('HOST_EVAL_PROTOCOL_ERROR', 'Host result does not contain the single correlated evaluation call')
  }
  if (call.binding?.providerVersion !== options.providerVersion || call.binding?.digest !== options.targetVersion) {
    throw new HostError('HOST_EVAL_IDENTITY_MISMATCH', 'Observed provider binding does not match the evaluation plan identity')
  }
  if (call.status === 'host_error') {
    throw new HostError(call.error.code, call.error.message, { retryable: call.error.retryable })
  }
  const output = {
    schemaVersion: 'openadam.agent-tool-eval.direct-driver-result.v0.1',
    executionMode: 'direct-host',
    runId: request.runId,
    taskId: request.task.id,
    repeat: request.repeat,
    status: call.status === 'ok' ? 'success' : 'error',
    ...(call.status === 'ok' ? { answer: call.result } : { error: providerError(call.error) }),
    runtime: runtimeIdentity(request),
  }
  const validate = createValidator().compile(await loadBundledSchema('evals-direct-driver-result.schema.json'))
  assertSchema(validate, output, 'HOST_EVAL_RESULT_INVALID', 'evaluator result')
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

main().catch((error) => {
  const code = typeof error?.code === 'string' ? error.code : 'HOST_EVAL_DRIVER_FAILURE'
  process.stderr.write(`${JSON.stringify({ code, message: boundedMessage(error?.message ?? String(error)) })}\n`)
  process.exitCode = 1
})
