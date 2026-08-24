import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
export const fakeRoot = resolve(repositoryRoot, 'test/fixtures/fake-capability')
export const fakeMcpRoot = resolve(repositoryRoot, 'test/fixtures/fake-mcp')

export function fakeConfig(overrides = {}) {
  const limits = {
    maxConcurrentCalls: 2,
    maxQueuedCalls: 4,
    maxWorkOrderCalls: 16,
    maxWorkOrderBytes: 262144,
    maxProviderResponseBytes: 65536,
    maxResultBytes: 262144,
    maxProtocolLineBytes: 1048576,
    maxStderrBytes: 4096,
    defaultTimeoutMs: 1000,
    circuitBreakerFailureThreshold: 3,
    circuitBreakerCooldownMs: 50,
    ...(overrides.limits ?? {}),
  }
  return {
    schemaVersion: 'openadam.direct-provider-config.v0.1',
    limits,
    providers: [{
      providerId: 'test.fake-capability',
      transport: 'capability-jsonl-v0.1',
      lifecycle: overrides.lifecycle ?? 'persistent',
      rootPath: fakeRoot,
      manifestPath: overrides.manifestPath ?? resolve(fakeRoot, 'provider.json'),
      identityFiles: overrides.identityFiles ?? [resolve(fakeRoot, 'adapter.mjs')],
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      contracts: [{
        operationId: 'echo',
        inputSchemaPath: resolve(fakeRoot, 'echo.input.schema.json'),
        outputSchemaPath: resolve(fakeRoot, 'echo.output.schema.json'),
      }],
    }],
  }
}

export function fakeProcedureConfig(overrides = {}) {
  const config = fakeConfig(overrides)
  config.providers = [{
    providerId: 'test.fake-procedure',
    transport: 'procedure-jsonl-v0.2',
    lifecycle: overrides.lifecycle ?? 'persistent',
    rootPath: fakeRoot,
    profilePath: resolve(fakeRoot, 'procedure-profile.json'),
    implementationManifestPath: resolve(fakeRoot, 'procedure-manifest.json'),
    identityFiles: overrides.identityFiles ?? [resolve(fakeRoot, 'procedure-adapter.mjs')],
    procedureId: 'org.openadam.test.echo-procedure',
    procedureVersion: '0.1.0',
    inputSchemaPath: resolve(fakeRoot, 'echo.input.schema.json'),
    outputSchemaPath: resolve(fakeRoot, 'echo.output.schema.json'),
  }]
  return config
}

export function fakeMcpConfig(overrides = {}) {
  const config = fakeConfig(overrides)
  const serverPath = resolve(fakeMcpRoot, 'server.mjs')
  config.providers = [{
    providerId: 'test.fake-mcp',
    transport: 'mcp-stdio',
    lifecycle: overrides.lifecycle ?? 'persistent',
    rootPath: fakeMcpRoot,
    command: serverPath,
    args: overrides.args ?? [],
    cwd: overrides.cwd ?? fakeMcpRoot,
    identityFiles: overrides.identityFiles ?? [serverPath],
    expectedServer: { name: 'direct-execution-fake-mcp', version: '0.1.0' },
    allowedTools: ['echo'],
  }]
  return config
}

export function fakeCall(id, input, timeoutMs) {
  const call = {
    id,
    providerId: 'test.fake-capability',
    target: {
      kind: 'capability',
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      operationId: 'echo',
    },
    input,
  }
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return call
}

export function fakeProcedureCall(id, input, timeoutMs) {
  const call = {
    id,
    providerId: 'test.fake-procedure',
    target: {
      kind: 'procedure',
      procedureId: 'org.openadam.test.echo-procedure',
      procedureVersion: '0.1.0',
    },
    input,
  }
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return call
}

export function fakeMcpCall(id, input, timeoutMs) {
  const call = {
    id,
    providerId: 'test.fake-mcp',
    target: { kind: 'mcp-tool', toolName: 'echo' },
    input,
  }
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return call
}

export function workOrder(id, calls) {
  return { schemaVersion: 'openadam.direct-work-order.v0.1', id, calls }
}
