/**
 * Route tests.
 *
 * The routes are the only place the API key is used, and the only place a
 * browser can spend money. These tests pin both properties: the key never
 * appears in a response, and a generation always goes through the budget check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTE_PREFIX, createRouteHandlers, publicModel, redact, referencesFromBody, registerRoutes } from '../lib/routes.js'

/** A request whose JSON body is the given value. */
function postRequest(body, url = `${ROUTE_PREFIX}/x`) {
  return new Request(`http://127.0.0.1:3080${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A GET request. */
function getRequest(url) {
  return new Request(`http://127.0.0.1:3080${url}`, { method: 'GET' })
}

/** Read a JSON response body. */
async function bodyOf(response) {
  return response.json()
}

/**
 * Build the handler set with recording fakes.
 * @param overrides - dependency overrides for one test.
 */
function makeHandlers(overrides = {}) {
  const state = {
    key: overrides.key,
    written: [],
    generated: [],
    snapshots: [],
    caches: [],
  }
  const client = {
    catalog: async () => [{ id: 'image:a', modes: ['text-to-image'], skus: [{ mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' }] }],
    quote: async (input) => ({ quoteId: 'q1', amount: 0.5, currency: 'USD', expiresAt: new Date(Date.now() + 60_000).toISOString(), input }),
    poll: async (id) => ({ id, status: 'succeeded', settlementStatus: 'settled' }),
  }
  const handlers = createRouteHandlers({
    spec: {
      baseURL: 'https://image.aijws.com',
      defaultModel: undefined,
      maxAmount: 20,
      outputDir: '/tmp/out',
      credentialsDir: '/tmp/cfg',
      cacheFile: '/tmp/cache.json',
      snapshotCacheFile: '/tmp/snapshot.json',
      apiCheckTtlMs: 86_400_000,
    },
    budgetCurrency: 'CNY',
    history: state.generated,
    readApiKey: async () => state.key,
    writeApiKey: async (dir, key) => { state.written.push({ dir, key }) },
    isValidKey: (key) => typeof key === 'string' && key.startsWith('jws_live_'),
    createClient: () => ({ ...client, ...overrides.client }),
    runGeneration: overrides.runGeneration ?? (async (options) => {
      await options.attach({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', path: '/tmp/out/image-1.png' })
      return { taskId: 'task-9', files: ['/tmp/out/image-1.png'], amount: 0.5, currency: 'USD' }
    }),
    resolveModelAndParams: overrides.resolveModelAndParams ?? (async () => ({
      model: 'image:a',
      params: { size: '1:1', resolution: '1K', quality: 'auto', count: 1 },
      catalogPicked: true,
    })),
    checkApiStatus: overrides.checkApiStatus ?? (async () => ({ status: 'up-to-date', local: '1.0.0', live: '1.0.0', changes: [] })),
    readSnapshot: overrides.readSnapshot ?? (async () => ({ infoVersion: '1.0.0', docSha256: 'a', endpoints: ['GET /v1/x'], requiredFields: {}, responseFields: {} })),
    writeSnapshot: async (file, value) => { state.snapshots.push({ file, value }) },
    readApiCache: overrides.readApiCache ?? (async () => undefined),
    writeApiCache: async (file, value) => { state.caches.push({ file, value }) },
    writeFileAtomic: async () => {},
    ...(overrides.readImageFile === undefined ? {} : { readImageFile: overrides.readImageFile }),
    ...(overrides.persistHistory === undefined ? {} : { persistHistory: overrides.persistHistory }),
    renderApiStatus: (result) => `API: ${result.status}`,
    summarizeSpec: () => ({ infoVersion: '1.1.0', docSha256: 'b', endpoints: ['GET /v1/x', 'GET /v1/y'], requiredFields: {}, responseFields: {} }),
    compareContract: () => ({ status: 'changed', local: '1.0.0', live: '1.1.0', changes: ['新增 GET /v1/y'] }),
    fetchImpl: async () => ({ json: async () => ({ info: { version: '1.1.0' }, paths: {} }) }),
  })
  return { handlers, state }
}

test('state reports whether a key exists without ever returning it', async () => {
  const { handlers } = makeHandlers({ key: 'jws_live_secret_value' })
  const body = await bodyOf(await handlers.state())
  assert.equal(body.ok, true)
  assert.equal(body.hasKey, true)
  assert.equal(body.budgetCurrency, 'CNY')
  assert.equal(JSON.stringify(body).includes('jws_live_secret_value'), false)
})

test('state reports no key when none is configured', async () => {
  const { handlers } = makeHandlers({ key: undefined })
  const body = await bodyOf(await handlers.state())
  assert.equal(body.hasKey, false)
})

test('a malformed key is rejected without contacting the API', async () => {
  const { handlers, state } = makeHandlers({})
  const response = await handlers.key(postRequest({ apiKey: 'nope' }))
  assert.equal(response.status, 400)
  assert.equal(state.written.length, 0)
})

test('a key is verified before it is written', async () => {
  const { handlers, state } = makeHandlers({})
  const response = await handlers.key(postRequest({ apiKey: 'jws_live_good' }))
  assert.equal(response.status, 200)
  assert.deepEqual(state.written, [{ dir: '/tmp/cfg', key: 'jws_live_good' }])
})

test('a key the API rejects is not written, and is not echoed back', async () => {
  const { handlers, state } = makeHandlers({
    client: { catalog: async () => { throw new Error('JWS HTTP 401: bad key jws_live_bad') } },
  })
  const response = await handlers.key(postRequest({ apiKey: 'jws_live_bad' }))
  assert.equal(response.status, 401)
  assert.equal(state.written.length, 0)
  const body = await bodyOf(response)
  assert.equal(body.error.includes('jws_live_bad'), false)
  assert.match(body.error, /已隐藏/u)
})

test('catalog needs a key and trims the records for the browser', async () => {
  const { handlers } = makeHandlers({ key: undefined })
  assert.equal((await handlers.catalog()).status, 409)

  const withKey = makeHandlers({ key: 'jws_live_x' })
  const body = await bodyOf(await withKey.handlers.catalog())
  assert.equal(body.ok, true)
  assert.equal(body.models.length, 1)
  assert.equal(body.models[0].id, 'image:a')
  // Pricing internals must not ride along.
  assert.equal('tokenPricing' in body.models[0], false)
})

test('publicModel tolerates a sparse record', () => {
  const model = publicModel({ id: 'image:z' })
  assert.equal(model.name, 'image:z')
  assert.deepEqual(model.modes, [])
  assert.deepEqual(model.skus, [])
})

test('quote requires a prompt and returns the price with the budget', async () => {
  const { handlers } = makeHandlers({ key: 'jws_live_x' })
  assert.equal((await handlers.quote(postRequest({ prompt: '  ' }))).status, 400)

  const body = await bodyOf(await handlers.quote(postRequest({ prompt: 'a cat' })))
  assert.equal(body.ok, true)
  assert.equal(body.amount, 0.5)
  assert.equal(body.currency, 'USD')
  assert.equal(body.maxAmount, 20)
  assert.equal(body.budgetCurrency, 'CNY')
  assert.equal(body.model, 'image:a')
})

test('quote never asks the API without a key', async () => {
  const { handlers } = makeHandlers({ key: undefined })
  assert.equal((await handlers.quote(postRequest({ prompt: 'a cat' }))).status, 409)
})

test('generate returns base64 images, records history, and stays budget-gated', async () => {
  const { handlers, state } = makeHandlers({ key: 'jws_live_x' })
  const body = await bodyOf(await handlers.generate(postRequest({ prompt: 'a cat' })))
  assert.equal(body.ok, true)
  assert.equal(body.taskId, 'task-9')
  assert.equal(body.images.length, 1)
  assert.equal(body.images[0].mediaType, 'image/png')
  assert.equal(body.images[0].data, Buffer.from([1, 2, 3]).toString('base64'))
  assert.equal(body.amount, 0.5)
  assert.equal(state.generated.length, 1)
  assert.equal(state.generated[0].taskId, 'task-9')
})

test('generate refuses an over-budget quote with 402 and records nothing', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    runGeneration: async () => ({ overBudget: true, amount: 99, currency: 'USD', maxAmount: 20, quoteId: 'q' }),
  })
  const response = await handlers.generate(postRequest({ prompt: 'a cat' }))
  assert.equal(response.status, 402)
  assert.equal(state.generated.length, 0)
  assert.match((await bodyOf(response)).error, /预算/u)
})

test('generate surfaces an API failure without leaking the key', async () => {
  const { handlers } = makeHandlers({
    key: 'jws_live_leak',
    runGeneration: async () => { throw new Error('JWS HTTP 500: rejected jws_live_leak') },
  })
  const response = await handlers.generate(postRequest({ prompt: 'a cat' }))
  assert.equal(response.status, 502)
  assert.equal((await bodyOf(response)).error.includes('jws_live_leak'), false)
})

test('a finished generation is handed to the history store', async () => {
  const persisted = []
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    persistHistory: async (entries) => { persisted.push(entries.map((entry) => entry.taskId)) },
  })
  await handlers.generate(postRequest({ prompt: 'a cat' }))
  // Without this the history dies with the process, and its thumbnails would
  // stop resolving after every restart.
  assert.deepEqual(persisted, [['task-9']])
})

test('a failing history write does not fail a generation that already happened', async () => {
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    persistHistory: async () => { throw new Error('disk full') },
  })
  const response = await handlers.generate(postRequest({ prompt: 'a cat' }))
  assert.equal(response.status, 200)
  assert.equal((await bodyOf(response)).ok, true)
})

// #region reference images

test('referencesFromBody converts base64 into upload payloads', () => {
  const data = Buffer.from([1, 2, 3]).toString('base64')
  const { references, referenceFiles } = referencesFromBody({
    references: [{ mimeType: 'image/jpeg', name: 'a.jpg', data }],
  })
  assert.equal(references.length, 1)
  assert.equal(references[0].mimeType, 'image/jpeg')
  assert.equal(references[0].name, 'a.jpg')
  assert.deepEqual([...referenceFiles[0].bytes], [1, 2, 3])
})

test('referencesFromBody drops junk, caps at 16, and distrusts the mime type', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    mimeType: 'image/png',
    data: Buffer.from([index]).toString('base64'),
  }))
  const junk = [{ data: '' }, { data: null }, null, 'nope', { mimeType: 'image/png' }]
  assert.equal(referencesFromBody({ references: [...many, ...junk] }).references.length, 16)
  // A browser-reported type is not trusted: a non-image falls back to png.
  assert.equal(referencesFromBody({ references: [{ data: 'AAAA', mimeType: 'text/html' }] }).references[0].mimeType, 'image/png')
  assert.deepEqual(referencesFromBody({}).references, [])
  assert.deepEqual(referencesFromBody({ references: 'nope' }).references, [])
})

test('a reference image switches the quote to image-to-image', async () => {
  const modes = []
  const quoted = []
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    resolveModelAndParams: async (options) => {
      modes.push(options.mode)
      return { model: 'image:a', params: { size: '1:1', resolution: '1K', quality: 'auto', count: 1 }, catalogPicked: false }
    },
    client: {
      quote: async (input) => {
        quoted.push(input)
        return { quoteId: 'q', amount: 1, currency: 'USD', expiresAt: new Date(Date.now() + 60_000).toISOString() }
      },
    },
  })
  const data = Buffer.from([9, 8, 7]).toString('base64')
  const response = await handlers.quote(postRequest({ prompt: 'a cat', references: [{ mimeType: 'image/png', data }] }))
  assert.equal(response.status, 200)
  assert.deepEqual(modes, ['image-to-image'])
  assert.equal(quoted[0].params.mode, 'image-to-image')
  assert.equal(quoted[0].params.referenceCount, 1)
})

test('without references the quote stays text-to-image', async () => {
  const modes = []
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    resolveModelAndParams: async (options) => {
      modes.push(options.mode)
      return { model: 'image:a', params: { count: 1 }, catalogPicked: false }
    },
  })
  await handlers.quote(postRequest({ prompt: 'a cat' }))
  assert.deepEqual(modes, ['text-to-image'])
})

test('reference bytes reach the generation flow', async () => {
  const seen = []
  const modes = []
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    resolveModelAndParams: async (options) => {
      modes.push(options.mode)
      return { model: 'image:a', params: { count: 1 }, catalogPicked: false }
    },
    runGeneration: async (options) => {
      seen.push(options.args)
      return { taskId: 't1', files: [], amount: 1, currency: 'USD' }
    },
  })
  const data = Buffer.from([1, 2, 3]).toString('base64')
  const response = await handlers.generate(postRequest({ prompt: 'a cat', references: [{ mimeType: 'image/png', data }] }))
  assert.equal(response.status, 200)
  assert.deepEqual(modes, ['image-to-image'])
  assert.equal(seen[0].references.length, 1)
  assert.deepEqual([...seen[0].referenceFiles[0].bytes], [1, 2, 3])
  assert.equal(seen[0].referenceFiles[0].mimeType, 'image/png')
})

// #endregion

test('task needs an id and proxies the poll', async () => {
  const { handlers } = makeHandlers({ key: 'jws_live_x' })
  assert.equal((await handlers.task(getRequest(`${ROUTE_PREFIX}/task`))).status, 400)
  const body = await bodyOf(await handlers.task(getRequest(`${ROUTE_PREFIX}/task?id=t1`)))
  assert.equal(body.task.id, 't1')
})

test('api-status degrades to unknown when no snapshot is readable', async () => {
  const { handlers } = makeHandlers({ readSnapshot: async () => undefined })
  const body = await bodyOf(await handlers.apiStatus(getRequest(`${ROUTE_PREFIX}/api-status`)))
  assert.equal(body.status, 'unknown')
  assert.match(body.line, /无法核对/u)
})

test('api-update re-pins the snapshot and reports the diff', async () => {
  const { handlers, state } = makeHandlers({})
  const body = await bodyOf(await handlers.apiUpdate())
  assert.equal(body.ok, true)
  assert.equal(body.status, 'changed')
  assert.deepEqual(body.changes, ['新增 GET /v1/y'])
  assert.equal(state.snapshots.length, 1)
  assert.equal(state.snapshots[0].file, '/tmp/snapshot.json')
  // The refreshed summary also invalidates the TTL cache.
  assert.equal(state.caches.length, 1)
})

test('history-image serves the bytes of a recorded task', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    readImageFile: async () => new Uint8Array([137, 80, 78, 71]),
  })
  state.generated.push({ taskId: 't1', files: ['/tmp/out/image-1.png'], amount: 1, currency: 'USD' })
  const response = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=0`))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  // The id does not survive a restart, so a cached body would outlive it.
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [137, 80, 78, 71])
})

test('history-image picks the right content type per extension', async () => {
  const { handlers, state } = makeHandlers({ readImageFile: async () => new Uint8Array([1]) })
  state.generated.push({ taskId: 't1', files: ['/tmp/out/a.jpg', '/tmp/out/b.webp'] })
  const jpg = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=0`))
  const webp = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=1`))
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg')
  assert.equal(webp.headers.get('content-type'), 'image/webp')
})

test('history-image refuses a task it never recorded', async () => {
  const { handlers } = makeHandlers({ readImageFile: async () => new Uint8Array([1]) })
  assert.equal((await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=nope`))).status, 404)
  assert.equal((await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image`))).status, 400)
})

test('history-image rejects a malformed or out-of-range index', async () => {
  const { handlers, state } = makeHandlers({ readImageFile: async () => new Uint8Array([1]) })
  state.generated.push({ taskId: 't1', files: ['/tmp/out/a.png'] })
  assert.equal((await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=-1`))).status, 400)
  assert.equal((await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=x`))).status, 400)
  assert.equal((await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=7`))).status, 404)
})

test('history-image never serves a file outside the output directory', async () => {
  // The path comes from our own record, not the caller, but a corrupt record
  // must not become an arbitrary-file read either.
  let read = 0
  const { handlers, state } = makeHandlers({
    readImageFile: async () => { read += 1; return new Uint8Array([1]) },
  })
  state.generated.push({ taskId: 't1', files: ['/etc/passwd'] })
  const response = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=0`))
  assert.equal(response.status, 403)
  assert.equal(read, 0, 'the file must not even be opened')
})

test('history-image reports an unreadable file instead of throwing', async () => {
  const { handlers, state } = makeHandlers({
    readImageFile: async () => { throw new Error('ENOENT') },
  })
  state.generated.push({ taskId: 't1', files: ['/tmp/out/gone.png'] })
  const response = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=t1&index=0`))
  assert.equal(response.status, 404)
  assert.match((await bodyOf(response)).error, /读不到/u)
})

test('registerRoutes degrades to zero when Connection is absent', () => {
  assert.equal(registerRoutes({ get: () => undefined }, {}), 0)
  assert.equal(registerRoutes({}, {}), 0)
})

test('registerRoutes accepts an injected scope that carries connection directly', () => {
  // `ctx.inject(['connection'], scope => ...)` hands back a scope whose service
  // is a property, not a `get` lookup; both shapes must work.
  const registered = []
  const scope = { connection: { fetch: { register: (route) => registered.push(route) } } }
  assert.equal(registerRoutes(scope, {
    spec: { baseURL: 'https://x', maxAmount: 20, credentialsDir: '/tmp', cacheFile: '/tmp/c', snapshotCacheFile: '/tmp/s', apiCheckTtlMs: 1 },
    budgetCurrency: 'CNY',
    history: [],
    readApiKey: async () => undefined,
    writeApiKey: async () => {},
    isValidKey: () => true,
    createClient: () => ({}),
    runGeneration: async () => ({}),
    resolveModelAndParams: async () => ({ model: 'image:a', params: {} }),
    checkApiStatus: async () => ({ status: 'unknown', changes: [] }),
    readSnapshot: async () => undefined,
    writeSnapshot: async () => {},
    readApiCache: async () => undefined,
    writeApiCache: async () => {},
    writeFileAtomic: async () => {},
    renderApiStatus: () => 'API: x',
    summarizeSpec: () => ({}),
    compareContract: () => ({ status: 'up-to-date', changes: [] }),
  }), 10)
  assert.equal(registered.length, 10)
})

test('registerRoutes mounts every route under the shared prefix', () => {
  const registered = []
  const ctx = {
    get: (name) => (name === 'connection' ? { fetch: { register: (route) => registered.push(route) } } : undefined),
  }
  const count = registerRoutes(ctx, {
    spec: { baseURL: 'https://x', maxAmount: 20, credentialsDir: '/tmp', cacheFile: '/tmp/c', snapshotCacheFile: '/tmp/s', apiCheckTtlMs: 1 },
    budgetCurrency: 'CNY',
    history: [],
    readApiKey: async () => undefined,
    writeApiKey: async () => {},
    isValidKey: () => true,
    createClient: () => ({}),
    runGeneration: async () => ({}),
    resolveModelAndParams: async () => ({ model: 'image:a', params: {} }),
    checkApiStatus: async () => ({ status: 'unknown', changes: [] }),
    readSnapshot: async () => undefined,
    writeSnapshot: async () => {},
    readApiCache: async () => undefined,
    writeApiCache: async () => {},
    writeFileAtomic: async () => {},
    renderApiStatus: () => 'API: x',
    summarizeSpec: () => ({}),
    compareContract: () => ({ status: 'up-to-date', changes: [] }),
  })
  assert.equal(count, 10)
  assert.equal(registered.length, 10)
  for (const route of registered) {
    assert.equal(route.path.startsWith(`${ROUTE_PREFIX}/`), true, route.path)
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
    assert.deepEqual(route.methods, route.path.endsWith('/key') || route.path.endsWith('/quote') || route.path.endsWith('/generate') || route.path.endsWith('/api-update') ? ['POST'] : ['GET'])
  }
})

test('a route collision is logged and skipped, not fatal', () => {
  const ctx = {
    logger: { warn: () => {} },
    get: () => ({ fetch: { register: () => { throw new Error('duplicate path') } } }),
  }
  assert.equal(registerRoutes(ctx, {
    spec: { baseURL: 'https://x', maxAmount: 20, credentialsDir: '/tmp', cacheFile: '/tmp/c', snapshotCacheFile: '/tmp/s', apiCheckTtlMs: 1 },
    budgetCurrency: 'CNY',
    history: [],
    readApiKey: async () => undefined,
    writeApiKey: async () => {},
    isValidKey: () => true,
    createClient: () => ({}),
    runGeneration: async () => ({}),
    resolveModelAndParams: async () => ({ model: 'image:a', params: {} }),
    checkApiStatus: async () => ({ status: 'unknown', changes: [] }),
    readSnapshot: async () => undefined,
    writeSnapshot: async () => {},
    readApiCache: async () => undefined,
    writeApiCache: async () => {},
    writeFileAtomic: async () => {},
    renderApiStatus: () => 'API: x',
    summarizeSpec: () => ({}),
    compareContract: () => ({ status: 'up-to-date', changes: [] }),
  }), 0)
})

test('redact hides a key and tolerates a missing one', () => {
  assert.equal(redact('bad jws_live_abc', 'jws_live_abc'), 'bad [已隐藏]')
  assert.equal(redact('plain', undefined), 'plain')
  assert.equal(redact(undefined, 'k'), '接口暂不可用')
})