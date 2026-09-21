import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createJwsClient } from '../lib/jws-api.js'

/**
 * Build a fetch stub that records calls and answers from a table.
 *
 * Only JSON string bodies are parsed; a binary PUT body is recorded verbatim,
 * so the same stub serves both the JSON and the upload tests.
 */
function stubFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const raw = init?.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw
    calls.push({ url, init, body })
    return handler(calls.length, calls.at(-1))
  }
  return { calls, fetchImpl }
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) })
const err = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) })

test('catalog unwraps data and hits the documented path', async () => {
  const { calls, fetchImpl } = stubFetch(() => ok([{ id: 'image:x' }]))
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_k', fetchImpl })
  const models = await client.catalog()
  assert.deepEqual(models, [{ id: 'image:x' }])
  assert.equal(calls[0].url, 'https://api.test/v1/catalog/models?type=image')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jws_live_k')
})

test('quote posts type/model/params', async () => {
  const { calls, fetchImpl } = stubFetch(() => ok({ quoteId: 'q1', amount: 3, currency: 'CNY' }))
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_k', fetchImpl })
  const quote = await client.quote({ type: 'image', model: 'image:x', params: { count: 1 } })
  assert.equal(quote.amount, 3)
  assert.equal(calls[0].url, 'https://api.test/v1/quotes')
  assert.deepEqual(calls[0].body, { type: 'image', model: 'image:x', params: { count: 1 } })
})

test('an error envelope becomes a readable Error', async () => {
  const { fetchImpl } = stubFetch(() => err(402, '余额不足'))
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_k', fetchImpl })
  await assert.rejects(() => client.catalog(), /JWS HTTP 402: 余额不足/u)
})

test('the key is redacted from error messages', async () => {
  const { fetchImpl } = stubFetch(() => err(401, 'bad key jws_live_secret'))
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_secret', fetchImpl })
  await assert.rejects(() => client.catalog(), (error) => {
    assert.equal(error.message.includes('jws_live_secret'), false)
    assert.match(error.message, /\[已隐藏\]/u)
    return true
  })
})

test('requests never follow redirects', async () => {
  const { calls, fetchImpl } = stubFetch(() => ok([]))
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_k', fetchImpl })
  await client.catalog()
  assert.equal(calls[0].init.redirect, 'error')
})

test('uploadReferences declares, uploads, and reuses one Idempotency-Key', async () => {
  const { calls, fetchImpl } = stubFetch((n) => {
    if (n === 1) return ok({ id: 'sess1', items: [{ itemId: 'item1' }] })
    return ok({})
  })
  const client = createJwsClient({ baseURL: 'https://api.test', apiKey: 'jws_live_k', fetchImpl })
  const bytes = new Uint8Array([1, 2, 3])
  const result = await client.uploadReferences({ files: [{ bytes, mimeType: 'image/png' }], requestId: 'req-1' })

  assert.deepEqual(result, { inputSessionId: 'sess1', imageInputIds: ['item1'] })
  assert.equal(calls[0].url, 'https://api.test/v1/inputs')
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'req-1')
  assert.deepEqual(calls[0].body, {
    purpose: 'image-generation',
    items: [{
      sourceId: 'reference-1',
      mimeType: 'image/png',
      size: 3,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  })
  assert.equal(calls[1].url, 'https://api.test/v1/inputs/sess1/items/item1')
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].init.headers['Content-Type'], 'image/png')
  assert.deepEqual(calls[1].init.body, bytes)
})