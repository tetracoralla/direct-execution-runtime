#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { DirectExecutionRuntime, prepareRuntimeConfig } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const providerId = 'io.github.tetracoralla.math-anchor'

function usage() {
  return `Usage: npm run demo:math-anchor -- --provider-root /absolute/path/to/math-anchor

Runs one cold direct call, ten warm direct calls, one provider-domain error,
and one host-side schema rejection against a separately installed Math Anchor
checkout. The demo invokes no model and writes no report or provider config.
`
}

function parseArguments(arguments_) {
  let providerRoot
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--provider-root') {
      providerRoot = arguments_[index + 1]
      index += 1
      if (providerRoot === undefined) throw new Error('--provider-root requires a path')
      continue
    }
    if (argument.startsWith('--provider-root=')) {
      providerRoot = argument.slice('--provider-root='.length)
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (providerRoot === undefined || providerRoot.length === 0) {
    throw new Error('--provider-root is required')
  }
  return { help: false, providerRoot }
}

function workOrder(id, expression, extraInput = {}) {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id,
    calls: [{
      id: 'calculation',
      providerId,
      target: {
        kind: 'mcp-operation',
        toolName: 'math.run',
        operationId: 'expression.evaluate',
      },
      input: {
        operation: 'expression.evaluate',
        arguments: { expression },
        ...extraInput,
      },
    }],
  }
}

function elapsedSummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)]
  return {
    samples: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    p50: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    max: Number(sorted.at(-1).toFixed(3)),
  }
}

function resultBytes(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8')
}

async function timed(runtime, order) {
  const started = performance.now()
  const result = await runtime.runWorkOrder(order)
  return {
    elapsedMs: performance.now() - started,
    resultBytes: resultBytes(result),
    result,
  }
}

async function installedProviderVersion(python, projectManifest) {
  const { stdout } = await execFileAsync(python, [
    '-c',
    "import sys, tomllib; print(tomllib.load(open(sys.argv[1], 'rb'))['project']['version'])",
    projectManifest,
  ], { encoding: 'utf8', timeout: 10_000 })
  const version = stdout.trim()
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version)) {
    throw new Error('Math Anchor project returned an invalid provider version')
  }
  return version
}

function assertCall(result, expectedStatus, expectedCode) {
  const call = result.calls[0]
  if (call?.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, received ${call?.status ?? 'no call result'}`)
  }
  if (expectedCode !== undefined && call.error?.code !== expectedCode) {
    throw new Error(`Expected ${expectedCode}, received ${call.error?.code ?? 'no error code'}`)
  }
  return call
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(usage())
    return
  }

  const root = await realpath(resolve(arguments_.providerRoot))
  const command = resolve(root, '.venv/bin/math-anchor-mcp')
  const python = resolve(root, '.venv/bin/python')
  const serverSource = resolve(root, 'src/math_anchor/mcp_server.py')
  const projectManifest = resolve(root, 'pyproject.toml')
  await Promise.all([command, python, serverSource, projectManifest].map((path) => access(path)))
  const expectedServerVersion = await installedProviderVersion(python, projectManifest)

  const prepared = await prepareRuntimeConfig({
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    limits: {
      maxConcurrentCalls: 2,
      maxQueuedCalls: 8,
      maxWorkOrderCalls: 16,
      maxWorkOrderBytes: 262144,
      maxProviderResponseBytes: 262144,
      maxResultBytes: 524288,
      maxProtocolLineBytes: 1048576,
      maxStderrBytes: 32768,
      defaultTimeoutMs: 15000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 1000,
    },
    providers: [{
      providerId,
      transport: 'mcp-stdio',
      lifecycle: 'persistent',
      rootPath: root,
      command,
      args: [],
      cwd: root,
      identityFiles: [command, serverSource, projectManifest],
      expectedServer: { name: 'Math Anchor', version: expectedServerVersion },
      allowedTools: ['math.run', 'math.batch'],
      operationProjections: [{
        toolName: 'math.run',
        operationField: 'operation',
        argumentsField: 'arguments',
        batchToolName: 'math.batch',
        batchItemsField: 'items',
      }],
    }],
  })

  const runtime = new DirectExecutionRuntime(prepared)
  try {
    const cold = await timed(runtime, workOrder('cold-direct', '6*7'))
    const coldCall = assertCall(cold.result, 'ok')
    if (coldCall.result?.exact !== '42') throw new Error('Math Anchor exact result was not 42')

    const warmSamples = []
    const warmBytes = []
    for (let index = 0; index < 10; index += 1) {
      const warm = await timed(runtime, workOrder(`warm-direct-${index}`, '6*7'))
      const call = assertCall(warm.result, 'ok')
      if (call.result?.exact !== '42') throw new Error('Warm Math Anchor exact result was not 42')
      warmSamples.push(warm.elapsedMs)
      warmBytes.push(warm.resultBytes)
    }

    const providerError = await timed(runtime, workOrder('provider-error', 'unknown_name'))
    assertCall(providerError.result, 'provider_error', 'E_NAME')

    const hostRejection = await timed(runtime, workOrder('host-rejection', '6*7', { unexpected: true }))
    assertCall(hostRejection.result, 'host_error', 'HOST_INPUT_INVALID')

    const binding = (await runtime.inspectBindings()).providers[0]
    const report = {
      schemaVersion: 'openadam.direct-public-demo-observation.v0.1',
      observedAt: new Date().toISOString(),
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      scope: {
        route: 'direct-host',
        provider: 'Math Anchor',
        providerId,
        carrier: 'stdio MCP',
        liveServer: binding.live?.serverVersion ?? null,
        modelCallsInsideRuntime: 0,
        tokenUsage: null,
        monetaryCost: null,
        agentRoute: 'not_run',
      },
      semanticChecks: {
        exactResult: { status: coldCall.status, exact: coldCall.result.exact },
        providerError: {
          status: providerError.result.calls[0].status,
          code: providerError.result.calls[0].error.code,
          retryable: providerError.result.calls[0].error.retryable ?? null,
        },
        hostSchemaRejection: {
          status: hostRejection.result.calls[0].status,
          code: hostRejection.result.calls[0].error.code,
        },
      },
      measurements: {
        coldDirect: {
          samples: 1,
          latencyMs: Number(cold.elapsedMs.toFixed(3)),
          resultBytes: cold.resultBytes,
        },
        warmDirect: {
          latencyMs: elapsedSummary(warmSamples),
          resultBytes: elapsedSummary(warmBytes),
        },
      },
      interpretation: {
        establishes: [
          'this runtime invocation used no model',
          'the selected live MCP schema rejected an unknown input field before execution',
          'the provider result and provider-owned E_NAME error remained distinguishable from a host error',
          'one persistent runtime reused the provider session for the warm calls',
        ],
        doesNotEstablish: [
          'Agent routing quality or token savings',
          'a universal latency or cost improvement',
          'production capacity, security isolation, or cross-provider substitution',
        ],
      },
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await runtime.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n\n${usage()}`)
  process.exitCode = 1
})
