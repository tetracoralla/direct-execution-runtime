#!/usr/bin/env node
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const request = JSON.parse(line)
  if (
    request.procedureId !== 'org.openadam.test.echo-procedure' ||
    request.procedureVersion !== '0.1.0'
  ) {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Unsupported Procedure', retryable: false },
    })}\n`)
    continue
  }
  const input = request.input
  if (input.behavior === 'provider-error') {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: 'FAKE_REJECTED', message: 'Fake Procedure rejected the input' },
    })}\n`)
    continue
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { value: input.value } })}\n`)
}
