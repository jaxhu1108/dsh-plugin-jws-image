/**
 * Model and SKU resolution tests.
 *
 * The rule under test is the one that keeps the plugin from pinning a model id:
 * an explicit argument wins, then the configured default, and only when both are
 * absent does the live catalog decide — including the SKU parameters, so a
 * default call can never quote a size the account does not sell.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveModelAndParams } from '../lib/index.js'

/** A client stub whose catalog records whether it was consulted. */
function stubClient(models) {
  const state = { catalogCalls: 0 }
  return {
    state,
    client: {
      catalog: async () => { state.catalogCalls += 1; return models },
    },
  }
}

test('an explicit argument model wins over the configured default', async () => {
  const { client } = stubClient([{ id: 'image:explicit', modes: ['text-to-image'], skus: [{ mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' }] }])
  const chosen = await resolveModelAndParams({
    client,
    args: { model: 'image:explicit', params: { count: 2 } },
    spec: { defaultModel: 'image:configured' },
  })
  assert.equal(chosen.model, 'image:explicit')
  assert.equal(chosen.catalogPicked, false)
  assert.equal(chosen.params.count, 2)
})

test('the configured default is used before the catalog picks a model', async () => {
  const { client } = stubClient([{ id: 'image:from-catalog', modes: ['text-to-image'], skus: [{ mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' }] }])
  const chosen = await resolveModelAndParams({
    client,
    args: {},
    spec: { defaultModel: 'image:configured' },
  })
  assert.equal(chosen.model, 'image:configured')
  assert.equal(chosen.catalogPicked, false)
})

test('with no model anywhere the catalog picks a text-to-image model and its SKU', async () => {
  const { client, state } = stubClient([
    { id: 'image:video-only', modes: ['image-to-image'], skus: [{ size: '9:16', resolution: '1K', quality: 'low' }] },
    { id: 'image:first', modes: ['text-to-image'], skus: [{ size: '3:4', resolution: '2K', quality: 'high' }] },
  ])
  const chosen = await resolveModelAndParams({ client, args: {}, spec: {} })
  assert.equal(state.catalogCalls, 1)
  assert.equal(chosen.catalogPicked, true)
  // The first model that advertises text-to-image, not simply the first model.
  assert.equal(chosen.model, 'image:first')
  assert.deepEqual(chosen.params, { size: '3:4', resolution: '2K', quality: 'high', count: 1 })
})

test('call arguments override the catalog-chosen SKU', async () => {
  const { client } = stubClient([
    { id: 'image:first', modes: ['text-to-image'], skus: [{ size: '3:4', resolution: '2K', quality: 'high' }] },
  ])
  const chosen = await resolveModelAndParams({ client, args: { params: { size: '1:1' } }, spec: {} })
  assert.equal(chosen.params.size, '1:1')
  assert.equal(chosen.params.resolution, '2K')
})

test('a model without text-to-image still resolves when it is all the catalog has', async () => {
  const { client } = stubClient([{ id: 'image:edit-only', modes: ['image-to-image'], skus: [] }])
  const chosen = await resolveModelAndParams({ client, args: {}, spec: {} })
  assert.equal(chosen.model, 'image:edit-only')
  // No SKU to copy: the last-resort parameters keep the call quotable.
  assert.deepEqual(chosen.params, { size: '1:1', resolution: '1K', quality: 'auto', count: 1 })
})

test('an empty catalog is a readable error, not a crash', async () => {
  const { client } = stubClient([])
  await assert.rejects(
    () => resolveModelAndParams({ client, args: {}, spec: {} }),
    /实时目录没有可用的图片模型/u,
  )
})

test('the SKU is picked by mode, not by position', async () => {
  // The API demands mode/size/resolution/quality from ONE skus[] record, so an
  // image-to-image call must not inherit the first (text-to-image) record.
  const { client } = stubClient([{
    id: 'image:dual',
    modes: ['text-to-image', 'image-to-image'],
    skus: [
      { mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' },
      { mode: 'image-to-image', size: '16:9', resolution: '4K', quality: 'high' },
    ],
  }])
  const text = await resolveModelAndParams({ client, args: {}, spec: {}, mode: 'text-to-image' })
  assert.equal(text.params.size, '1:1')
  const edit = await resolveModelAndParams({ client, args: {}, spec: {}, mode: 'image-to-image' })
  assert.deepEqual(edit.params, { size: '16:9', resolution: '4K', quality: 'high', count: 1 })
})

test('the catalog is consulted even when the model id is explicit', async () => {
  // A guessed size/resolution/quality triple rarely lands on a real SKU, so the
  // explicit-model path still upgrades its parameters from the catalog.
  const { client, state } = stubClient([{
    id: 'image:named',
    modes: ['text-to-image'],
    skus: [{ mode: 'text-to-image', size: '21:9', resolution: '2K', quality: 'medium' }],
  }])
  const chosen = await resolveModelAndParams({ client, args: { model: 'image:named' }, spec: {} })
  assert.equal(state.catalogCalls, 1)
  assert.equal(chosen.model, 'image:named')
  assert.equal(chosen.catalogPicked, false)
  assert.deepEqual(chosen.params, { size: '21:9', resolution: '2K', quality: 'medium', count: 1 })
})

test('an unreadable catalog still lets an explicit model through', async () => {
  const client = { catalog: async () => { throw new Error('offline') } }
  const chosen = await resolveModelAndParams({ client, args: { model: 'image:named' }, spec: {} })
  assert.equal(chosen.model, 'image:named')
  assert.deepEqual(chosen.params, { size: '1:1', resolution: '1K', quality: 'auto', count: 1 })
})

test('an unreadable catalog is fatal only when nothing named a model', async () => {
  const client = { catalog: async () => { throw new Error('offline') } }
  await assert.rejects(
    () => resolveModelAndParams({ client, args: {}, spec: {} }),
    /offline/u,
  )
})

test('an explicit model missing from the catalog keeps the requested id', async () => {
  const { client } = stubClient([{ id: 'image:other', modes: ['text-to-image'], skus: [{ mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' }] }])
  const chosen = await resolveModelAndParams({ client, args: { model: 'image:retired' }, spec: {} })
  // The API is the judge on whether that id still exists; inventing a
  // substitute would silently bill the user for a different model.
  assert.equal(chosen.model, 'image:retired')
  assert.equal(chosen.params.size, '1:1')
})