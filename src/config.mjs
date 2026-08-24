import { access, constants, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { HostError } from './errors.mjs'
import { digestFile, digestJson, parseStrictJson, readStrictJsonFile } from './json.mjs'
import { assertSchema, createValidator, loadBundledSchema } from './schema.mjs'

const CONFIG_FILE_LIMIT = 1024 * 1024

export const DEFAULT_LIMITS = Object.freeze({
  maxConcurrentCalls: 4,
  maxQueuedCalls: 32,
  maxWorkOrderCalls: 64,
  maxWorkOrderBytes: 256 * 1024,
  maxProviderResponseBytes: 256 * 1024,
  maxResultBytes: 512 * 1024,
  maxProtocolLineBytes: 1024 * 1024,
  maxStderrBytes: 32 * 1024,
  defaultTimeoutMs: 10_000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 1_000,
})

let validateConfig
let validateProviderManifest
let validateProviderManifestV02
let validateProcedureProfile
let validateProcedureManifest

async function configValidator() {
  if (validateConfig === undefined) {
    validateConfig = createValidator().compile(await loadBundledSchema('provider-config.schema.json'))
  }
  return validateConfig
}

async function providerManifestValidator() {
  if (validateProviderManifest === undefined) {
    validateProviderManifest = createValidator().compile(await loadBundledSchema('provider-manifest.schema.v0.1.json'))
  }
  return validateProviderManifest
}

async function providerManifestV02Validator() {
  if (validateProviderManifestV02 === undefined) {
    validateProviderManifestV02 = createValidator().compile(
      await loadBundledSchema('provider-manifest.schema.v0.2.json'),
    )
  }
  return validateProviderManifestV02
}

async function procedureProfileValidator() {
  if (validateProcedureProfile === undefined) {
    validateProcedureProfile = createValidator().compile(await loadBundledSchema('procedure-profile.schema.v0.3.json'))
  }
  return validateProcedureProfile
}

async function procedureManifestValidator() {
  if (validateProcedureManifest === undefined) {
    validateProcedureManifest = createValidator().compile(
      await loadBundledSchema('procedure-implementation-manifest.schema.v0.4.json'),
    )
  }
  return validateProcedureManifest
}

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function realContainedPath(root, candidate, label, executable = false) {
  if (!isAbsolute(candidate)) throw new HostError('HOST_CONFIG_INVALID', `${label} must be absolute`)
  const resolved = await realpath(candidate).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', `${label} does not exist: ${candidate}`, { cause: error })
  })
  if (!inside(root, resolved)) {
    throw new HostError('HOST_CONFIG_INVALID', `${label} escapes provider root`)
  }
  const info = await stat(resolved)
  if (!info.isFile() && label !== 'provider cwd' && label !== 'provider root') {
    throw new HostError('HOST_CONFIG_INVALID', `${label} is not a file`)
  }
  if (executable) {
    await access(resolved, constants.X_OK).catch((error) => {
      throw new HostError('HOST_PROVIDER_UNAVAILABLE', `${label} is not executable`, { cause: error })
    })
  }
  return resolved
}

async function realRoot(path) {
  if (!isAbsolute(path)) throw new HostError('HOST_CONFIG_INVALID', 'provider rootPath must be absolute')
  const root = await realpath(path).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', `provider root does not exist: ${path}`, { cause: error })
  })
  if (!(await stat(root)).isDirectory()) throw new HostError('HOST_CONFIG_INVALID', 'provider root is not a directory')
  return root
}

async function realRegularPath(path, label) {
  if (!isAbsolute(path)) throw new HostError('HOST_CONFIG_INVALID', `${label} must be absolute`)
  const resolved = await realpath(path).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', `${label} does not exist: ${path}`, { cause: error })
  })
  if (!(await stat(resolved)).isFile()) throw new HostError('HOST_CONFIG_INVALID', `${label} is not a regular file`)
  return resolved
}

async function identityDigests(rootPath, paths, label) {
  const identities = []
  for (const path of paths) {
    const resolved = await realContainedPath(rootPath, path, label)
    identities.push({
      path: relative(rootPath, resolved) || '.',
      digest: await digestFile(resolved),
    })
  }
  return identities.sort((left, right) => left.path.localeCompare(right.path))
}

async function resolveExecutable(command, cwd) {
  if (command.includes('/')) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command)
    await access(candidate, constants.X_OK).catch((error) => {
      throw new HostError('HOST_PROVIDER_UNAVAILABLE', `adapter executable is unavailable: ${command}`, { cause: error })
    })
    return await realpath(candidate)
  }
  const safePath = getDefaultEnvironment().PATH ?? process.env.PATH ?? ''
  for (const directory of safePath.split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = resolve(directory, command)
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      // Continue across the bounded PATH entries.
    }
  }
  throw new HostError('HOST_PROVIDER_UNAVAILABLE', `adapter executable is unavailable on the safe PATH: ${command}`)
}

function requireSafeAnnotations(binding, operationId) {
  const annotations = binding.annotations ?? {}
  if (
    annotations.readOnlyHint !== true ||
    annotations.destructiveHint !== false ||
    annotations.idempotentHint !== true ||
    annotations.openWorldHint !== false
  ) {
    throw new HostError(
      'HOST_BINDING_UNSAFE',
      `Capability operation ${operationId} is outside the v0.1 read-only execution boundary`,
    )
  }
}

async function prepareCapabilityProvider(provider, limits) {
  const rootPath = await realRoot(provider.rootPath)
  const manifestPath = await realContainedPath(rootPath, provider.manifestPath, 'provider manifest')
  const manifest = await readStrictJsonFile(manifestPath, CONFIG_FILE_LIMIT, 'provider manifest')
  if (manifest.schemaVersion === 'openadam.provider-manifest.v0.1') {
    assertSchema(await providerManifestValidator(), manifest, 'HOST_BINDING_INVALID', 'Provider Manifest')
  } else if (manifest.schemaVersion === 'openadam.provider-manifest.v0.2') {
    assertSchema(await providerManifestV02Validator(), manifest, 'HOST_BINDING_INVALID', 'Provider Manifest')
  } else {
    throw new HostError('HOST_BINDING_INVALID', 'Unsupported Provider Manifest schemaVersion')
  }
  if (manifest.provider?.id !== provider.providerId) {
    throw new HostError('HOST_BINDING_INVALID', 'Configured providerId does not match the Provider Manifest')
  }
  const implementationIdentities = manifest.implementations.map(
    (candidate) => `${candidate.capabilityId}@${candidate.capabilityVersion}`,
  )
  if (new Set(implementationIdentities).size !== implementationIdentities.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Provider Manifest contains duplicate Capability implementation identities')
  }
  const implementation = manifest.implementations?.find(
    (candidate) =>
      candidate.capabilityId === provider.capabilityId &&
      candidate.capabilityVersion === provider.capabilityVersion,
  )
  if (implementation === undefined) {
    throw new HostError('HOST_BINDING_INVALID', 'Configured Capability identity is absent from the Provider Manifest')
  }
  if (implementation.adapter?.protocol !== 'openadam.capability-jsonl.v0.1') {
    throw new HostError('HOST_BINDING_INVALID', 'Capability adapter protocol is not openadam.capability-jsonl.v0.1')
  }
  const boundOperationIds = implementation.bindings.map((binding) => binding.operationId)
  if (new Set(boundOperationIds).size !== boundOperationIds.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Provider Manifest contains duplicate operation bindings')
  }
  if (manifest.schemaVersion === 'openadam.provider-manifest.v0.2') {
    const adapterOperationIds = implementation.adapterBindings.map((binding) => binding.operationId)
    if (new Set(adapterOperationIds).size !== adapterOperationIds.length) {
      throw new HostError('HOST_BINDING_INVALID', 'Provider Manifest contains duplicate adapter operation bindings')
    }
    for (const contract of provider.contracts) {
      if (!adapterOperationIds.includes(contract.operationId)) {
        throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} has no Capability JSONL adapter binding`)
      }
    }
  }

  const operationIds = new Set()
  const operations = new Map()
  const ajv = createValidator()
  for (const contract of provider.contracts) {
    if (operationIds.has(contract.operationId)) {
      throw new HostError('HOST_CONFIG_INVALID', `Duplicate configured operation ${contract.operationId}`)
    }
    operationIds.add(contract.operationId)
    const binding = implementation.bindings?.find((candidate) => candidate.operationId === contract.operationId)
    if (binding === undefined) {
      throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} is absent from the Provider Manifest`)
    }
    requireSafeAnnotations(binding, contract.operationId)
    const inputSchemaPath = await realContainedPath(rootPath, contract.inputSchemaPath, 'input schema')
    const outputSchemaPath = await realContainedPath(rootPath, contract.outputSchemaPath, 'output schema')
    const [inputText, outputText] = await Promise.all([
      readFile(inputSchemaPath, 'utf8'),
      readFile(outputSchemaPath, 'utf8'),
    ])
    const inputSchema = parseStrictJson(inputText, `${contract.operationId} input schema`)
    const outputSchema = parseStrictJson(outputText, `${contract.operationId} output schema`)
    if (digestJson(inputSchema) !== binding.contractSchemaDigests?.input) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Input schema digest drift for ${contract.operationId}`)
    }
    if (digestJson(outputSchema) !== binding.contractSchemaDigests?.output) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Output schema digest drift for ${contract.operationId}`)
    }
    operations.set(contract.operationId, {
      operationId: contract.operationId,
      inputSchema,
      outputSchema,
      validateInput: ajv.compile(inputSchema),
      validateOutput: ajv.compile(outputSchema),
      annotations: binding.annotations,
      contractSchemaDigests: {
        input: digestJson(inputSchema),
        output: digestJson(outputSchema),
      },
      schemaBytes: Buffer.byteLength(inputText) + Buffer.byteLength(outputText),
    })
  }

  const adapterArgs = implementation.adapter.args ?? []
  const adapterCwd = resolve(rootPath, implementation.adapter.cwd ?? '.')
  const cwdPath = await realpath(adapterCwd).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', 'Capability adapter cwd is unavailable', { cause: error })
  })
  if (!inside(rootPath, cwdPath)) throw new HostError('HOST_CONFIG_INVALID', 'Capability adapter cwd escapes provider root')
  if (!(await stat(cwdPath)).isDirectory()) throw new HostError('HOST_CONFIG_INVALID', 'Capability adapter cwd is not a directory')
  const adapterCommand = await resolveExecutable(implementation.adapter.command, cwdPath)
  const identities = await identityDigests(rootPath, provider.identityFiles, 'Capability identity file')

  const manifestDigest = digestJson(manifest)
  const commandDigest = await digestFile(adapterCommand)
  const contractDigest = digestJson({
    capabilityId: provider.capabilityId,
    capabilityVersion: provider.capabilityVersion,
    operations: [...operations.values()].map((operation) => ({
      operationId: operation.operationId,
      ...operation.contractSchemaDigests,
    })).sort((left, right) => left.operationId.localeCompare(right.operationId)),
  })
  return {
    ...provider,
    rootPath,
    manifestPath,
    providerVersion: manifest.provider.version,
    adapterCommand,
    adapterArgs,
    adapterCwd: cwdPath,
    operations,
    contractSchemaBytes: [...operations.values()].reduce((total, operation) => total + operation.schemaBytes, 0),
    manifestDigest,
    commandDigest,
    contractDigest,
    identityDigests: identities,
    bindingDigest: digestJson({
      providerId: provider.providerId,
      providerVersion: manifest.provider.version,
      capabilityId: provider.capabilityId,
      capabilityVersion: provider.capabilityVersion,
      manifestDigest,
      commandDigest,
      adapterArgs,
      adapterCwd: relative(rootPath, cwdPath) || '.',
      identityFiles: identities,
      contractDigest,
      lifecycle: provider.lifecycle,
      operations: [...operations.keys()].sort(),
    }),
    limits,
  }
}

function assertProcedureStageAlignment(profile, implementation) {
  if (implementation.stages?.length !== profile.stages?.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Procedure implementation stage count does not match the selected Profile')
  }
  const prior = new Set()
  for (const [index, stage] of profile.stages.entries()) {
    if (prior.has(stage.id)) throw new HostError('HOST_BINDING_INVALID', `Duplicate Procedure stage ${stage.id}`)
    const dependencies = new Set()
    for (const dependency of stage.dependsOn) {
      if (dependencies.has(dependency) || !prior.has(dependency)) {
        throw new HostError('HOST_BINDING_INVALID', `Procedure stage ${stage.id} has invalid causal order`)
      }
      dependencies.add(dependency)
    }
    const binding = implementation.stages[index]
    if (
      binding === undefined ||
      binding.stageId !== stage.id ||
      binding.capabilityId !== stage.capability?.id ||
      binding.capabilityVersion !== stage.capability?.version ||
      binding.operationId !== stage.capability?.operationId
    ) {
      throw new HostError('HOST_BINDING_INVALID', `Procedure stage ${stage.id} does not match the selected Profile`)
    }
    prior.add(stage.id)
  }
  const outputStage = profile.stages.find((stage) => stage.id === profile.completion.outputStage)
  if (outputStage === undefined || outputStage.required !== true) {
    throw new HostError('HOST_BINDING_INVALID', 'Procedure completion must name a required output stage')
  }
}

async function resolveProfileContractSchema(profilePath, declaration, label) {
  const reference = declaration?.$ref
  if (typeof reference !== 'string' || (!reference.startsWith('./') && !reference.startsWith('../'))) {
    return declaration
  }
  const base = dirname(profilePath)
  const path = resolve(base, reference)
  if (!inside(base, path)) throw new HostError('HOST_BINDING_INVALID', `${label} reference escapes the Profile directory`)
  return await readStrictJsonFile(path, CONFIG_FILE_LIMIT, label)
}

async function prepareProcedureProvider(provider, limits) {
  const rootPath = await realRoot(provider.rootPath)
  const profilePath = await realRegularPath(provider.profilePath, 'Procedure Profile')
  const implementationManifestPath = await realContainedPath(
    rootPath,
    provider.implementationManifestPath,
    'Procedure implementation manifest',
  )
  const [profile, manifest] = await Promise.all([
    readStrictJsonFile(profilePath, CONFIG_FILE_LIMIT, 'Procedure Profile'),
    readStrictJsonFile(implementationManifestPath, CONFIG_FILE_LIMIT, 'Procedure implementation manifest'),
  ])
  assertSchema(await procedureProfileValidator(), profile, 'HOST_BINDING_INVALID', 'Procedure Profile')
  assertSchema(await procedureManifestValidator(), manifest, 'HOST_BINDING_INVALID', 'Procedure implementation manifest')
  if (
    profile.schemaVersion !== 'openadam.procedure-profile.v0.3' ||
    profile.id !== provider.procedureId ||
    profile.version !== provider.procedureVersion
  ) {
    throw new HostError('HOST_BINDING_INVALID', 'Configured Procedure identity does not match the selected Profile')
  }
  if (
    !['none', 'read'].includes(profile.semantics?.stateAccess) ||
    profile.semantics?.idempotency !== 'idempotent'
  ) {
    throw new HostError('HOST_BINDING_UNSAFE', 'Procedure Profile is outside the v0.1 read-only idempotent boundary')
  }
  if (
    manifest.schemaVersion !== 'openadam.procedure-implementation-manifest.v0.4' ||
    manifest.provider?.id !== provider.providerId
  ) {
    throw new HostError('HOST_BINDING_INVALID', 'Procedure implementation manifest identity is invalid')
  }
  const implementation = manifest.implementations?.find(
    (candidate) => candidate.procedureId === provider.procedureId && candidate.procedureVersion === provider.procedureVersion,
  )
  if (implementation === undefined || implementation.adapter?.protocol !== 'openadam.procedure-jsonl.v0.2') {
    throw new HostError('HOST_BINDING_INVALID', 'Selected Procedure JSONL implementation is absent')
  }
  const implementationIdentities = manifest.implementations.map(
    (candidate) => `${candidate.procedureId}@${candidate.procedureVersion}`,
  )
  if (new Set(implementationIdentities).size !== implementationIdentities.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Procedure implementation manifest contains duplicate identities')
  }
  assertProcedureStageAlignment(profile, implementation)

  const inputSchemaPath = await realContainedPath(rootPath, provider.inputSchemaPath, 'Procedure input schema')
  const outputSchemaPath = await realContainedPath(rootPath, provider.outputSchemaPath, 'Procedure output schema')
  const [inputText, outputText] = await Promise.all([
    readFile(inputSchemaPath, 'utf8'),
    readFile(outputSchemaPath, 'utf8'),
  ])
  const inputSchema = parseStrictJson(inputText, 'Procedure input schema')
  const outputSchema = parseStrictJson(outputText, 'Procedure output schema')
  const [profileInputSchema, profileOutputSchema] = await Promise.all([
    resolveProfileContractSchema(profilePath, profile.inputSchema, 'Procedure Profile input schema'),
    resolveProfileContractSchema(profilePath, profile.outputSchema, 'Procedure Profile output schema'),
  ])
  if (digestJson(inputSchema) !== digestJson(profileInputSchema)) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Configured Procedure input schema differs from the selected Profile')
  }
  if (digestJson(outputSchema) !== digestJson(profileOutputSchema)) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Configured Procedure output schema differs from the selected Profile')
  }
  if (digestJson(inputSchema) !== implementation.contractSchemaDigests?.input) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Procedure input schema digest drift')
  }
  if (digestJson(outputSchema) !== implementation.contractSchemaDigests?.output) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Procedure output schema digest drift')
  }

  const adapterArgs = implementation.adapter.args ?? []
  const adapterCwd = await realpath(resolve(rootPath, implementation.adapter.cwd ?? '.')).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', 'Procedure adapter cwd is unavailable', { cause: error })
  })
  if (!inside(rootPath, adapterCwd) || !(await stat(adapterCwd)).isDirectory()) {
    throw new HostError('HOST_CONFIG_INVALID', 'Procedure adapter cwd escapes its provider root')
  }
  const adapterCommand = await resolveExecutable(implementation.adapter.command, adapterCwd)
  const identities = await identityDigests(rootPath, provider.identityFiles, 'Procedure identity file')

  const ajv = createValidator()
  const profileDigest = digestJson(profile)
  const implementationManifestDigest = digestJson(manifest)
  const commandDigest = await digestFile(adapterCommand)
  const contractDigest = digestJson({
    procedureId: provider.procedureId,
    procedureVersion: provider.procedureVersion,
    input: digestJson(inputSchema),
    output: digestJson(outputSchema),
  })
  const procedureErrors = new Map()
  for (const error of profile.errors) {
    if (procedureErrors.has(error.code)) {
      throw new HostError('HOST_BINDING_INVALID', `Duplicate Procedure error code ${error.code}`)
    }
    procedureErrors.set(error.code, error)
  }
  return {
    ...provider,
    rootPath,
    profilePath,
    implementationManifestPath,
    providerVersion: manifest.provider.version,
    adapterCommand,
    adapterArgs,
    adapterCwd,
    validateInput: ajv.compile(inputSchema),
    validateOutput: ajv.compile(outputSchema),
    contractSchemaBytes: Buffer.byteLength(inputText) + Buffer.byteLength(outputText),
    profileDigest,
    implementationManifestDigest,
    commandDigest,
    identityDigests: identities,
    contractDigest,
    procedureErrors,
    bindingDigest: digestJson({
      providerId: provider.providerId,
      providerVersion: manifest.provider.version,
      procedureId: provider.procedureId,
      procedureVersion: provider.procedureVersion,
      profileDigest,
      implementationManifestDigest,
      commandDigest,
      adapterArgs,
      adapterCwd: relative(rootPath, adapterCwd) || '.',
      identityFiles: identities,
      contractDigest,
      lifecycle: provider.lifecycle,
    }),
    limits,
  }
}

async function prepareMcpProvider(provider, limits) {
  const rootPath = await realRoot(provider.rootPath)
  const command = await realContainedPath(rootPath, provider.command, 'MCP executable', true)
  const cwd = await realpath(provider.cwd).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', 'MCP cwd is unavailable', { cause: error })
  })
  if (!inside(rootPath, cwd) || !(await stat(cwd)).isDirectory()) {
    throw new HostError('HOST_CONFIG_INVALID', 'MCP cwd must be a directory inside provider root')
  }
  const commandDigest = await digestFile(command)
  const identities = await identityDigests(rootPath, provider.identityFiles, 'MCP identity file')
  return {
    ...provider,
    rootPath,
    command,
    cwd,
    commandDigest,
    identityDigests: identities,
    bindingDigest: digestJson({
      providerId: provider.providerId,
      expectedServer: provider.expectedServer,
      commandDigest,
      command: relative(rootPath, command),
      args: provider.args,
      cwd: relative(rootPath, cwd) || '.',
      identityFiles: identities,
      lifecycle: provider.lifecycle,
      allowedTools: [...provider.allowedTools].sort(),
    }),
    limits,
  }
}

export async function prepareRuntimeConfig(value) {
  assertSchema(await configValidator(), value, 'HOST_CONFIG_INVALID', 'provider configuration')
  const limits = { ...DEFAULT_LIMITS, ...(value.limits ?? {}) }
  const seen = new Set()
  const providers = new Map()
  for (const provider of value.providers) {
    if (seen.has(provider.providerId)) {
      throw new HostError('HOST_CONFIG_INVALID', `Duplicate providerId ${provider.providerId}`)
    }
    seen.add(provider.providerId)
    const prepared = provider.transport === 'capability-jsonl-v0.1'
      ? await prepareCapabilityProvider(provider, limits)
      : provider.transport === 'procedure-jsonl-v0.2'
        ? await prepareProcedureProvider(provider, limits)
        : await prepareMcpProvider(provider, limits)
    providers.set(provider.providerId, prepared)
  }
  return { schemaVersion: value.schemaVersion, limits, providers }
}

export async function loadRuntimeConfig(path) {
  const value = await readStrictJsonFile(path, CONFIG_FILE_LIMIT, 'provider configuration')
  return await prepareRuntimeConfig(value)
}
