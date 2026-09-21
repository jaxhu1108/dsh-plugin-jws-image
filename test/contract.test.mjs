import assert from 'node:assert/strict'
import test from 'node:test'

import { compareContract, renderApiStatus, summarizeSpec } from '../lib/contract.js'

const SPEC = {
  info: { version: '1.0.0' },
  paths: {
    '/v1/quotes': { post: { requestBody: { content: { 'application/json': { schema: { required: ['type', 'model'] } } } } } },
    '/v1/tasks/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { properties: { status: {}, settlementStatus: {} } } } } } } } },
  },
}

test('summarizeSpec keeps only the dependency surface', () => {
  const summary = summarizeSpec(SPEC)
  assert.equal(summary.infoVersion, '1.0.0')
  assert.deepEqual(summary.endpoints, ['GET /v1/tasks/{id}', 'POST /v1/quotes'])
  assert.deepEqual(summary.requiredFields['POST /v1/quotes'], ['model', 'type'])
  assert.match(summary.docSha256, /^[0-9a-f]{64}$/u)
})

test('an identical spec is up-to-date', () => {
  const snapshot = summarizeSpec(SPEC)
  assert.equal(compareContract(snapshot, summarizeSpec(SPEC)).status, 'up-to-date')
})

test('a version bump with an intact surface is merely changed', () => {
  const snapshot = summarizeSpec(SPEC)
  const live = summarizeSpec({ ...SPEC, info: { version: '1.1.0' } })
  const result = compareContract(snapshot, live)
  assert.equal(result.status, 'changed')
  assert.ok(result.changes.some((line) => line.includes('1.0.0')))
})

test('a disappearing endpoint is breaking', () => {
  const snapshot = summarizeSpec(SPEC)
  const live = summarizeSpec({ info: { version: '1.1.0' }, paths: { '/v1/quotes': SPEC.paths['/v1/quotes'] } })
  const result = compareContract(snapshot, live)
  assert.equal(result.status, 'breaking')
  assert.ok(result.changes.some((line) => line.includes('GET /v1/tasks/{id}')))
})

test('a new required field is breaking', () => {
  const snapshot = summarizeSpec(SPEC)
  const live = summarizeSpec({
    info: { version: '1.0.0' },
    paths: {
      ...SPEC.paths,
      '/v1/quotes': { post: { requestBody: { content: { 'application/json': { schema: { required: ['type', 'model', 'budget'] } } } } } },
    },
  })
  assert.equal(compareContract(snapshot, live).status, 'breaking')
})

test('renderApiStatus produces one line per status', () => {
  assert.match(renderApiStatus({ status: 'up-to-date', local: '1.0.0', live: '1.0.0', changes: [] }), /已是最新/u)
  assert.match(renderApiStatus({ status: 'unknown', changes: [] }), /无法核对/u)
  const breaking = renderApiStatus({ status: 'breaking', local: '1.0.0', live: '1.1.0', changes: ['移除 GET /v1/tasks/{id}'] })
  assert.match(breaking, /询问用户/u)
  assert.match(breaking, /移除 GET/u)
})