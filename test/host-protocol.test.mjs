import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import { assertHostRequest, assertHostResponse, hostFailure, hostSuccess, HOST_REQUEST_VERSION } from '../src/host-protocol.mjs'
import { parseStrictJson } from '../src/json.mjs'
import { repositoryRoot, workOrder, fakeCall } from './helpers.mjs'

async function schema(name) {
  return parseStrictJson(await readFile(resolve(repositoryRoot, 'schemas', name), 'utf8'), name)
}

test('published host carrier schemas agree with runtime request and response checks', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addSchema(await schema('work-order.schema.json'))
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
})
