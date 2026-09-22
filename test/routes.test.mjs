/**
 * Route tests.
 *
 * The routes are the only place the API key is used, and the only place a
 * browser can spend money. These tests pin both properties: the key never
 * appears in a response, and a generation always goes through the budget check.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { ROUTE_PREFIX, createRouteHandlers, effectiveMaxAmount, insideDirectory, publicModel, redact, referenceLimit, referencesFromBody, refusalForReferences, registerRoutes } from '../lib/routes.js'

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
      outputDir: overrides.outputDir ?? '/tmp/out',
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
    ...(overrides.deleteFile === undefined ? {} : { deleteFile: overrides.deleteFile }),
    ...(overrides.removeEmptyDir === undefined ? {} : { removeEmptyDir: overrides.removeEmptyDir }),
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
  }), 11)
  assert.equal(registered.length, 11)
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
  assert.equal(count, 11)
  assert.equal(registered.length, 11)
  // The write endpoints; everything else is a read.
  const writes = ['/key', '/quote', '/generate', '/history-delete', '/api-update']
  for (const route of registered) {
    assert.equal(route.path.startsWith(`${ROUTE_PREFIX}/`), true, route.path)
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
    assert.deepEqual(
      route.methods,
      writes.some((suffix) => route.path.endsWith(suffix)) ? ['POST'] : ['GET'],
      route.path,
    )
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

// #region per-call budget

test('a per-call budget may tighten the ceiling but never raise it', () => {
  // The window's field is a tighter cap, not a replacement. These routes are
  // reachable from the page, so accepting a looser number would turn the
  // operator's circuit breaker into a suggestion.
  assert.equal(effectiveMaxAmount(5, 20), 5)
  assert.equal(effectiveMaxAmount(20, 20), 20)
  assert.equal(effectiveMaxAmount(999, 20), 20, 'a raised cap must be clamped')
  assert.equal(effectiveMaxAmount(0.01, 20), 0.01)
  // An absent or nonsensical request falls back to the ceiling, never to none.
  assert.equal(effectiveMaxAmount(undefined, 20), 20)
  assert.equal(effectiveMaxAmount(null, 20), 20)
  assert.equal(effectiveMaxAmount(-1, 20), 20)
  assert.equal(effectiveMaxAmount(Number.NaN, 20), 20)
  assert.equal(effectiveMaxAmount('30', 20), 20)
  assert.equal(effectiveMaxAmount(Number.POSITIVE_INFINITY, 20), 20)
})

test('a missing ceiling leaves the request as the only number there is', () => {
  assert.equal(effectiveMaxAmount(5, undefined), 5)
  assert.equal(effectiveMaxAmount(undefined, undefined), undefined)
})

test('quote honours a lowered budget and clamps a raised one', async () => {
  const seen = []
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    runGeneration: async (options) => {
      seen.push(options.maxAmount)
      return { taskId: 't', files: [], amount: 0.5, currency: 'USD' }
    },
  })

  // Lowered: the window's number is what the circuit breaker uses.
  const lowered = await bodyOf(await handlers.quote(postRequest({ prompt: 'a cat', maxAmount: 5 })))
  assert.equal(lowered.maxAmount, 5)

  // Raised: clamped back to the configured ceiling.
  const raised = await bodyOf(await handlers.quote(postRequest({ prompt: 'a cat', maxAmount: 999 })))
  assert.equal(raised.maxAmount, 20)

  // Absent: the ceiling.
  const absent = await bodyOf(await handlers.quote(postRequest({ prompt: 'a cat' })))
  assert.equal(absent.maxAmount, 20)

  // And the generation path runs under the same number.
  await handlers.generate(postRequest({ prompt: 'a cat', maxAmount: 7 }))
  await handlers.generate(postRequest({ prompt: 'a cat', maxAmount: 999 }))
  assert.deepEqual(seen, [7, 20])
})

test('a generation records the budget it actually ran under', async () => {
  const { handlers, state } = makeHandlers({ key: 'jws_live_x' })
  await handlers.generate(postRequest({ prompt: 'a cat', maxAmount: 3 }))
  // "The budget" is not one number any more, so the entry has to carry its own.
  assert.equal(state.generated[0].maxAmount, 3)
})

// #endregion

// #region per-model reference limits

test('referenceLimit reads only a real capability', () => {
  assert.equal(referenceLimit({ capabilities: { maxInputImages: 0 } }), 0)
  assert.equal(referenceLimit({ capabilities: { maxInputImages: 15 } }), 15)
  // An unknown capability must not become a limit of its own.
  assert.equal(referenceLimit({ capabilities: {} }), undefined)
  assert.equal(referenceLimit({}), undefined)
  assert.equal(referenceLimit({ capabilities: { maxInputImages: -1 } }), undefined)
  assert.equal(referenceLimit({ capabilities: { maxInputImages: 1.5 } }), undefined)
})

test('a model that takes no references is refused, not silently trimmed', () => {
  const textOnly = { model: 'image:grok', modes: ['text-to-image'], capabilities: { maxInputImages: 0 } }
  assert.match(refusalForReferences(textOnly, 1), /不支持图生图/u)

  const zeroCap = { model: 'image:zero', modes: ['text-to-image', 'image-to-image'], capabilities: { maxInputImages: 0 } }
  assert.match(refusalForReferences(zeroCap, 1), /不接受参考图/u)

  const capped = { model: 'image:one', modes: ['image-to-image'], capabilities: { maxInputImages: 1 } }
  assert.equal(refusalForReferences(capped, 1), undefined)
  assert.match(refusalForReferences(capped, 2), /最多接受 1 张/u)

  // No call without references, so no refusal to hand back.
  assert.equal(refusalForReferences(textOnly, 0), undefined)
})

test('an unknown capability is never turned into a refusal', () => {
  // A trimmed catalog record must not make a model the API would accept
  // unusable — the API is the authority on what it will take.
  assert.equal(refusalForReferences({ model: 'image:a' }, 3), undefined)
  assert.equal(refusalForReferences({ model: 'image:a', modes: [], capabilities: {} }, 3), undefined)
})

test('the quote refuses a reference count the model cannot take', async () => {
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    resolveModelAndParams: async () => ({
      model: 'image:one',
      params: { count: 1 },
      modes: ['image-to-image'],
      capabilities: { maxInputImages: 1 },
      catalogPicked: false,
    }),
  })
  const data = Buffer.from([1]).toString('base64')
  const one = { mimeType: 'image/png', data }
  assert.equal((await handlers.quote(postRequest({ prompt: 'a cat', references: [one] }))).status, 200)
  const response = await handlers.quote(postRequest({ prompt: 'a cat', references: [one, one] }))
  assert.equal(response.status, 400)
  assert.match((await bodyOf(response)).error, /最多接受 1 张/u)
})

test('the quote reports the ceiling so the window can bound its picker', async () => {
  const { handlers } = makeHandlers({
    key: 'jws_live_x',
    resolveModelAndParams: async () => ({
      model: 'image:many',
      params: { count: 1 },
      modes: ['text-to-image', 'image-to-image'],
      capabilities: { maxInputImages: 15 },
      catalogPicked: false,
    }),
  })
  const body = await bodyOf(await handlers.quote(postRequest({ prompt: 'a cat' })))
  assert.equal(body.referenceLimit, 15)
})

// #endregion

// #region history management

/** Seed a history through the generate route, so the shape is the real one. */
async function seedHistory(handlers, prompts) {
  for (const prompt of prompts) {
    await handlers.generate(postRequest({ prompt }))
  }
}

test('history-delete drops one task and keeps the rest', async () => {
  const persisted = []
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: [], amount: 1, currency: 'USD' }),
    persistHistory: async (entries) => { persisted.push(entries.map((entry) => entry.taskId)) },
  })
  await seedHistory(handlers, ['a', 'b', 'c'])
  const writesBeforeDelete = persisted.length
  assert.deepEqual(state.generated.map((entry) => entry.taskId), ['task-3', 'task-2', 'task-1'])

  const body = await bodyOf(await handlers.historyDelete(postRequest({ taskId: 'task-2' }, `${ROUTE_PREFIX}/history-delete`)))
  assert.equal(body.ok, true)
  assert.equal(body.removed, 1)
  assert.deepEqual(body.entries.map((entry) => entry.taskId), ['task-3', 'task-1'])
  // The in-memory array is shared with the tool half, so it must be mutated in
  // place rather than replaced.
  assert.deepEqual(state.generated.map((entry) => entry.taskId), ['task-3', 'task-1'])
  // And the surviving list is what got written back — one extra write, at the end.
  assert.equal(persisted.length, writesBeforeDelete + 1)
  assert.deepEqual(persisted.at(-1), ['task-3', 'task-1'])
})

test('history-delete clears everything with all: true', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: [], amount: 1, currency: 'USD' }),
  })
  await seedHistory(handlers, ['a', 'b'])
  const body = await bodyOf(await handlers.historyDelete(postRequest({ all: true }, `${ROUTE_PREFIX}/history-delete`)))
  assert.equal(body.removed, 2)
  assert.deepEqual(body.entries, [])
  assert.equal(state.generated.length, 0)
})

test('history-delete asks for a target, and 404s on one it never had', async () => {
  const { handlers } = makeHandlers({ key: 'jws_live_x' })
  assert.equal((await handlers.historyDelete(postRequest({}, `${ROUTE_PREFIX}/history-delete`))).status, 400)
  assert.equal((await handlers.historyDelete(postRequest({ taskId: 'nope' }, `${ROUTE_PREFIX}/history-delete`))).status, 404)
})

test('by default a history deletion never touches the files on disk', async () => {
  // The images are already paid for, and a mis-click on "清空历史" must not be
  // able to destroy them; the output directory stays their only owner. Deleting
  // the bytes is a second, explicit decision.
  const removed = []
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    deleteFile: async (path) => { removed.push(path) },
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: ['/tmp/out/task-1/image-1.png'], amount: 1, currency: 'USD' }),
  })
  await seedHistory(handlers, ['a', 'b'])
  await handlers.historyDelete(postRequest({ all: true }, `${ROUTE_PREFIX}/history-delete`))
  assert.deepEqual(removed, [])
  assert.equal(state.generated.length, 0)

  // Even an explicit deleteFiles: false is still records-only.
  removed.length = 0
  await seedHistory(handlers, ['c'])
  assert.equal(state.generated[0].taskId, 'task-1')
  await handlers.historyDelete(postRequest({ taskId: 'task-1', deleteFiles: false }, `${ROUTE_PREFIX}/history-delete`))
  assert.deepEqual(removed, [])
  assert.equal(state.generated.length, 0)
})

test('deleteFiles: true removes the recorded files and reports the count', async () => {
  const removed = []
  const dirs = []
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    deleteFile: async (path) => { removed.push(path) },
    removeEmptyDir: async (dir) => { dirs.push(dir) },
    runGeneration: async () => ({
      taskId: `task-${state.generated.length + 1}`,
      files: [`/tmp/out/task-${state.generated.length + 1}/image-1.png`, `/tmp/out/task-${state.generated.length + 1}/image-2.png`],
      amount: 1,
      currency: 'USD',
    }),
  })
  await seedHistory(handlers, ['a'])
  const body = await bodyOf(await handlers.historyDelete(
    postRequest({ all: true, deleteFiles: true }, `${ROUTE_PREFIX}/history-delete`),
  ))
  assert.equal(body.ok, true)
  assert.equal(body.removed, 1)
  assert.equal(body.deletedFiles, 2)
  assert.deepEqual(body.failedFiles, [])
  assert.equal(removed.length, 2)
  // The resolved path is what gets handed to the filesystem primitive.
  assert.deepEqual(removed, [
    resolve('/tmp/out/task-1/image-1.png'),
    resolve('/tmp/out/task-1/image-2.png'),
  ])
  // The per-task directory is empty now, and `rmdir` refuses a non-empty one,
  // so this can never take anything with it.
  assert.deepEqual(dirs, ['/tmp/out/task-1'].map((dir) => resolve(dir)))
})

test('a file that is already gone counts as deleted, not as a failure', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    deleteFile: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error },
    removeEmptyDir: async () => {},
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: ['/tmp/out/task-1/image-1.png'], amount: 1, currency: 'USD' }),
  })
  await seedHistory(handlers, ['a'])
  const body = await bodyOf(await handlers.historyDelete(
    postRequest({ all: true, deleteFiles: true }, `${ROUTE_PREFIX}/history-delete`),
  ))
  // Missing is the outcome the caller asked for, not a problem to report.
  assert.equal(body.deletedFiles, 1)
  assert.deepEqual(body.failedFiles, [])
})

test('a file that cannot be deleted is reported, and the record still goes', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    deleteFile: async () => { throw new Error('EBUSY: resource busy or locked') },
    removeEmptyDir: async () => {},
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: ['/tmp/out/task-1/image-1.png'], amount: 1, currency: 'USD' }),
  })
  await seedHistory(handlers, ['a'])
  const body = await bodyOf(await handlers.historyDelete(
    postRequest({ all: true, deleteFiles: true }, `${ROUTE_PREFIX}/history-delete`),
  ))
  // The record has to go either way: keeping it would leave the window listing
  // a task the user asked to forget, with no way to retry.
  assert.equal(body.removed, 1)
  assert.equal(body.deletedFiles, 0)
  assert.equal(body.failedFiles.length, 1)
  assert.match(body.failedFiles[0].error, /EBUSY/u)
  assert.equal(body.failedFiles[0].path, '/tmp/out/task-1/image-1.png')
  assert.equal(state.generated.length, 0)
})

test('a record pointing outside the output directory cannot delete anything', async () => {
  // The paths come from the server's own history file, but that file is plain
  // JSON on disk: a hand-edited record must not turn "delete this task's
  // images" into deleting something else.
  const removed = []
  const { handlers } = makeHandlers({ key: 'jws_live_x', deleteFile: async (path) => { removed.push(path) } })
  // Seeded through the route with escaped paths, exactly as a corrupt file
  // would look once read back at boot.
  const { handlers: seeded, state } = makeHandlers({
    key: 'jws_live_x',
    deleteFile: async (path) => { removed.push(path) },
    runGeneration: async () => ({
      taskId: 'task-1',
      files: ['../../windows/system32/config/SAM', '/tmp/outside/image-1.png', '/tmp/out/task-1/image-1.png'],
      amount: 1,
      currency: 'USD',
    }),
  })
  await seeded.generate(postRequest({ prompt: 'a cat' }))
  assert.equal(state.generated.length, 1)

  const body = await bodyOf(await seeded.historyDelete(
    postRequest({ all: true, deleteFiles: true }, `${ROUTE_PREFIX}/history-delete`),
  ))
  // Exactly one of the three is inside the output directory.
  assert.equal(removed.length, 1)
  assert.equal(resolve(removed[0]), resolve('/tmp/out/task-1/image-1.png'))
  assert.equal(body.deletedFiles, 1)
  // And the two it refused say so, rather than failing silently.
  assert.equal(body.failedFiles.length, 2)
  assert.equal(body.failedFiles.every((item) => item.error.includes('不在输出目录里')), true)
  assert.equal(typeof handlers.historyDelete, 'function')
})

test('insideDirectory refuses the directory itself and anything beside it', () => {
  // The deletion path must never be able to remove the directory it writes into.
  assert.equal(insideDirectory('/tmp/out', '/tmp/out/task-1/image-1.png'), true)
  assert.equal(insideDirectory('/tmp/out', '/tmp/out'), false)
  assert.equal(insideDirectory('/tmp/out', '/tmp/out/'), false)
  assert.equal(insideDirectory('/tmp/out', '/tmp/outside/image-1.png'), false)
  assert.equal(insideDirectory('/tmp/out', '/tmp/out/../../etc/passwd'), false)
  assert.equal(insideDirectory('/tmp/out', ''), false)
  assert.equal(insideDirectory(undefined, '/tmp/out/a.png'), false)
  // A sibling whose name merely starts with the same characters is outside.
  assert.equal(insideDirectory('/tmp/out', '/tmp/output/a.png'), false)
})

test('against the real filesystem the bytes go, and so does the directory they emptied', async () => {
  // Every other deletion test here injects `deleteFile` / `removeEmptyDir`, so
  // none of them can catch a path that resolves to the wrong place, or a
  // directory that is rmdir'd while something is still inside it. This one runs
  // the real unlink/rmdir and then looks at the disk.
  const root = await mkdtemp(join(tmpdir(), 'jws-del-'))
  const doomed = join(root, 'task-1')
  const kept = join(root, 'task-2')
  try {
    await mkdir(doomed, { recursive: true })
    await mkdir(kept, { recursive: true })
    const first = join(doomed, 'image-1.png')
    const second = join(doomed, 'image-2.png')
    // Recorded in the history, so it is a deletion target.
    await writeFile(first, 'one')
    await writeFile(second, 'two')
    // Present on disk but never recorded: the deletion path is driven by the
    // history, not by a directory scan, so this must survive untouched.
    const survivor = join(kept, 'image-1.png')
    await writeFile(survivor, 'three')

    const { handlers, state } = makeHandlers({
      key: 'jws_live_x',
      outputDir: root,
      runGeneration: async () => ({ taskId: 'task-1', files: [first, second], amount: 1, currency: 'USD' }),
    })
    await seedHistory(handlers, ['a'])

    const body = await bodyOf(await handlers.historyDelete(
      postRequest({ all: true, deleteFiles: true }, `${ROUTE_PREFIX}/history-delete`),
    ))
    assert.equal(body.deletedFiles, 2)
    assert.deepEqual(body.failedFiles, [])
    assert.equal(state.generated.length, 0)

    await assert.rejects(stat(first), { code: 'ENOENT' })
    await assert.rejects(stat(second), { code: 'ENOENT' })
    // Empty by now, so rmdir took it - and the empty-directory failure mode
    // (ENOTEMPTY) is exactly what a non-empty sibling would have produced.
    await assert.rejects(stat(doomed), { code: 'ENOENT' })
    // The unrecorded task is still whole, directory included.
    assert.equal((await stat(survivor)).size, 5)
    assert.equal((await stat(kept)).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the deletion path removes files one by one, never a whole tree', async () => {
  // `rm -rf` on an absolute path assembled from a history record is exactly the
  // shape of bug this feature could introduce, so pin the primitives instead.
  const source = await readFile(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function deleteEntryFiles(')
  const end = source.indexOf('\n  }', start)
  const helper = source.slice(start, end)
  assert.match(helper, /await deleteFile\(target\)/u)
  assert.match(helper, /await removeEmptyDir\(directory\)/u)
  // No recursive removal, and no shelling out.
  assert.doesNotMatch(helper, /rmSync|rm\(|recursive|child_process|exec\(/u)
})

test('a history deletion survives an unwritable home directory', async () => {
  const { handlers, state } = makeHandlers({
    key: 'jws_live_x',
    runGeneration: async () => ({ taskId: `task-${state.generated.length + 1}`, files: [], amount: 1, currency: 'USD' }),
    persistHistory: async () => { throw new Error('EACCES') },
  })
  await seedHistory(handlers, ['a'])
  const response = await handlers.historyDelete(postRequest({ all: true }, `${ROUTE_PREFIX}/history-delete`))
  // The in-memory list is already correct; the failed write must not undo it.
  assert.equal(response.status, 200)
  assert.equal(state.generated.length, 0)
})

test('history-image says the task is gone rather than blaming a restart', async () => {
  const { handlers } = makeHandlers({ key: 'jws_live_x' })
  const response = await handlers.historyImage(getRequest(`${ROUTE_PREFIX}/history-image?taskId=ghost&index=0`))
  assert.equal(response.status, 404)
  assert.match((await bodyOf(response)).error, /已被删除/u)
})

// #endregion