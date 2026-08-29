import { HostError } from './errors.mjs'
import { digestJson, jsonBytes } from './json.mjs'

function ordinaryObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function projectionError(message) {
  return new HostError('HOST_BINDING_INVALID', message)
}

function referencedDefinitions(schema, selectedSchema) {
  const definitions = schema.$defs ?? {}
  const referenced = new Set()

  function collect(value) {
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (!ordinaryObject(value)) return
    const reference = value.$ref
    if (typeof reference === 'string' && reference.startsWith('#/$defs/')) {
      const name = reference.slice('#/$defs/'.length).replaceAll('~1', '/').replaceAll('~0', '~')
      if (!Object.hasOwn(definitions, name)) {
        throw projectionError(`Projected MCP schema references missing definition ${name}`)
      }
      if (!referenced.has(name)) {
        referenced.add(name)
        collect(definitions[name])
      }
    }
    for (const child of Object.values(value)) collect(child)
  }

  collect(selectedSchema)
  return Object.fromEntries(
    [...referenced].sort().map((name) => [name, structuredClone(definitions[name])]),
  )
}

function operationEnvelope(tool, declaration) {
  const schema = tool.inputSchema
  const rootProperties = ordinaryObject(schema) ? schema.properties : undefined
  if (
    !ordinaryObject(schema) ||
    schema.type !== 'object' || schema.additionalProperties !== false ||
    !ordinaryObject(rootProperties) || !ordinaryObject(rootProperties[declaration.operationField]) ||
    !ordinaryObject(rootProperties[declaration.argumentsField]) ||
    !Array.isArray(schema.required) ||
    !schema.required.includes(declaration.operationField) ||
    !schema.required.includes(declaration.argumentsField)
  ) {
    throw projectionError(`MCP tool ${tool.name} does not expose the declared closed operation envelope`)
  }
  return schema
}

function operationBranches(tool, declaration) {
  const schema = operationEnvelope(tool, declaration)
  const branches = schema.oneOf
  if (!Array.isArray(branches) || branches.length === 0) return null

  const byOperation = new Map()
  for (const branch of branches) {
    const properties = branch?.properties
    const operationId = properties?.[declaration.operationField]?.const
    if (
      !ordinaryObject(branch) || !ordinaryObject(properties) ||
      typeof operationId !== 'string' || operationId.length === 0 ||
      !ordinaryObject(properties[declaration.argumentsField])
    ) {
      throw projectionError(`MCP tool ${tool.name} contains an unprojectable operation branch`)
    }
    if (byOperation.has(operationId)) {
      throw projectionError(`MCP tool ${tool.name} contains duplicate operation ${operationId}`)
    }
    byOperation.set(operationId, branch)
  }
  return byOperation
}

export function prepareMcpOperationProjection(tool, declaration) {
  const branches = operationBranches(tool, declaration)
  if (branches === null && declaration.schemaLookup === undefined) {
    throw projectionError(`MCP tool ${tool.name} has no discriminated operation union or declared schema lookup`)
  }
  const operationIds = branches === null
    ? tool.inputSchema.properties[declaration.operationField].enum
    : [...branches.keys()]
  if (
    !Array.isArray(operationIds) || operationIds.length === 0 ||
    operationIds.some((value) => typeof value !== 'string' || value.length === 0) ||
    new Set(operationIds).size !== operationIds.length
  ) {
    throw projectionError(`MCP tool ${tool.name} does not advertise a closed operation identity set`)
  }
  return {
    declaration,
    branches,
    operationIds: new Set(operationIds),
    cache: new Map(),
  }
}

function dynamicInputSchema(tool, prepared, operationId, argumentsSchema) {
  if (!ordinaryObject(argumentsSchema)) {
    throw projectionError(`MCP schema lookup returned no input schema for ${operationId}`)
  }
  const inputSchema = structuredClone(tool.inputSchema)
  const operationField = prepared.declaration.operationField
  const argumentsField = prepared.declaration.argumentsField
  inputSchema.properties[operationField] = {
    ...inputSchema.properties[operationField],
    const: operationId,
  }
  delete inputSchema.properties[operationField].enum
  const selectedArguments = structuredClone(argumentsSchema)
  const dynamicDefinitions = selectedArguments.$defs
  delete selectedArguments.$defs
  inputSchema.properties[argumentsField] = selectedArguments
  if (ordinaryObject(dynamicDefinitions)) {
    inputSchema.$defs = { ...(inputSchema.$defs ?? {}) }
    for (const [name, definition] of Object.entries(dynamicDefinitions)) {
      if (Object.hasOwn(inputSchema.$defs, name) && digestJson(inputSchema.$defs[name]) !== digestJson(definition)) {
        throw projectionError(`Projected MCP schema contains conflicting definition ${name}`)
      }
      inputSchema.$defs[name] = structuredClone(definition)
    }
  }
  return inputSchema
}

export function projectMcpOperation(tool, prepared, operationId, options = {}) {
  const cached = prepared.cache.get(operationId)
  if (cached !== undefined) return cached
  if (!prepared.operationIds.has(operationId)) {
    throw new HostError('HOST_UNKNOWN_OPERATION', `Unknown projected MCP operation ${operationId}`)
  }

  let inputSchema
  if (prepared.branches === null) {
    inputSchema = dynamicInputSchema(tool, prepared, operationId, options.argumentsSchema)
  } else {
    const branch = prepared.branches.get(operationId)
    inputSchema = structuredClone(tool.inputSchema)
    inputSchema.oneOf = [structuredClone(branch)]
    delete inputSchema.$defs
    const definitions = referencedDefinitions(tool.inputSchema, inputSchema)
    if (Object.keys(definitions).length > 0) inputSchema.$defs = definitions
  }
  const outputSchema = structuredClone(tool.outputSchema)
  const errorSchema = ordinaryObject(outputSchema.properties?.error)
    ? structuredClone(outputSchema.properties.error)
    : null
  const contractDigest = digestJson({
    toolName: tool.name,
    operationId,
    inputSchema,
    outputSchema,
    annotations: tool.annotations ?? {},
    schemaLookupContractDigest: options.schemaLookupContractDigest ?? null,
  })
  const projection = {
    operationId,
    inputSchema,
    outputSchema,
    errorSchema,
    contractDigest,
    schemaBytes: jsonBytes(inputSchema) + jsonBytes(outputSchema),
  }
  prepared.cache.set(operationId, projection)
  return projection
}
