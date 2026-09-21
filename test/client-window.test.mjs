/**
 * Window tests.
 *
 * The window is a hand-written classic script with no build step, so these tests
 * drive the pure helpers directly and render the components through a minimal
 * hook harness. That covers the two things that can actually break the form:
 * which values the catalog contributes, and which parameters get sent to the API.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * A React stub with just enough hook state to re-render a component.
 *
 * Hook cells are keyed per component function, the way React keys them per
 * fiber, so a parent render that mounts a child does not disturb the parent's
 * own hook order. `render` also expands function components, so a test can see
 * the markup a nested component produces rather than just its element stub.
 */
function createHarness() {
  const store = new Map()
  let currentCells = null
  let cursor = 0
  /** Flatten nested child arrays and drop holes, the way React does. */
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
    useEffect: () => {},
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

  /** Render one component with its own hook cells. */
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

  /** Expand every function component in a tree, depth first. */
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand)
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(renderComponent(node.type, node.props))
    return { ...node, children: (node.children ?? []).map(expand) }
  }

  return {
    react,
    /** Render (or re-render) a component from the top and expand it. */
    render(Component, props) {
      return expand(renderComponent(Component, props))
    },
  }
}

/** Load the bundle and materialize its exports against one harness. */
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

/** The first element carrying a class name. */
function byClass(tree, className) {
  return walk(tree).find((node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/u).includes(className))
}

/** Every element carrying a class name. */
function allByClass(tree, className) {
  return walk(tree).filter((node) => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/u).includes(className))
}

/**
 * Install a fetch stub answering the host routes, and restore it afterwards.
 * @param routes - map of path suffix to `{ status, body }`.
 */
function withFetch(routes, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    calls.push({ path, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    for (const [suffix, reply] of Object.entries(routes)) {
      if (path.endsWith(suffix)) {
        return {
          ok: reply.status === undefined || reply.status < 400,
          status: reply.status ?? 200,
          json: async () => reply.body,
        }
      }
    }
    throw new Error(`unexpected fetch: ${path}`)
  }
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original })
}

/** A slot registry that behaves like the real one. */
function fakeSlots() {
  const registrations = []
  return {
    registrations,
    slots: {
      register(entry, component) {
        registrations.push({ entry, component })
        return () => {}
      },
      inject(slot, callback) {
        callback()
        return () => {}
      },
    },
  }
}

const MODEL = {
  id: 'image:dual',
  name: 'Dual',
  modes: ['text-to-image', 'image-to-image'],
  capabilities: { maxOutputImages: 4 },
  skus: [
    { mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' },
    { mode: 'text-to-image', size: '16:9', resolution: '2K', quality: 'high' },
    { mode: 'image-to-image', size: '3:4', resolution: '4K', quality: 'low' },
  ],
}

// #region pure helpers

test('skusForMode keeps only the requested mode', async () => {
  const { exports } = await loadExports()
  assert.deepEqual(exports.skusForMode(MODEL, 'text-to-image').map((sku) => sku.size), ['1:1', '16:9'])
  assert.deepEqual(exports.skusForMode(MODEL, 'image-to-image').map((sku) => sku.size), ['3:4'])
  assert.deepEqual(exports.skusForMode({}, 'text-to-image'), [])
})

test('optionValues dedupes, keeps order, and skips empty fields', async () => {
  const { exports } = await loadExports()
  const skus = [
    { size: '1:1', quality: undefined },
    { size: '16:9', quality: 'high' },
    { size: '1:1', quality: null },
    { quality: 'high' },
  ]
  assert.deepEqual(exports.optionValues(skus, 'size'), ['1:1', '16:9'])
  assert.deepEqual(exports.optionValues(skus, 'quality'), ['high'])
  assert.deepEqual(exports.optionValues(skus, 'missing'), [])
})

test('defaultSku hands back one whole record, never a mix of fields', async () => {
  const { exports } = await loadExports()
  // The API requires mode/size/resolution/quality from the SAME skus[] record.
  assert.deepEqual(exports.defaultSku(MODEL, 'text-to-image'), MODEL.skus[0])
  assert.deepEqual(exports.defaultSku(MODEL, 'image-to-image'), MODEL.skus[2])
  assert.deepEqual(exports.defaultSku({ skus: [MODEL.skus[2]] }, 'text-to-image'), MODEL.skus[2])
  assert.equal(exports.defaultSku({ skus: [] }, 'text-to-image'), undefined)
})

test('paramsFromSelection omits fields the model does not offer', async () => {
  const { exports } = await loadExports()
  assert.deepEqual(
    exports.paramsFromSelection({ size: '1:1', resolution: '1K', quality: 'auto', count: 2 }),
    { count: 2, size: '1:1', resolution: '1K', quality: 'auto' },
  )
  // An invented quality would be rejected by the API, so it must be absent.
  assert.deepEqual(exports.paramsFromSelection({ size: '1:1', count: 1 }), { count: 1, size: '1:1' })
})

test('formatCost never invents a currency', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.formatCost(1.5, 'USD'), '1.5 USD')
  assert.equal(exports.formatCost(1.5, undefined), '1.5 ?')
  assert.equal(exports.formatCost(undefined, 'USD'), '—')
})

test('imageDataUrl builds a data URL only from real bytes', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.imageDataUrl({ mediaType: 'image/png', data: 'AAA' }), 'data:image/png;base64,AAA')
  assert.equal(exports.imageDataUrl({ data: 'AAA' }), 'data:image/png;base64,AAA')
  assert.equal(exports.imageDataUrl({ mediaType: 'image/png' }), null)
  assert.equal(exports.imageDataUrl(null), null)
})

test('describeError prefers the host message and always says something', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.describeError({ error: '密钥格式不对' }), '密钥格式不对')
  assert.equal(exports.describeError({}, '回退文案'), '回退文案')
  assert.equal(exports.describeError(null), '请求失败，请重试。')
})

test('isUsableModel selects models that advertise the mode', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.isUsableModel(MODEL), true)
  assert.equal(exports.isUsableModel({ modes: ['image-to-image'] }), false)
  assert.equal(exports.isUsableModel({}), false)
})

// #endregion

// #region registration

test('the dock entry renders a button labelled in Chinese', async () => {
  const { exports, harness } = await loadExports()
  const { slots, registrations } = fakeSlots()
  exports.apply({ slots })
  const Entry = registrations[0].component

  // Rendered through the harness so the component's hooks are seated.
  const tree = walk(harness.render(Entry, {}))
  const buttons = tree.filter((node) => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props.className, 'jws-entry')
  assert.deepEqual(buttons[0].children, ['JWS 生图'])
  assert.equal(typeof buttons[0].props.onClick, 'function')
  // Closed window: the modal renders nothing at all.
  assert.equal(tree.some((node) => node.props?.role === 'dialog'), false)
})

// #endregion

// #region key setup

test('the first-run window asks for a key with a password field', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.KeyForm, { onSaved: () => {} }))

  const input = tree.find((node) => node.type === 'input')
  assert.equal(input.props.type, 'password')
  assert.equal(input.props.autoComplete, 'off')
  assert.match(input.props.placeholder, /jws_live_/u)
  // The save button stays disabled until something is typed.
  const save = tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true')
  assert.equal(save.props.disabled, true)
})

test('the key form posts to the host and reloads on success', async () => {
  const { exports, harness } = await loadExports()
  let saved = 0
  await withFetch({ '/key': { body: { ok: true, modelCount: 3 } } }, async (calls) => {
    let tree = walk(harness.render(exports.KeyForm, { onSaved: () => { saved += 1 } }))
    const input = tree.find((node) => node.type === 'input')
    input.props.onChange({ target: { value: 'jws_live_abc' } })
    tree = walk(harness.render(exports.KeyForm, { onSaved: () => { saved += 1 } }))
    const save = tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true')
    assert.equal(save.props.disabled, false)
    await save.props.onClick()

    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/jws-image/key')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(calls[0].body, { apiKey: 'jws_live_abc' })
    assert.equal(saved, 1)
  })
})

test('a rejected key is shown in place and does not advance the window', async () => {
  const { exports, harness } = await loadExports()
  let saved = 0
  await withFetch(
    { '/key': { status: 401, body: { ok: false, error: 'JWS HTTP 401: 密钥无效' } } },
    async () => {
      let tree = walk(harness.render(exports.KeyForm, { onSaved: () => { saved += 1 } }))
      tree.find((node) => node.type === 'input').props.onChange({ target: { value: 'jws_live_bad' } })
      tree = walk(harness.render(exports.KeyForm, { onSaved: () => { saved += 1 } }))
      await tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true').props.onClick()

      tree = walk(harness.render(exports.KeyForm, { onSaved: () => { saved += 1 } }))
      const error = byClass(tree, 'jws-error')
      assert.match(error.children[0], /密钥无效/u)
      assert.equal(saved, 0)
    },
  )
})

// #endregion

// #region generation form

test('the form is driven by the catalog: no pinned model and no pinned size list', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // A regression guard with teeth.
  assert.doesNotMatch(source, /seedream/u)
  assert.doesNotMatch(source, /'1:1',\s*'16:9'/u)
  assert.match(source, /optionValues\(skus, 'size'\)/u)
  assert.match(source, /optionValues\(skus, 'resolution'\)/u)
  assert.match(source, /optionValues\(skus, 'quality'\)/u)
})

test('the form offers only the text-to-image SKU values', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.GenerateForm, {
    models: [MODEL],
    maxAmount: 20,
    budgetCurrency: 'CNY',
  }))

  const selects = tree.filter((node) => node.type === 'select')
  // model, size, resolution, quality
  assert.equal(selects.length, 4)
  const sizeOptions = selects[1].children.map((option) => option.props.value)
  assert.deepEqual(sizeOptions, ['1:1', '16:9'])
  // The image-to-image-only size must not leak into a text-to-image form.
  assert.equal(sizeOptions.includes('3:4'), false)
})

test('quoting posts the selected parameters and shows the price', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }
  await withFetch(
    { '/quote': { body: { ok: true, amount: 0.5, currency: 'USD', quoteId: 'q1', model: 'image:dual' } } },
    async (calls) => {
      let tree = walk(harness.render(exports.GenerateForm, props))
      const prompt = tree.find((node) => node.type === 'textarea')
      prompt.props.onChange({ target: { value: 'a cat' } })
      tree = walk(harness.render(exports.GenerateForm, props))

      const quoteButton = tree.find((node) => node.type === 'button' && node.children[0] === '报价')
      await quoteButton.props.onClick()

      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, '/api/jws-image/quote')
      assert.deepEqual(calls[0].body, {
        prompt: 'a cat',
        model: 'image:dual',
        params: { count: 1, size: '1:1', resolution: '1K', quality: 'auto' },
      })

      tree = walk(harness.render(exports.GenerateForm, props))
      const note = allByClass(tree, 'jws-note').map((node) => String(node.children[0])).join(' ')
      assert.match(note, /0\.5 USD/u)
      assert.match(note, /20 CNY/u)
      // The confirm button replaces the plain generate button after a quote.
      assert.ok(tree.some((node) => node.type === 'button' && node.children[0] === '确认生成'))
    },
  )
})

test('generating renders the returned image and lists the files', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }
  await withFetch(
    {
      '/generate': {
        body: {
          ok: true,
          taskId: 't9',
          files: ['/tmp/out/image-1.png'],
          images: [{ path: '/tmp/out/image-1.png', mediaType: 'image/png', bytes: 3, data: 'AAEC' }],
          amount: 0.5,
          currency: 'USD',
        },
      },
    },
    async (calls) => {
      let tree = walk(harness.render(exports.GenerateForm, props))
      tree.find((node) => node.type === 'textarea').props.onChange({ target: { value: 'a cat' } })
      tree = walk(harness.render(exports.GenerateForm, props))
      const generate = tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true')
      await generate.props.onClick()

      assert.equal(calls[0].path, '/api/jws-image/generate')
      tree = walk(harness.render(exports.GenerateForm, props))
      const image = tree.find((node) => node.type === 'img')
      assert.equal(image.props.src, 'data:image/png;base64,AAEC')
      assert.match(byClass(tree, 'jws-path').children[0], /image-1\.png/u)
    },
  )
})

test('a host failure is rendered instead of thrown', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }
  await withFetch(
    { '/generate': { status: 402, body: { ok: false, error: '超过预算上限，已熔断。' } } },
    async () => {
      let tree = walk(harness.render(exports.GenerateForm, props))
      tree.find((node) => node.type === 'textarea').props.onChange({ target: { value: 'a cat' } })
      tree = walk(harness.render(exports.GenerateForm, props))
      await tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true').props.onClick()

      tree = walk(harness.render(exports.GenerateForm, props))
      assert.match(byClass(tree, 'jws-error').children[0], /熔断/u)
    },
  )
})

// #endregion

// #region window body and status bar

test('the window shows the key form when no key is configured', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.WindowBody, {
    state: { hasKey: false, maxAmount: 20, budgetCurrency: 'CNY' },
    onReload: () => {},
  }))
  assert.ok(tree.some((node) => node.type === 'input' && node.props.type === 'password'))
})

test('the window shows a reading state before the catalog arrives', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.WindowBody, {
    state: { hasKey: true, maxAmount: 20, budgetCurrency: 'CNY' },
    onReload: () => {},
  }))
  const note = byClass(tree, 'jws-note')
  assert.match(note.children[0], /读取模型目录/u)
})

test('the window surfaces a route failure instead of rendering a form', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.WindowBody, {
    state: { hasKey: false, error: '无法连接宿主路由' },
    onReload: () => {},
  }))
  assert.match(byClass(tree, 'jws-error').children[0], /宿主路由/u)
})

test('the status bar offers a snapshot refresh only when the contract moved', async () => {
  const { exports, harness } = await loadExports()
  const clean = walk(harness.render(exports.StatusBar, {
    status: { status: 'up-to-date', line: 'API: 已是最新（1.0.0）', changes: [] },
  }))
  assert.equal(clean.filter((node) => node.type === 'button').length, 0)

  const moved = walk(harness.render(exports.StatusBar, {
    status: { status: 'changed', line: 'API 有更新', changes: ['新增 GET /v1/y'] },
  }))
  assert.ok(moved.some((node) => node.type === 'button' && node.children[0] === '更新快照'))
  assert.ok(moved.some((node) => node.type === 'li' && node.children[0] === '新增 GET /v1/y'))
})

// #endregion

// #region privacy

test('the browser half never stores or logs the API key', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /localStorage/u)
  assert.doesNotMatch(source, /sessionStorage/u)
  assert.doesNotMatch(source, /console\.log/u)
  // It is sent to exactly one route.
  assert.match(source, /call\('\/key'/u)
})

test('every JWS call goes through the host route prefix', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /image\.aijws\.com/u)
  assert.match(source, /const API = '\/api\/jws-image'/u)
})

// #endregion