#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'

const startupArgument = process.argv.find((value) => value.startsWith('--startup-delay='))
const startupDelayMs = Number(startupArgument?.split('=')[1] ?? 0)
const closeDuringToolListing = process.argv.includes('--list-tools-close')
const malformedLookup = process.argv.includes('--malformed-lookup')
const narrowSchema = process.argv.includes('--narrow-schema')
const paginateTools = process.argv.includes('--paginate-tools')
const paginateForever = process.argv.includes('--paginate-forever')

if (process.argv.includes('--startup-fail')) {
  process.stderr.write('intentional fixture startup failure\n')
  process.exit(17)
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: {
    value: { type: 'string', maxLength: narrowSchema ? 32 : 4096 },
    behavior: { enum: ['ordinary', 'stderr'] },
    delayMs: { type: 'integer', minimum: 0, maximum: 5000 },
  },
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string', maxLength: 4096 } },
}

const dispatchInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'arguments'],
  properties: {
    operation: { type: 'string' },
    arguments: { type: 'object' },
  },
  oneOf: [
    {
      properties: {
        operation: { const: 'text.echo' },
        arguments: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string', maxLength: 4096 } },
        },
      },
    },
    {
      properties: {
        operation: { const: 'text.upper' },
        arguments: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string', maxLength: 4096 } },
        },
      },
    },
  ],
}

const compactDispatchInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'arguments'],
  properties: {
    operation: { type: 'string', enum: ['text.echo', 'text.upper'] },
    arguments: { type: 'object' },
  },
}

const describeInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: { operation: { type: 'string', enum: ['text.echo', 'text.upper'] } },
}

const describeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: {
    operation: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'inputSchema'],
      properties: {
        id: { type: 'string' },
        inputSchema: { type: 'object', additionalProperties: true },
      },
    },
  },
}

const dispatchBatchInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'arguments'],
        properties: {
          operation: { type: 'string' },
          arguments: { type: 'object' },
        },
      },
    },
  },
}

const batchOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: outputSchema,
    },
  },
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const tools = [
  {
    name: 'echo',
    description: 'Bounded read-only test echo',
    inputSchema,
    outputSchema,
    annotations,
  },
  {
    name: 'dispatch',
    description: 'Dispatch one selected typed text operation',
    inputSchema: dispatchInputSchema,
    outputSchema,
    annotations,
  },
  {
    name: 'dispatch.compact',
    description: 'Dispatch through a compact closed operation envelope',
    inputSchema: compactDispatchInputSchema,
    outputSchema,
    annotations,
  },
  {
    name: 'dispatch.describe',
    description: 'Return one selected dispatch operation schema',
    inputSchema: describeInputSchema,
    outputSchema: describeOutputSchema,
    annotations,
  },
  {
    name: 'dispatch.batch',
    description: 'Run selected typed text operations in one batch',
    inputSchema: dispatchBatchInputSchema,
    outputSchema: batchOutputSchema,
    annotations,
  },
]

const server = new Server(
  { name: 'direct-execution-fake-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (closeDuringToolListing) process.exit(18)
  if (paginateForever) return { tools: [], nextCursor: 'spin' }
  if (paginateTools) {
    if (request.params?.cursor === 'page-2') {
      return { tools: tools.filter((tool) => tool.name.startsWith('dispatch.')) }
    }
    return {
      tools: tools.filter((tool) => !tool.name.startsWith('dispatch.')),
      nextCursor: 'page-2',
    }
  }
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const input = request.params.arguments
  if (request.params.name === 'dispatch') {
    const value = input.operation === 'text.upper'
      ? input.arguments.value.toUpperCase()
      : input.arguments.value
    return { content: [{ type: 'text', text: value }], structuredContent: { value } }
  }
  if (request.params.name === 'dispatch.compact') {
    const value = input.operation === 'text.upper'
      ? input.arguments.value.toUpperCase()
      : input.arguments.value
    return { content: [{ type: 'text', text: value }], structuredContent: { value } }
  }
  if (request.params.name === 'dispatch.describe') {
    if (malformedLookup) {
      return {
        content: [{ type: 'text', text: 'malformed' }],
        structuredContent: { operation: { id: input.operation, inputSchema: null } },
      }
    }
    return {
      content: [{ type: 'text', text: input.operation }],
      structuredContent: {
        operation: {
          id: input.operation,
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: { value: { type: 'string', maxLength: 4096 } },
          },
        },
      },
    }
  }
  if (request.params.name === 'dispatch.batch') {
    const results = input.items.map((item) => ({
      value: item.operation === 'text.upper' ? item.arguments.value.toUpperCase() : item.arguments.value,
    }))
    return { content: [{ type: 'text', text: 'batch' }], structuredContent: { results } }
  }
  if (input.delayMs > 0) await delay(input.delayMs)
  if (input.behavior === 'stderr') process.stderr.write('x'.repeat(8192))
  const value = input.value === '__execution_path__'
    ? fileURLToPath(import.meta.url)
    : input.value === '__execution_cwd__' ? process.cwd() : input.value
  const structuredContent = { value }
  return {
    content: [{ type: 'text', text: value }],
    structuredContent,
  }
})

if (startupDelayMs > 0) await delay(startupDelayMs)
await server.connect(new StdioServerTransport())
