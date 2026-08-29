import test from 'node:test'
import assert from 'node:assert/strict'
import { createValidator } from '../src/schema.mjs'

function compile(ajv, schema) {
  return ajv.compile(schema)
}

test('uint32 format enforces the unsigned 32-bit integer range', () => {
  const validate = compile(createValidator(), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { axis: { type: 'integer', format: 'uint32' } },
    required: ['axis'],
  })
  assert.equal(validate({ axis: 0 }), true)
  assert.equal(validate({ axis: 4096 }), true)
  assert.equal(validate({ axis: 4294967295 }), true)
  assert.equal(validate({ axis: -1 }), false)
  assert.equal(validate({ axis: 4294967296 }), false)
  assert.equal(validate({ axis: 1.5 }), false)
})

test('uint64 format enforces the unsigned 64-bit integer range', () => {
  const validate = compile(createValidator(), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { pixels: { type: 'integer', format: 'uint64' } },
    required: ['pixels'],
  })
  assert.equal(validate({ pixels: 0 }), true)
  assert.equal(validate({ pixels: 67108864 }), true)
  assert.equal(validate({ pixels: -1 }), false)
  assert.equal(validate({ pixels: 18446744073709551615 }), false)
})
