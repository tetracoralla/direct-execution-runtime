#!/usr/bin/env node
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const request = JSON.parse(line)
  const padding = 'x'.repeat(1300)
  const response = { jsonrpc: '2.0', id: request.id, result: { padding } }
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', logger: 'framing-fixture', data: padding },
  }
  process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(notification)}\n`)
}
