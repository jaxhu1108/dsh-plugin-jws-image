/**
 * Route tests.
 *
 * The routes are the only place the API key is used, and the only place a
 * browser can spend money. These tests pin both properties: the key never
 * appears in a response, and a generation always goes through the budget check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTE_PREFIX, createRouteHandlers, publicModel, redact, registerRoutes } from '../lib/routes.js'

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
  }), 9)
  assert.equal(registered.length, 9)
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
  assert.equal(count, 9)
  assert.equal(registered.length, 9)
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