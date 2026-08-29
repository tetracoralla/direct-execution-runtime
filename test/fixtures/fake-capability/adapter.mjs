#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  const request = JSON.parse(line)
  const input = request.input
  if (input.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, input.delayMs))
  if (input.behavior === 'crash') process.exit(7)
  if (input.behavior === 'malformed') {
    process.stdout.write('not-json\n')
    continue
  }
  if (input.value === '__empty_line__') {
    process.stdout.write('\n')
    continue
  }
  if (input.behavior === 'stderr') {
    process.stderr.write('x'.repeat(8192))
    continue
  }
  if (input.behavior === 'provider-error') {
    const error = { code: 'FAKE_REJECTED', message: 'Fake provider rejected the input' }
    if (input.value !== 'without-retryable') error.retryable = false
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error,
    })}\n`)
    continue
  }
  const value = input.behavior === 'large'
    ? 'x'.repeat(400000)
    : input.value === '__execution_path__'
      ? fileURLToPath(import.meta.url)
      : input.value === '__execution_cwd__' ? process.cwd() : input.value
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { value } })}\n`)
}
