import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  assertHostRequest,
  assertHostResponse,
  hostFailure,
  hostSuccess,
  HOST_REQUEST_VERSION,
  HOST_RESPONSE_VERSION,
} from '../src/host-protocol.mjs'
import { jsonBytes, parseStrictJson } from '../src/json.mjs'
import { repositoryRoot, workOrder, fakeCall } from './helpers.mjs'

async function schema(name) {
  return parseStrictJson(await readFile(resolve(repositoryRoot, 'schemas', name), 'utf8'), name)
}

test('published host carrier schemas agree with runtime request and response checks', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addSchema(await schema('work-order.schema.json'))
  ajv.addSchema(await schema('contract-selection.schema.json'))
  const validateRequest = ajv.compile(await schema('host-request.schema.json'))
  const validateResponse = ajv.compile(await schema('host-response.schema.json'))
  const request = {
    schemaVersion: HOST_REQUEST_VERSION,
    id: 'schema-case',
    action: 'run',
    workOrder: workOrder('schema-case', [fakeCall('echo', { value: 'ok' })]),
  }
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors))
  assert.equal(assertHostRequest(request, 1024 * 1024), request)
  const project = {
    schemaVersion: HOST_REQUEST_VERSION,
    id: 'project-case',
    action: 'project',
    selection: {
      schemaVersion: 'openadam.direct-contract-selection.v0.1',
      providerId: 'test.fake-capability',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        operationId: 'echo',
      },
    },
  }
  assert.equal(validateRequest(project), true, JSON.stringify(validateRequest.errors))
  assert.equal(assertHostRequest(project, 1024 * 1024), project)
  const success = hostSuccess(request.id, { status: 'ok' })
  assert.equal(validateResponse(success), true, JSON.stringify(validateResponse.errors))
  assert.equal(assertHostResponse(success, request.id, 1024 * 1024), success)
  const failure = hostFailure(request.id, new Error('failed'))
  assert.equal(validateResponse(failure), true, JSON.stringify(validateResponse.errors))
  assert.equal(assertHostResponse(failure, request.id, 1024 * 1024), failure)
})

test('host carrier rejects unknown fields and mismatched response identity', () => {
  assert.throws(
    () => assertHostRequest({ schemaVersion: HOST_REQUEST_VERSION, id: 'bad', action: 'inspect', extra: true }, 1024),
    (error) => error.code === 'HOST_PROTOCOL_ERROR',
  )
  assert.throws(
    () => assertHostResponse(hostSuccess('actual', { status: 'ok' }), 'expected', 1024),
    (error) => error.code === 'HOST_PROTOCOL_ERROR',
  )
  const extraErrorField = hostFailure('expected', new Error('failed'))
  extraErrorField.error.extra = true
  assert.throws(
    () => assertHostResponse(extraErrorField, 'expected', 4096),
    (error) => error.code === 'HOST_PROTOCOL_ERROR',
  )
  const oversizedMessage = hostFailure('expected', new Error('failed'))
  oversizedMessage.error.message = 'x'.repeat(1004)
  assert.throws(
    () => assertHostResponse(oversizedMessage, 'expected', 4096),
    (error) => error.code === 'HOST_PROTOCOL_ERROR',
  )
})

test('host error message length uses JSON Schema Unicode code points while envelope limits remain UTF-8 bytes', async () => {
  const validateResponse = new Ajv2020({ allErrors: true, strict: false })
    .compile(await schema('host-response.schema.json'))
  const accepted = {
    schemaVersion: HOST_RESPONSE_VERSION,
    id: 'unicode-message',
    status: 'host_error',
    error: {
      code: 'HOST_INTERNAL',
      message: '🧩'.repeat(600),
      retryable: false,
    },
  }
  assert.equal(validateResponse(accepted), true, JSON.stringify(validateResponse.errors))
  assert.equal(assertHostResponse(accepted, accepted.id, jsonBytes(accepted)), accepted)
  assert.throws(
    () => assertHostResponse(accepted, accepted.id, jsonBytes(accepted) - 1),
    (error) => error.code === 'HOST_PROVIDER_RESPONSE_TOO_LARGE',
  )

  const rejected = structuredClone(accepted)
  rejected.error.message = '🧩'.repeat(1004)
  assert.equal(validateResponse(rejected), false)
  assert.throws(
    () => assertHostResponse(rejected, rejected.id, jsonBytes(rejected)),
    (error) => error.code === 'HOST_PROTOCOL_ERROR',
  )
})
