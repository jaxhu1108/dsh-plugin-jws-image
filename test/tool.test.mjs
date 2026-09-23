/**
 * Tool-level wiring tests.
 *
 * These run the real `execute` body against a stubbed global `fetch`, so the
 * whole quote -> create -> poll -> download -> attach path is exercised
 * in-process. The file is deliberately separate: it replaces `globalThis.fetch`
 * and must not leak that stub into the API-client unit tests.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, readHistory, renderResult, writeHistory } from '../lib/index.js'

test('the history round-trips through disk and survives a corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jws-hist-'))
  try {
    const file = join(dir, 'history.json')
    // Missing file: an empty history, not an error.
    assert.deepEqual(await readHistory(file), [])

    const entries = [{ taskId: 't1', files: ['/tmp/out/a.png'], amount: 0.05, currency: 'USD' }]
    await writeHistory(file, entries)
    assert.deepEqual(await readHistory(file), entries)

    await writeFile(file, '{ not json')
    assert.deepEqual(await readHistory(file), [])
    await writeFile(file, JSON.stringify({ entries: 'not a list' }))
    assert.deepEqual(await readHistory(file), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a history write that cannot land is swallowed, not thrown', async () => {
  // Writing onto a directory path fails; the caller is mid-generation and must
  // not be turned into a failure by a bookkeeping problem.
  const dir = await mkdtemp(join(tmpdir(), 'jws-hist-'))
  try {
    await assert.doesNotReject(() => writeHistory(dir, []))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A live OpenAPI document that summarizes to exactly the pinned snapshot, so
 * the contract check reports `up-to-date` without any network access.
 */
const LIVE_SPEC = {
  info: { version: '1.0.0' },
  paths: {
    '/v1/quotes': {
      post: {
        requestBody: { content: { 'application/json': { schema: { required: ['type', 'model'] } } } },
        responses: { 200: { content: { 'application/json': { schema: { properties: { data: {} } } } } } },
      },
    },
    '/v1/tasks/{id}': {
      get: {
        responses: { 200: { content: { 'application/json': { schema: { properties: { data: {} } } } } } },
      },
    },
  },
}

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
    if (String(url).endsWith('/openapi.json')) return { ok: true, status: 200, json: async () => LIVE_SPEC }
    if (String(url).includes('/v1/catalog/models')) {
      return jsonResponse([{
        id: 'image:catalog-pick',
        modes: ['text-to-image', 'image-to-image'],
        skus: [{ mode: 'text-to-image', size: '3:4', resolution: '2K', quality: 'high', unit: 'image', price: 1, currency: 'USD' }],
      }])
    }
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

test('apply waits for Connection instead of requiring it', () => {
  // `connection` must NOT be in the plugin's own inject list: that would keep
  // the agent tool from loading in a headless deployment with no web stack.
  // The routes mount through ctx.inject, which waits without gating activation.
  let definition
  const injected = []
  const routes = []
  apply({
    tools: { register: (value) => { definition = value } },
    get: () => undefined,
    logger: undefined,
    inject: (services, callback) => {
      injected.push(services)
      callback({ connection: { fetch: { register: (route) => routes.push(route) } } })
    },
  }, {})

  assert.equal(typeof definition?.name, 'string')
  assert.deepEqual(injected, [['connection']])
  assert.equal(routes.length, 11)
  assert.equal(routes[0].path.startsWith('/api/jws-image/'), true)
})

/**
 * Point every credential lookup at a throwaway directory for one test.
 *
 * Both the home-derived default and the env override are redirected, because
 * the default reads the operator's real `~/.config/jws-image` once a key has
 * been configured — without this a "no key" test would start failing, and a
 * "happy path" test could bill the operator's account.
 *
 * @param dir - the throwaway home directory for this test.
 * @returns the previous values, to be restored in a `finally` block.
 */
function pinCredentialEnv(dir) {
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    JWS_API_KEY: process.env.JWS_API_KEY,
    JWS_IMAGE_CONFIG_DIR: process.env.JWS_IMAGE_CONFIG_DIR,
  }
  process.env.DSH_HOME = dir
  // Mirror the production default exactly (`~/.config/jws-image`) under the
  // throwaway home, so a test can write into `<home>/.config/jws-image` and be
  // exercising the same shape the sibling skill uses.
  process.env.JWS_IMAGE_CONFIG_DIR = join(dir, '.config', 'jws-image')
  return {
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test('a missing attachments service degrades to paths only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const env = pinCredentialEnv(home)
  try {
    process.env.JWS_API_KEY = 'jws_live_test'
    const configDir = join(home, '.config', 'jws-image')
    const previousEntry = { taskId: 'previous-task', files: ['/tmp/previous.png'] }
    await writeHistory(join(configDir, 'history.json'), [previousEntry])
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
    // Task 11: every result text carries the contract line, and it is last.
    // The line itself is either the calm form or the warning form; both are
    // valid here, because this stub's spec is not the pinned snapshot.
    assert.match(value.apiLine, /^(API: |⚠️ JWS API )/u)
    assert.equal(blocks[0].text.split('\n').at(-1), value.apiLine)
    // The image really landed on disk, through the `.tmp` + rename path.
    const written = await readFile(value.images[0].path)
    assert.equal(written.length, 8)

    // Session-tool generations are part of the same list as sidebar generations,
    // and restoring history before the call must preserve earlier entries.
    const historyFile = join(configDir, 'history.json')
    const entries = await readHistory(historyFile)
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0], {
      taskId: 'task-42',
      model: 'image:catalog-pick',
      params: { size: '3:4', resolution: '2K', quality: 'high', count: 1 },
      prompt: 'a cat',
      referenceCount: 0,
      files: value.files,
      amount: 2,
      currency: 'CNY',
      maxAmount: 20,
      at: entries[0].at,
      status: 'done',
    })
    assert.equal(Number.isFinite(entries[0].at), true)
    assert.deepEqual(entries[1], previousEntry)
  } finally {
    env.restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('an attachments service that accepts the image yields one image block', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const env = pinCredentialEnv(home)
  const saved = []
  try {
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
    env.restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('without a key the tool returns no-key and makes no request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const env = pinCredentialEnv(home)
  try {
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
    env.restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('a key written by the sibling skill is picked up', async () => {
  // Spec §9/D3: one key serves both the plugin and the `jws-api-demo` skill, so
  // the plugin must read exactly the file that skill's `setup` writes. This is
  // the regression guard for defaulting to `$DSH_HOME` instead of the home
  // directory — with the two differing, the shared-key promise silently breaks.
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const env = pinCredentialEnv(home)
  try {
    delete process.env.JWS_API_KEY
    const configDir = join(home, '.config', 'jws-image')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ apiKey: 'jws_live_from_skill' }))

    const definition = registerTool({ get: () => undefined })
    const value = await withStubbedFetch(async () => definition.execute({ prompt: 'a cat' }, {}))
    assert.equal(value.status, 'ok')
  } finally {
    env.restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed config file degrades to no-key instead of throwing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jws-tool-'))
  const env = pinCredentialEnv(home)
  try {
    delete process.env.JWS_API_KEY
    const configDir = join(home, '.config', 'jws-image')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), '{ not json')

    const definition = registerTool({ get: () => undefined })
    const value = await withStubbedFetch(async () => definition.execute({ prompt: 'a cat' }, {}))
    assert.equal(value.status, 'no-key')
  } finally {
    env.restore()
    await rm(home, { recursive: true, force: true })
  }
})