/**
 * Browser-half tests.
 *
 * These deliberately model the REAL slot contract rather than a friendly stub.
 * The stub that used to live here accepted `ctx.slots.register(...)` directly,
 * which is precisely the call DSH rejects with `slot "<name>" is not declared`
 * — so the test passed while the entry never appeared in the browser. The mock
 * below therefore throws on an undeclared slot exactly like `SlotCore.register`,
 * and only honours registrations made through `slots.inject(...)`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const REACT = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useState: (initial) => [initial, () => {}],
}

/** Load the classic-script bundle against a fake module loader. */
async function loadBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const window = { __ModuleLoader__: { load: (record) => { captured = record } } }
  const require = (id) => {
    if (id === 'react') return REACT
    throw new Error(`unexpected require: ${id}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  return captured
}

/** Materialize the bundle's exports. */
async function loadExports() {
  const record = await loadBundle()
  return record.factory((id) => {
    if (id === 'react') return REACT
    throw new Error(`unexpected require: ${id}`)
  })
}

/**
 * A slot registry that behaves like the real one.
 *
 * @param options - which slots start out declared, and an optional dispose spy.
 * @returns the fake `ctx.slots` plus the recorded registrations.
 */
function fakeSlots(options = {}) {
  const { declared = [], onDispose } = options
  const live = new Set(declared)
  const registrations = []
  const waiters = new Map()

  function declare(slot) {
    live.add(slot)
    for (const callback of waiters.get(slot) ?? []) callback()
    waiters.delete(slot)
  }

  return {
    registrations,
    declare,
    slots: {
      /** Mirrors SlotCore.register: an undeclared slot is a hard error. */
      register(entry, component) {
        if (!live.has(entry.name)) {
          throw new Error(`slot "${entry.name}" is not declared (a parent entry's children table must declare it)`)
        }
        registrations.push({ entry, component })
        return () => { if (onDispose) onDispose(entry) }
      },
      /** Mirrors SlotRegistry.inject: immediate when declared, else deferred. */
      inject(slot, callback) {
        if (live.has(slot)) { callback(); return () => {} }
        const list = waiters.get(slot) ?? []
        list.push(callback)
        waiters.set(slot, list)
        return () => {
          const current = waiters.get(slot)
          if (current === undefined) return
          waiters.set(slot, current.filter((fn) => fn !== callback))
        }
      },
    },
  }
}

test('bundle declares the package id and the cordis client shape', async () => {
  const record = await loadBundle()
  assert.equal(record.id, 'dsh-plugin-jws-image')
  assert.equal(typeof record.factory, 'function')
  const exports = await loadExports()
  assert.equal(typeof exports.apply, 'function')
  // The client half needs the slot registry, declared the way DSH expects.
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply registers into conversation.composer.dock through inject', async () => {
  const exports = await loadExports()
  const { slots, registrations } = fakeSlots({ declared: ['conversation.composer.dock'] })
  exports.apply({ slots })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].entry.name, 'conversation.composer.dock')
  assert.equal(registrations[0].entry.id, 'jws-image')
  assert.equal(typeof registrations[0].component, 'function')
})

test('a bare register() call would throw, which is why inject is required', async () => {
  // Guards the regression directly: the shape that used to be shipped fails.
  const { slots } = fakeSlots({ declared: [] })
  assert.throws(
    () => slots.register({ name: 'conversation.composer.dock', id: 'jws-image' }, () => null),
    /is not declared/u,
  )
})

test('a slot declared later still receives the entry', async () => {
  // The dock is declared by an entry inside conversation.composer.bar. At plugin
  // startup that entry may not be mounted yet, so waiting is the normal path —
  // and the one that a bare register() cannot handle.
  const exports = await loadExports()
  const { slots, registrations, declare } = fakeSlots({ declared: [] })
  exports.apply({ slots })
  assert.equal(registrations.length, 0)

  declare('conversation.composer.dock')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].entry.name, 'conversation.composer.dock')
})

test('the best declared candidate wins and the others stay empty', async () => {
  // All three candidates exist on current DSH; the entry must appear exactly
  // once, in the first one.
  const exports = await loadExports()
  const { slots, registrations } = fakeSlots({
    declared: ['conversation.input.right', 'conversation.input.left'],
  })
  exports.apply({ slots })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].entry.name, 'conversation.input.right')
})

test('the preferred slot wins when every candidate is declared', async () => {
  const exports = await loadExports()
  const { slots, registrations } = fakeSlots({
    declared: ['conversation.composer.dock', 'conversation.input.right', 'conversation.input.left'],
  })
  exports.apply({ slots })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].entry.name, 'conversation.composer.dock')
})

test('apply never throws when the slots service is missing or partial', async () => {
  const exports = await loadExports()
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply({ slots: undefined }))
  assert.doesNotThrow(() => exports.apply({ get: () => undefined }))
  // A service without the declaration-aware API must degrade, not throw.
  assert.doesNotThrow(() => exports.apply({ slots: { register: () => {} } }))
})

test('the entry renders a clickable button labelled in Chinese', async () => {
  const exports = await loadExports()
  const { slots, registrations } = fakeSlots({ declared: ['conversation.composer.dock'] })
  exports.apply({ slots })

  const element = registrations[0].component()
  assert.equal(element.type, 'button')
  assert.equal(element.props.type, 'button')
  assert.equal(element.props.className, 'jws-image-entry')
  assert.equal(typeof element.props.onClick, 'function')
  // Single string child: assert on the collected child list, which is what this
  // mock's createElement receives (React itself passes the bare string).
  assert.deepEqual(element.children, ['JWS 生图'])
  // Styling is inline so the entry cannot depend on DSH's internal CSS.
  assert.equal(typeof element.props.style, 'object')
})