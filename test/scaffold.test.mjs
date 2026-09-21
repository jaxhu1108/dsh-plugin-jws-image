import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

test('plugin exports the host shape', () => {
  assert.equal(name, 'tool-jws-image')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers jws_generate_image', () => {
  let definition
  const ctx = { tools: { register: (value) => { definition = value } }, get: () => undefined }
  apply(ctx, {})
  assert.ok(definition, 'apply() must register a tool')
  assert.equal(definition.name, 'jws_generate_image')
})