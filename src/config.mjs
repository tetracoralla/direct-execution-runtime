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
let validateCapabilityProfile
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
    validateProviderManifest = createValidator().compile(await loadBundledSchema('provider-manifest.schema.v0.3.json'))
  }
  return validateProviderManifest
}

async function capabilityProfileValidator() {
  if (validateCapabilityProfile === undefined) {
    validateCapabilityProfile = createValidator().compile(
      await loadBundledSchema('capability-profile.schema.v0.3.json'),
    )
  }
  return validateCapabilityProfile
}

async function procedureProfileValidator() {
  if (validateProcedureProfile === undefined) {
    validateProcedureProfile = createValidator().compile(await loadBundledSchema('procedure-profile.schema.v0.5.json'))
  }
  return validateProcedureProfile
}

async function procedureManifestValidator() {
  if (validateProcedureManifest === undefined) {
    validateProcedureManifest = createValidator().compile(
      await loadBundledSchema('procedure-implementation-manifest.schema.v0.5.json'),
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

function expectedOperationAnnotations(operation) {
  return {
    readOnlyHint: ['none', 'read'].includes(operation.semantics.stateAccess),
    destructiveHint: operation.semantics.stateAccess === 'destructive',
    idempotentHint: operation.semantics.idempotency === 'idempotent',
    openWorldHint: operation.semantics.openWorld,
  }
}

function requireSafeOperation(operation) {
  const semantics = operation.semantics
  if (
    !['none', 'read'].includes(semantics.stateAccess) ||
    semantics.idempotency !== 'idempotent' ||
    semantics.openWorld !== false
  ) {
    throw new HostError(
      'HOST_BINDING_UNSAFE',
      `Capability operation ${operation.id} is outside the direct read-only idempotent closed-world boundary`,
    )
  }
}

export async function capabilityProfileDigest(profile, profilePath) {
  const { $schema: ignoredSchemaLocation, ...profileFields } = profile
  void ignoredSchemaLocation
  const operations = []
  for (const operation of profile.operations) {
    operations.push({
      ...operation,
      inputSchema: await resolveProfileContractSchema(
        profilePath,
        operation.inputSchema,
        `Capability operation ${operation.id} input schema`,
      ),
      outputSchema: await resolveProfileContractSchema(
        profilePath,
        operation.outputSchema,
        `Capability operation ${operation.id} output schema`,
      ),
    })
  }
  return digestJson({ ...profileFields, operations })
}

export async function procedureProfileDigest(profile, profilePath) {
  const { $schema: ignoredSchemaLocation, ...profileFields } = profile
  void ignoredSchemaLocation
  return digestJson({
    ...profileFields,
    inputSchema: await resolveProfileContractSchema(profilePath, profile.inputSchema, 'Procedure Profile input schema'),
    outputSchema: await resolveProfileContractSchema(profilePath, profile.outputSchema, 'Procedure Profile output schema'),
  })
}

function assertExactOperationSet(profileOperationIds, bindingOperationIds, label) {
  const expected = new Set(profileOperationIds)
  const actual = new Set(bindingOperationIds)
  const missing = [...expected].filter((operationId) => !actual.has(operationId)).sort()
  const extra = [...actual].filter((operationId) => !expected.has(operationId)).sort()
  if (missing.length > 0 || extra.length > 0) {
    throw new HostError(
      'HOST_BINDING_INVALID',
      `${label} does not exactly match the Capability Profile; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`,
    )
  }
}

async function prepareCapabilityProvider(provider, limits) {
  const rootPath = await realRoot(provider.rootPath)
  const profilePath = await realRegularPath(provider.profilePath, 'Capability Profile')
  const manifestPath = await realContainedPath(rootPath, provider.manifestPath, 'provider manifest')
  const [profile, manifest] = await Promise.all([
    readStrictJsonFile(profilePath, CONFIG_FILE_LIMIT, 'Capability Profile'),
    readStrictJsonFile(manifestPath, CONFIG_FILE_LIMIT, 'provider manifest'),
  ])
  assertSchema(await capabilityProfileValidator(), profile, 'HOST_BINDING_INVALID', 'Capability Profile')
  assertSchema(await providerManifestValidator(), manifest, 'HOST_BINDING_INVALID', 'Provider Manifest')
  if (
    profile.schemaVersion !== 'openadam.capability-profile.v0.3' ||
    profile.id !== provider.capabilityId ||
    profile.version !== provider.capabilityVersion
  ) {
    throw new HostError('HOST_BINDING_INVALID', 'Configured Capability identity does not match the selected Profile')
  }
  if (manifest.schemaVersion !== 'openadam.provider-manifest.v0.3') {
    throw new HostError('HOST_BINDING_INVALID', 'Direct Capability execution requires Provider Manifest v0.3')
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
  const profileDigest = await capabilityProfileDigest(profile, profilePath)
  if (implementation.profileDigest !== profileDigest) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Provider Manifest does not bind the selected Capability Profile semantics')
  }
  const profileOperations = new Map(profile.operations.map((operation) => [operation.id, operation]))
  if (profileOperations.size !== profile.operations.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Capability Profile contains duplicate operation identities')
  }
  const boundOperationIds = implementation.bindings.map((binding) => binding.operationId)
  if (new Set(boundOperationIds).size !== boundOperationIds.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Provider Manifest contains duplicate operation bindings')
  }
  const adapterOperationIds = implementation.adapterBindings.map((binding) => binding.operationId)
  if (new Set(adapterOperationIds).size !== adapterOperationIds.length) {
    throw new HostError('HOST_BINDING_INVALID', 'Provider Manifest contains duplicate adapter operation bindings')
  }
  assertExactOperationSet(profileOperations.keys(), boundOperationIds, 'Provider Manifest public operation bindings')
  assertExactOperationSet(profileOperations.keys(), adapterOperationIds, 'Provider Manifest adapter operation bindings')
  for (const contract of provider.contracts) {
    if (!adapterOperationIds.includes(contract.operationId)) {
      throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} has no Capability JSONL adapter binding`)
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
    const profileOperation = profileOperations.get(contract.operationId)
    if (profileOperation === undefined) {
      throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} is absent from the Capability Profile`)
    }
    requireSafeOperation(profileOperation)
    if (digestJson(binding.annotations) !== digestJson(expectedOperationAnnotations(profileOperation))) {
      throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} annotations differ from Profile semantics`)
    }
    const inputSchemaPath = await realContainedPath(rootPath, contract.inputSchemaPath, 'input schema')
    const outputSchemaPath = await realContainedPath(rootPath, contract.outputSchemaPath, 'output schema')
    const [inputText, outputText] = await Promise.all([
      readFile(inputSchemaPath, 'utf8'),
      readFile(outputSchemaPath, 'utf8'),
    ])
    const inputSchema = parseStrictJson(inputText, `${contract.operationId} input schema`)
    const outputSchema = parseStrictJson(outputText, `${contract.operationId} output schema`)
    const [profileInputSchema, profileOutputSchema] = await Promise.all([
      resolveProfileContractSchema(
        profilePath,
        profileOperation.inputSchema,
        `Capability operation ${contract.operationId} Profile input schema`,
      ),
      resolveProfileContractSchema(
        profilePath,
        profileOperation.outputSchema,
        `Capability operation ${contract.operationId} Profile output schema`,
      ),
    ])
    if (digestJson(inputSchema) !== digestJson(profileInputSchema)) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Configured input schema differs from the Profile for ${contract.operationId}`)
    }
    if (digestJson(outputSchema) !== digestJson(profileOutputSchema)) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Output schema differs from the Profile for ${contract.operationId}`)
    }
    if (digestJson(inputSchema) !== binding.contractSchemaDigests?.input) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Input schema digest drift for ${contract.operationId}`)
    }
    if (digestJson(outputSchema) !== binding.contractSchemaDigests?.output) {
      throw new HostError('HOST_SCHEMA_DRIFT', `Output schema digest drift for ${contract.operationId}`)
    }
    const errors = new Map(profileOperation.errors.map((error) => [error.code, error]))
    if (errors.size !== profileOperation.errors.length) {
      throw new HostError('HOST_BINDING_INVALID', `Operation ${contract.operationId} contains duplicate error codes`)
    }
    operations.set(contract.operationId, {
      operationId: contract.operationId,
      inputSchema,
      outputSchema,
      validateInput: ajv.compile(inputSchema),
      validateOutput: ajv.compile(outputSchema),
      annotations: binding.annotations,
      errors,
      contractDigest: digestJson({
        capabilityId: provider.capabilityId,
        capabilityVersion: provider.capabilityVersion,
        operation: profileOperation,
        inputSchema,
        outputSchema,
      }),
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
    profilePath,
    manifestPath,
    providerVersion: manifest.provider.version,
    adapterCommand,
    adapterArgs,
    adapterCwd: cwdPath,
    operations,
    contractSchemaBytes: [...operations.values()].reduce((total, operation) => total + operation.schemaBytes, 0),
    profileDigest,
    manifestDigest,
    commandDigest,
    contractDigest,
    identityDigests: identities,
    bindingDigest: digestJson({
      providerId: provider.providerId,
      providerVersion: manifest.provider.version,
      capabilityId: provider.capabilityId,
      capabilityVersion: provider.capabilityVersion,
      profileDigest,
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
  const prior = new Map()
  for (const [index, stage] of profile.stages.entries()) {
    if (prior.has(stage.id)) throw new HostError('HOST_BINDING_INVALID', `Duplicate Procedure stage ${stage.id}`)
    const dependencies = new Set()
    for (const dependency of stage.dependsOn) {
      const dependencyStage = prior.get(dependency)
      if (dependencies.has(dependency) || dependencyStage === undefined) {
        throw new HostError('HOST_BINDING_INVALID', `Procedure stage ${stage.id} has invalid causal order`)
      }
      if (dependencyStage.required !== true) {
        throw new HostError(
          'HOST_BINDING_INVALID',
          `Procedure stage ${stage.id} depends on optional stage ${dependency}; use afterIfExecuted`,
        )
      }
      dependencies.add(dependency)
    }
    const conditionalPredecessors = new Set()
    for (const predecessor of stage.afterIfExecuted ?? []) {
      if (conditionalPredecessors.has(predecessor) || dependencies.has(predecessor)) {
        throw new HostError('HOST_BINDING_INVALID', `Procedure stage ${stage.id} has duplicate causal edges`)
      }
      const predecessorStage = prior.get(predecessor)
      if (predecessorStage?.required !== false || predecessorStage.condition === undefined) {
        throw new HostError('HOST_BINDING_INVALID', `Procedure stage ${stage.id} has invalid conditional causal order`)
      }
      conditionalPredecessors.add(predecessor)
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
    prior.set(stage.id, stage)
  }
  const stageById = new Map(profile.stages.map((stage) => [stage.id, stage]))
  if (profile.completion.outputStage !== undefined) {
    const outputStage = stageById.get(profile.completion.outputStage)
    if (outputStage === undefined || outputStage.required !== true) {
      throw new HostError('HOST_BINDING_INVALID', 'Fixed Procedure completion must name a required output stage')
    }
    return
  }
  const [first, second] = profile.completion.branches
  const firstPointer = first.when.inputPresent ?? first.when.inputAbsent
  const secondPointer = second.when.inputPresent ?? second.when.inputAbsent
  if (
    firstPointer !== secondPointer ||
    Object.hasOwn(first.when, 'inputPresent') === Object.hasOwn(second.when, 'inputPresent')
  ) {
    throw new HostError('HOST_BINDING_INVALID', 'Procedure completion branches must be complementary')
  }
  for (const branch of profile.completion.branches) {
    const outputStage = stageById.get(branch.outputStage)
    if (outputStage === undefined) {
      throw new HostError('HOST_BINDING_INVALID', `Procedure completion stage ${branch.outputStage} does not exist`)
    }
    if (outputStage.required === false && digestJson(outputStage.condition) !== digestJson(branch.when)) {
      throw new HostError('HOST_BINDING_INVALID', `Procedure completion branch differs from stage ${branch.outputStage} condition`)
    }
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
  const resolvedPath = await realpath(path).catch((error) => {
    throw new HostError('HOST_PROVIDER_UNAVAILABLE', `${label} is unavailable`, { cause: error })
  })
  if (!inside(base, resolvedPath)) {
    throw new HostError('HOST_BINDING_INVALID', `${label} symlink escapes the Profile directory`)
  }
  return await readStrictJsonFile(resolvedPath, CONFIG_FILE_LIMIT, label)
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
    profile.schemaVersion !== 'openadam.procedure-profile.v0.5' ||
    profile.id !== provider.procedureId ||
    profile.version !== provider.procedureVersion
  ) {
    throw new HostError('HOST_BINDING_INVALID', 'Configured Procedure identity does not match the selected Profile')
  }
  if (
    !['none', 'read'].includes(profile.semantics?.stateAccess) ||
    profile.semantics?.idempotency !== 'idempotent' ||
    profile.semantics?.openWorld !== false
  ) {
    throw new HostError(
      'HOST_BINDING_UNSAFE',
      'Procedure Profile is outside the direct read-only idempotent closed-world boundary',
    )
  }
  if (
    manifest.schemaVersion !== 'openadam.procedure-implementation-manifest.v0.5' ||
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
  const profileDigest = await procedureProfileDigest(profile, profilePath)
  if (implementation.profileDigest !== profileDigest) {
    throw new HostError('HOST_SCHEMA_DRIFT', 'Procedure implementation does not bind the selected Profile semantics')
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
    inputSchema,
    outputSchema,
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
  const projectionDefinitions = new Map()
  const batchProjectionDefinitions = new Map()
  for (const declaration of provider.operationProjections ?? []) {
    if (!provider.allowedTools.includes(declaration.toolName)) {
      throw new HostError(
        'HOST_CONFIG_INVALID',
        `Projected MCP tool ${declaration.toolName} is absent from allowedTools`,
      )
    }
    if (projectionDefinitions.has(declaration.toolName)) {
      throw new HostError('HOST_CONFIG_INVALID', `Duplicate MCP operation projection for ${declaration.toolName}`)
    }
    projectionDefinitions.set(declaration.toolName, declaration)
    if (declaration.schemaLookup !== undefined) {
      if (
        declaration.schemaLookup.toolName === declaration.toolName ||
        !provider.allowedTools.includes(declaration.schemaLookup.toolName)
      ) {
        throw new HostError(
          'HOST_CONFIG_INVALID',
          `Projected MCP schema lookup tool ${declaration.schemaLookup.toolName} is not a distinct allowed tool`,
        )
      }
    }
    if (declaration.batchToolName !== undefined) {
      if (
        declaration.batchToolName === declaration.toolName ||
        !provider.allowedTools.includes(declaration.batchToolName)
      ) {
        throw new HostError(
          'HOST_CONFIG_INVALID',
          `Projected MCP batch tool ${declaration.batchToolName} is not a distinct allowed tool`,
        )
      }
      if (batchProjectionDefinitions.has(declaration.batchToolName)) {
        throw new HostError(
          'HOST_CONFIG_INVALID',
          `Duplicate MCP batch projection for ${declaration.batchToolName}`,
        )
      }
      batchProjectionDefinitions.set(declaration.batchToolName, declaration)
    }
  }
  const operationProjections = [...(provider.operationProjections ?? [])]
    .sort((left, right) => left.toolName.localeCompare(right.toolName))
  return {
    ...provider,
    rootPath,
    command,
    cwd,
    commandDigest,
    identityDigests: identities,
    projectionDefinitions,
    batchProjectionDefinitions,
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
      operationProjections,
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
