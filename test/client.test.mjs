import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** Load the classic-script bundle against a fake module loader. */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const window = {
    __ModuleLoader__: { load: (record) => { captured = record } },
  }
  const require = (id) => {
    if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require: ${id}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  return captured
}

test('bundle declares the package id', async () => {
  const record = await loadBundle()
  assert.equal(record.id, 'dsh-plugin-jws-image')
  assert.equal(typeof record.factory, 'function')
})

test('factory exposes the cordis client shape', async () => {
  const record = await loadBundle()
  const exports = record.factory((id) => {
    if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers into conversation.composer.dock', async () => {
  const record = await loadBundle()
  const exports = record.factory((id) => {
    if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require: ${id}`)
  })
  const registered = []
  const ctx = { slots: { register: (options) => { registered.push(options) } } }
  exports.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'conversation.composer.dock')
  assert.equal(registered[0].id, 'jws-image')
})

test('apply never throws when slots is missing', async () => {
  const record = await loadBundle()
  const exports = record.factory((id) => {
    if (id === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require: ${id}`)
  })
  assert.doesNotThrow(() => exports.apply({ get: () => undefined }))
})