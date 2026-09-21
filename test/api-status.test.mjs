import assert from 'node:assert/strict'
import test from 'node:test'

import { checkApiStatus } from '../lib/index.js'

const snapshot = { infoVersion: '1.0.0', docSha256: 'a', endpoints: [], requiredFields: {}, responseFields: {} }
const liveDoc = { info: { version: '1.0.0' }, paths: {} }

test('a fresh cache is reused without fetching', async () => {
  let fetched = 0
  const result = await checkApiStatus({
    fetchSpec: async () => { fetched += 1; return liveDoc },
    snapshot,
    cache: { checkedAt: 1000, summary: snapshot },
    now: 2000,
    ttlMs: 86400000,
    force: false,
  })
  assert.equal(fetched, 0)
  assert.equal(result.status, 'up-to-date')
})

test('an expired cache refetches', async () => {
  let fetched = 0
  const result = await checkApiStatus({
    fetchSpec: async () => { fetched += 1; return liveDoc },
    snapshot,
    cache: { checkedAt: 0, summary: snapshot },
    now: 86400001,
    ttlMs: 86400000,
    force: false,
  })
  assert.equal(fetched, 1)
  // The stub snapshot carries a placeholder fingerprint (`docSha256: 'a'`), so a
  // fresh summarize can never match it byte-for-byte: the surface is intact but
  // the document hash differs, which is exactly `changed`.
  assert.equal(result.status, 'changed')
  assert.equal(result.cached, false)
})

test('force ignores a fresh cache', async () => {
  let fetched = 0
  await checkApiStatus({
    fetchSpec: async () => { fetched += 1; return liveDoc },
    snapshot,
    cache: { checkedAt: 1000, summary: snapshot },
    now: 2000,
    ttlMs: 86400000,
    force: true,
  })
  assert.equal(fetched, 1)
})

test('an unreachable endpoint degrades to unknown', async () => {
  const result = await checkApiStatus({
    fetchSpec: async () => { throw new Error('offline') },
    snapshot, cache: undefined, now: 0, ttlMs: 1, force: true,
  })
  assert.equal(result.status, 'unknown')
})