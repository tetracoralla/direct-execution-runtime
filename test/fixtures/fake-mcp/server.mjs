#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const startupArgument = process.argv.find((value) => value.startsWith('--startup-delay='))
const startupDelayMs = Number(startupArgument?.split('=')[1] ?? 0)

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: {
    value: { type: 'string', maxLength: 4096 },
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

const server = new Server(
  { name: 'direct-execution-fake-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Bounded read-only test echo',
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const input = request.params.arguments
  if (input.delayMs > 0) await delay(input.delayMs)
  if (input.behavior === 'stderr') process.stderr.write('x'.repeat(8192))
  const structuredContent = { value: input.value }
  return {
    content: [{ type: 'text', text: input.value }],
    structuredContent,
  }
})

if (startupDelayMs > 0) await delay(startupDelayMs)
await server.connect(new StdioServerTransport())
