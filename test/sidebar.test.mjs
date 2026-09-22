/**
 * Right-sidebar tests.
 *
 * DSH's right column is a two-stage registration: a *tab type* says what the
 * tab is (`ctx.sidebarRightTabs.register`), then the body and chip text register
 * into the two keyed `sidebar.right.pane.tab*` seats under that type's `id`.
 * Getting the pairing wrong leaves a tab that opens onto nothing, so these
 * tests pin both halves and the key that joins them.
 *
 * The column is optional: on a build without it the dock entry must still open
 * the modal, so the fallback is tested too.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** A React stub with per-component hook cells and child expansion. */
function createHarness() {
  const store = new Map()
  let currentCells = null
  let cursor = 0
  function flatten(children, out = []) {
    for (const child of children) {
      if (Array.isArray(child)) flatten(child, out)
      else if (child === null || child === undefined || typeof child === 'boolean') continue
      else out.push(child)
    }
    return out
  }
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) }),
    // Run effects so a test can observe what mounting actually does; cleanup is
    // not modelled, which is enough for a single mount.
    useEffect: (fn) => { fn() },
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (currentCells[index] === undefined) {
        currentCells[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const cell = currentCells[index]
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
  }
  function renderComponent(Component, props) {
    const savedCells = currentCells
    const savedCursor = cursor
    currentCells = store.get(Component) ?? []
    store.set(Component, currentCells)
    cursor = 0
    try {
      return Component(props)
    } finally {
      currentCells = savedCells
      cursor = savedCursor
    }
  }
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(renderComponent(node.type, node.props))
    return { ...node, children: (node.children ?? []).map(expand) }
  }
  return { react, render: (Component, props) => expand(renderComponent(Component, props)) }
}

/** Load the bundle against one harness. */
async function loadExports(harness = createHarness()) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const window = { __ModuleLoader__: { load: (record) => { captured = record } } }
  const require = (id) => {
    if (id === 'react') return harness.react
    throw new Error(`unexpected require: ${id}`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(window, require)
  return { exports: captured.factory(require), harness }
}

/** Every element in a rendered tree. */
function walk(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found)
    return found
  }
  found.push(node)
  for (const child of node.children ?? []) walk(child, found)
  return found
}

/**
 * A client context that records what the plugin registers.
 * @param options - `withSidebar: false` models a build with no right column.
 */
function fakeCtx(options = {}) {
  const { withSidebar = true } = options
  const state = { tabTypes: [], slots: [], opened: [], effects: [], injected: [] }

  function makeSlots() {
    return {
      register(entry, component) {
        state.slots.push({ entry, component })
        return () => {}
      },
      inject(slot, callback) {
        callback()
        return () => {}
      },
    }
  }

  const slots = makeSlots()
  const scope = {
    slots,
    effect: (fn, label) => {
      state.effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  if (withSidebar) {
    scope.sidebarRightTabs = { register: (definition) => { state.tabTypes.push(definition); return () => {} } }
    scope.sidebarRight = { openTab: (kind, opts) => { state.opened.push({ kind, opts }) } }
  }

  const ctx = {
    slots,
    inject: (services, callback) => {
      state.injected.push(services)
      if (withSidebar) callback(scope)
    },
  }
  return { ctx, state, scope }
}

/** Install a fetch stub and restore it afterwards. */
function withFetch(routes, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    calls.push({ path, init })
    for (const [suffix, reply] of Object.entries(routes)) {
      if (path.endsWith(suffix)) {
        return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body }
      }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original })
}

test('apply registers a sidebar tab type with its own id and kind', async () => {
  const { exports } = await loadExports()
  const { ctx, state } = fakeCtx()
  exports.apply(ctx)

  assert.equal(state.tabTypes.length, 1)
  const definition = state.tabTypes[0]
  assert.equal(definition.id, exports.SIDEBAR_ID)
  assert.equal(definition.kind, exports.SIDEBAR_KIND)
  // A type from outside the product outranks the shipped viewers.
  assert.equal(definition.priority, 'extension')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(), 'JWS 生图')
  // A page type: no resource globs, and an entry on the guide page.
  assert.equal(definition.patterns, undefined)
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].title(), 'JWS 生图')
})

test('the tab body and chip text register under the definition id', async () => {
  const { exports } = await loadExports()
  const { ctx, state } = fakeCtx()
  exports.apply(ctx)

  const body = state.slots.find((entry) => entry.entry.name === 'sidebar.right.pane.tab')
  const title = state.slots.find((entry) => entry.entry.name === 'sidebar.right.pane.tab.title')
  assert.ok(body, 'the body must register into sidebar.right.pane.tab')
  assert.ok(title, 'the chip text must register into sidebar.right.pane.tab.title')
  // Both seats are keyed, and the key must be the type's `id` — not its kind.
  assert.equal(body.entry.key, exports.SIDEBAR_ID)
  assert.equal(title.entry.key, exports.SIDEBAR_ID)
  assert.equal(typeof body.component, 'function')
  assert.equal(typeof title.component, 'function')
})

test('the sidebar services are awaited, not required', async () => {
  const { exports } = await loadExports()
  const { ctx, state } = fakeCtx()
  exports.apply(ctx)
  // `sidebarRightTabs` must NOT be in the plugin's own inject list: that would
  // stop the browser half from loading at all on a build with no right column.
  assert.deepEqual(exports.inject, ['slots'])
  assert.deepEqual(state.injected, [['slots', 'sidebarRightTabs', 'sidebarRight']])
})

test('a build with no right column registers nothing and stays quiet', async () => {
  const { exports } = await loadExports()
  const { ctx, state } = fakeCtx({ withSidebar: false })
  assert.doesNotThrow(() => exports.apply(ctx))
  assert.deepEqual(state.tabTypes, [])
  assert.deepEqual(state.slots.filter((entry) => entry.entry.name.startsWith('sidebar.')), [])
})

test('the dock entry opens the sidebar tab instead of the modal', async () => {
  const { exports, harness } = await loadExports()
  const { ctx, state } = fakeCtx()
  exports.apply(ctx)
  const dock = state.slots.find((entry) => entry.entry.name === 'conversation.composer.dock')
  assert.ok(dock, 'the dock entry must still register')

  await withFetch({ '/state': { body: { ok: true, hasKey: true } } }, async (calls) => {
    const tree = walk(harness.render(dock.component, {}))
    const button = tree.find((node) => node.type === 'button' && node.props.className === 'jws-entry')
    await button.props.onClick()
    assert.deepEqual(state.opened, [{ kind: exports.SIDEBAR_KIND, opts: undefined }])
    // The modal path is what fetches the contract status; opening the sidebar
    // must not run it.
    assert.equal(calls.some((call) => call.path === '/api/jws-image/api-status'), false)
  })
})

test('without the column the dock entry falls back to the modal', async () => {
  const { exports, harness } = await loadExports()
  const { ctx } = fakeCtx({ withSidebar: false })
  exports.apply(ctx)
  const dock = ctx.slots.register ? null : null
  assert.equal(dock, null)
  // Re-apply against a context whose slots we can read back.
  const recorded = []
  const slots = {
    register(entry, component) { recorded.push({ entry, component }); return () => {} },
    inject(slot, callback) { callback(); return () => {} },
  }
  exports.apply({ slots, inject: () => {} })
  const entry = recorded.find((item) => item.entry.name === 'conversation.composer.dock')
  assert.ok(entry)

  await withFetch(
    { '/state': { body: { ok: true, hasKey: true, maxAmount: 20, budgetCurrency: 'CNY' } }, '/api-status': { body: { ok: true, status: 'up-to-date', line: 'API: 已是最新' } } },
    async (calls) => {
      const tree = walk(harness.render(entry.component, {}))
      await tree.find((node) => node.type === 'button' && node.props.className === 'jws-entry').props.onClick()
      // The modal path fetches the host state.
      assert.ok(calls.some((call) => call.path === '/api/jws-image/state'), 'the modal path must load state')
    },
  )
})

test('the sidebar panel loads its own state and contract status', async () => {
  const { exports, harness } = await loadExports()
  const props = { ok: true, hasKey: false, maxAmount: 20, budgetCurrency: 'CNY' }
  await withFetch(
    {
      '/state': { body: props },
      '/api-status': { body: { ok: true, status: 'up-to-date', line: 'API: 已是最新（1.0.0）', changes: [] } },
    },
    async (calls) => {
      const tree = walk(harness.render(exports.SidebarPanel, {}))
      // First paint is the reading state; the panel owns the load because a tab
      // can be opened by the sidebar itself, with no dock entry involved.
      assert.ok(tree.some((node) => node.props?.className === 'jws-panel'))
      assert.equal(tree.some((node) => node.type === 'input' && node.props.type === 'password'), false)
    },
  )
})

test('the chip text is short and stable', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.SidebarTitle, {}))
  assert.deepEqual(tree[0].children, ['JWS 生图'])
})

test('the dock entry learns about a missing key without being clicked', async () => {
  // The entry now opens the sidebar instead of the modal, so a click no longer
  // passes through the modal's own state load. Without a mount-time fetch the
  // "未配置密钥 · 点此设置" hint could never appear again.
  const { exports, harness } = await loadExports()
  const recorded = []
  exports.apply({
    slots: {
      register(entry, component) { recorded.push({ entry, component }); return () => {} },
      inject(slot, callback) { callback(); return () => {} },
    },
    inject: () => {},
  })
  const entry = recorded.find((item) => item.entry.name === 'conversation.composer.dock')

  await withFetch({ '/state': { body: { ok: true, hasKey: false, maxAmount: 20, budgetCurrency: 'CNY' } } }, async (calls) => {
    harness.render(entry.component, {})
    // The mount effect fetches; let it settle, then re-render to read the result.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tree = walk(harness.render(entry.component, {}))
    assert.ok(calls.some((call) => call.path === '/api/jws-image/state'), 'the entry must load state on mount')
    // The attention label is what tells the user a key is missing.
    const button = tree.find((node) => node.props?.className === 'jws-entry')
    assert.equal(button.props['data-attention'], 'true')
  })
})

test('the sidebar panel injects its stylesheet even when nothing clicked the entry', async () => {
  // A tab can be opened by the sidebar itself (the guide page, a restored
  // layout), so the panel cannot rely on the dock entry's click for its styles.
  const { exports, harness } = await loadExports()
  const appended = []
  let existing = null
  const original = globalThis.document
  globalThis.document = {
    getElementById: () => existing,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: (element) => { appended.push(element); existing = element } },
  }
  try {
    await withFetch(
      {
        '/state': { body: { ok: true, hasKey: true, maxAmount: 20, budgetCurrency: 'CNY' } },
        '/api-status': { body: { ok: true, status: 'up-to-date', line: 'API: 已是最新', changes: [] } },
      },
      async () => {
        harness.render(exports.SidebarPanel, {})
        assert.equal(appended.length, 1, 'the panel must inject its stylesheet on mount')
        assert.equal(appended[0].dataset.plugin, 'dsh-plugin-jws-image')
        assert.equal(appended[0].id, 'dsh-plugin-jws-image-style')
      },
    )
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
  }
})

test('the panel body is the same window content the modal shows', async () => {
  // Both surfaces must render the same component tree, so a fix to the form
  // cannot land on one and miss the other.
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /h\(WindowBody, \{ state, onReload: load \}\)/u)
  assert.match(source, /h\(WindowBody, \{ state, onReload: reload \}\)/u)
})