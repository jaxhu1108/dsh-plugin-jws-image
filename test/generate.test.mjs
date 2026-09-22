import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { runGeneration, taskSegment } from '../lib/generate.js'

/** A client stub recording the call order. */
function stubClient(overrides = {}) {
  const calls = []
  const base = {
    quote: async (input) => { calls.push('quote'); return { quoteId: 'q', amount: 3, currency: 'CNY', expiresAt: new Date(Date.now() + 60000).toISOString() } },
    uploadReferences: async () => { calls.push('upload'); return { inputSessionId: 's', imageInputIds: ['i'] } },
    createGeneration: async () => { calls.push('create'); return 'task1' },
    waitForSettlement: async () => { calls.push('wait'); return { status: 'succeeded', settlementStatus: 'settled', outputCount: 1, amount: 3, currency: 'CNY' } },
    downloadContent: async () => { calls.push('download'); return { bytes: new Uint8Array([1]), mediaType: 'image/png' } },
  }
  return { calls, client: { ...base, ...overrides } }
}

test('taskSegment turns a task id into one safe path segment', () => {
  // A task id looks like `image:e0f0ee88-...`, and a colon is not a legal
  // filename character on Windows, so the id cannot be used verbatim.
  assert.equal(taskSegment('image:e0f0ee88-d9b5-497c'), 'image-e0f0ee88-d9b5-497c')
  assert.equal(taskSegment('a/b\\c:d'), 'a-b-c-d')
  assert.equal(taskSegment(''), 'task')
  assert.equal(taskSegment(':::'), 'task')
})

test('two generations never overwrite each other', async () => {
  // A flat output directory had every run write `image-1.png`, so a second
  // generation destroyed the first and every history entry resolved to the
  // newest file -- which would make history thumbnails all show one image.
  const { client } = stubClient({ createGeneration: async () => 'image:first' })
  const one = await runGeneration({
    client, args: { prompt: 'x' }, maxAmount: 20, outputDir: '/tmp/out', attach: async () => undefined,
  })
  const { client: other } = stubClient({ createGeneration: async () => 'image:second' })
  const two = await runGeneration({
    client: other, args: { prompt: 'x' }, maxAmount: 20, outputDir: '/tmp/out', attach: async () => undefined,
  })
  assert.notEqual(one.files[0], two.files[0])
  assert.equal(one.files[0], join('/tmp/out', 'image-first', 'image-1.png'))
  assert.equal(two.files[0], join('/tmp/out', 'image-second', 'image-1.png'))
})

test('reference images are uploaded before the task is created', async () => {
  const quoted = []
  const { calls, client } = stubClient()
  // Wrap rather than replace: the stub's own quote is what records the call
  // order this test asserts.
  const recording = {
    ...client,
    quote: async (input) => {
      quoted.push(input)
      return client.quote(input)
    },
  }
  const result = await runGeneration({
    client: recording,
    args: {
      prompt: 'x',
      model: 'image:m',
      params: { size: '1:1', resolution: '1K', quality: 'auto', count: 1 },
      references: ['a.png'],
      referenceFiles: [{ bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }],
    },
    maxAmount: 20,
    outputDir: '/tmp/out',
    attach: async () => undefined,
  })
  // The upload sits between the quote and the create, sharing one request id.
  assert.deepEqual(calls, ['quote', 'upload', 'create', 'wait', 'download'])
  assert.equal(quoted[0].params.mode, 'image-to-image')
  assert.equal(quoted[0].params.referenceCount, 1)
  assert.equal(result.taskId, 'task1')
})

test('refuses to generate when the quote exceeds the budget', async () => {
  const { calls, client } = stubClient({ quote: async () => ({ quoteId: 'q', amount: 99, currency: 'CNY', expiresAt: new Date(Date.now() + 60000).toISOString() }) })
  const result = await runGeneration({
    client, args: { prompt: 'x' }, maxAmount: 20, outputDir: '/tmp/out', attach: async () => undefined,
  })
  assert.equal(result.overBudget, true)
  assert.equal(result.amount, 99)
  assert.deepEqual(calls, [])
})

test('happy path quotes, creates, waits, downloads and attaches', async () => {
  const { calls, client } = stubClient()
  const writes = []
  const attached = []
  const result = await runGeneration({
    client,
    args: { prompt: 'x', model: 'image:m', params: { size: '1:1', resolution: '1K', quality: 'auto', count: 1 } },
    maxAmount: 20,
    outputDir: '/tmp/out',
    attach: async (image) => { attached.push(image); return { attachmentId: 'att1' } },
    writeFile: async (path, bytes) => { writes.push({ path, bytes: bytes.length }) },
  })
  assert.deepEqual(calls, ['quote', 'create', 'wait', 'download'])
  assert.equal(result.amount, 3)
  assert.equal(result.taskId, 'task1')
  assert.equal(result.files.length, 1)
  // Two writes per image: the `.tmp` staging file, then the final target.
  assert.deepEqual(writes, [
    { path: join('/tmp/out', 'task1', 'image-1.png.tmp'), bytes: 1 },
    { path: join('/tmp/out', 'task1', 'image-1.png'), bytes: 1 },
  ])
  assert.equal(attached.length, 1)
  assert.equal(attached[0].path, join('/tmp/out', 'task1', 'image-1.png'))
  assert.equal(attached[0].mediaType, 'image/png')
  assert.equal(result.images[0].attachment.attachmentId, 'att1')
})

test('quoteOnly stops before creating anything', async () => {
  const { calls, client } = stubClient()
  const result = await runGeneration({
    client, args: { prompt: 'x', quoteOnly: true }, maxAmount: 20, outputDir: '/tmp/out', attach: async () => undefined,
  })
  assert.equal(result.quoteOnly, true)
  // The price itself has to be fetched, so `quote` is the one call that may
  // happen; nothing is created, uploaded or downloaded.
  assert.deepEqual(calls, ['quote'])
})

test('an expired quote is refused', async () => {
  const { client } = stubClient({ quote: async () => ({ quoteId: 'q', amount: 3, currency: 'CNY', expiresAt: new Date(Date.now() - 1000).toISOString() }) })
  await assert.rejects(
    () => runGeneration({ client, args: { prompt: 'x' }, maxAmount: 20, outputDir: '/tmp/out', attach: async () => undefined }),
    /报价已过期/u,
  )
})