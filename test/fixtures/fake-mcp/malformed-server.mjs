#!/usr/bin/env node
import readline from 'node:readline'

const mode = process.argv.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length)

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string', maxLength: 4096 } },
}
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string', maxLength: 4096 } },
}
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function malformedCallResponse(id) {
  if (mode === 'invalid-utf8') {
    const prefix = Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":"`)
    const suffix = Buffer.from('"}],"structuredContent":{"value":"replacement-must-not-pass"}}}\n')
    process.stdout.write(Buffer.concat([prefix, Buffer.from([0xff]), suffix]))
    return
  }
  process.stdout.write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{` +
    '"content":[{"type":"text","text":"duplicate"}],' +
    '"structuredContent":{"value":"first"},"structuredContent":{"value":"second"}}}\n',
  )
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'direct-execution-fake-mcp', version: '0.1.0' },
      },
    })
    return
  }
  if (request.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{ name: 'echo', inputSchema, outputSchema, annotations }],
      },
    })
    return
  }
  if (request.method === 'tools/call') malformedCallResponse(request.id)
})
