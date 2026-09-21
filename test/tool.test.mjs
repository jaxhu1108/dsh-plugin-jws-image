/**
 * Tool-level wiring tests.
 *
 * These run the real `execute` body against a stubbed global `fetch`, so the
 * whole quote -> create -> poll -> download -> attach path is exercised
 * in-process. The file is deliberately separate: it replaces `globalThis.fetch`
 * and must not leak that stub into the API-client unit tests.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import snapshot from '../contract/snapshot.json' with { type: 'json' }
import { apply, renderResult } from '../lib/index.js'

/** A JSON envelope response. */
function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data }),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/** A binary image response. */
function imageResponse(bytes, mediaType) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => mediaType },
    json: async () => ({}),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

/** Install a fetch stub answering the documented JWS endpoints, and restore it. */
function withStubbedFetch(run) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/openapi.json')) return { ok: true, status: 200, json: async () => ({ ...snapshot }) }
    if (String(url).endsWith('/v1/quotes')) {
      return jsonResponse({ quoteId: 'q1', amount: 2, currency: 'CNY', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    if (String(url).endsWith('/v1/image/generations')) return jsonResponse({ id: 'task-42' })
    if (String(url).includes('/v1/tasks/task-42/content')) {
      return imageResponse(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png')
    }
    if (String(url).includes('/v1/tasks/task-42')) {
      return jsonResponse({ id: 'task-42', status: 'succeeded', settlementStatus: 'settled', outputCount: 1, amount: 2, currency: 'CNY' })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  return Promise.resolve(run(requests)).finally(() => { globalThis.fetch = original })
}

/** Register the tool against a context with the given optional services. */
function registerTool(ctx) {
  let definition
  apply({ tools: { register: (value) => { definition = value } }, get: ctx.get, logger: undefined }, {})
  return definition
}

test('a missing attachments service degrades to paths only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.JWS_API_KEY
  try {
    process.env.DSH_HOME = home
    process.env.JWS_API_KEY = 'jws_live_test'
    const definition = registerTool({ get: () => undefined })

    const value = await withStubbedFetch(async () => definition.execute({ prompt: 'a cat' }, {}))

    assert.equal(value.status, 'ok')
    assert.equal(value.taskId, 'task-42')
    assert.equal(value.amount, 2)
    assert.equal(value.images.length, 1)
    // No attachment service: the image record must carry no attachment id, and
    // the render must therefore emit text only.
    assert.equal(value.images[0].attachmentId, undefined)
    assert.equal(value.images[0].path.startsWith(join(home, 'generated-images')), true)
    assert.equal(typeof value.apiLine, 'string')
    const blocks = renderResult({}, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    // The image really landed on disk, through the `.tmp` + rename path.
    const written = await readFile(value.images[0].path)
    assert.equal(written.length, 8)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.JWS_API_KEY
    else process.env.JWS_API_KEY = previousKey
    await rm(home, { recursive: true, force: true })
  }
})

test('an attachments service that accepts the image yields one image block', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.JWS_API_KEY
  const saved = []
  try {
    process.env.DSH_HOME = home
    process.env.JWS_API_KEY = 'jws_live_test'
    const definition = registerTool({
      get: (service) => (service === 'attachments'
        ? {
          imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          saveImage: async (input) => {
            saved.push(input)
            return { attachmentId: 'att-1', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }
          },
        }
        : undefined),
    })

    const value = await withStubbedFetch(async () => definition.execute({ prompt: 'a cat' }, {}))

    assert.equal(value.images[0].attachmentId, 'att-1')
    assert.equal(value.images[0].width, 1)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, 'jws-image-1.png')
    const blocks = renderResult({}, value)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].type, 'image')
    assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.JWS_API_KEY
    else process.env.JWS_API_KEY = previousKey
    await rm(home, { recursive: true, force: true })
  }
})

test('without a key the tool returns no-key and makes no request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.JWS_API_KEY
  try {
    process.env.DSH_HOME = home
    delete process.env.JWS_API_KEY
    const definition = registerTool({ get: () => undefined })
    const requests = []
    const value = await withStubbedFetch(async (seen) => {
      const result = await definition.execute({ prompt: 'a cat' }, {})
      requests.push(...seen)
      return result
    })
    assert.equal(value.status, 'no-key')
    assert.deepEqual(requests, [])
    assert.deepEqual(value.images, [])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.JWS_API_KEY
    else process.env.JWS_API_KEY = previousKey
    await rm(home, { recursive: true, force: true })
  }
})