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
function createHarness(options = {}) {
  const { runEffects = false } = options
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
    // Off by default: the generation form starts an interval while busy, and a
    // harness that never cleans up would leak it into the test process.
    useEffect: runEffects ? (fn) => { fn() } : () => {},
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
  const exports = captured.factory(require)
  // The browser-detected language follows the machine's locale (Node exposes a
  // `navigator` whose `language` is the host's), so pin it rather than letting
  // the Chinese expectations below depend on where the suite is run.
  exports.setLanguage('zh')
  return { exports, harness }
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

/** A model whose SKUs carry catalog prices, for the estimate line. */
const PRICED = {
  id: 'image:priced',
  name: 'Priced',
  modes: ['text-to-image'],
  capabilities: { maxOutputImages: 4 },
  skus: [
    { mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto', price: 0.05, currency: 'USD' },
    { mode: 'text-to-image', size: '16:9', resolution: '2K', quality: 'high', price: 0.11, currency: 'USD' },
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
        // The window always states the budget it is running under, so the host
        // never has to guess whether the user lowered it for this call.
        maxAmount: 20,
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
      // The path is shown under the preview (the cost line has its own paths).
      const paths = allByClass(tree, 'jws-path').map((node) => String(node.children[0]))
      assert.ok(paths.some((text) => /image-1\.png/u.test(text)), paths.join(' | '))
      // The window must tell the user what they paid, not just that a file exists.
      const cost = allByClass(tree, 'jws-cost').map((node) => JSON.stringify(node)).join(' ')
      assert.match(cost, /0\.5 USD/u)
      assert.match(cost, /t9/u)
    },
  )
})

test('the cost line names the amount, the model and the task', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.CostLine, {
    result: {
      amount: 0.053,
      currency: 'USD',
      taskId: 'image:abc',
      model: 'image:x',
      params: { size: 'auto', count: 1 },
      images: [{ path: '/tmp/a.png', mediaType: 'image/png', data: 'AA' }],
    },
  }))
  const text = tree.map((node) => (typeof node.children?.[0] === 'string' ? node.children[0] : '')).join(' ')
  assert.match(text, /已生成 1 张/u)
  assert.match(text, /0\.053 USD/u)
  assert.match(text, /image:abc/u)
})

test('the cost line renders nothing before a generation', async () => {
  const { exports, harness } = await loadExports()
  assert.equal(harness.render(exports.CostLine, { result: null }), null)
})

test('the history list offers a parameter refill per entry', async () => {
  const { exports, harness } = await loadExports()
  let refilled = null
  const tree = walk(harness.render(exports.HistoryList, {
    entries: [{ taskId: 't1', model: 'image:x', params: { size: 'auto', count: 1 }, prompt: '一只猫', amount: 0.05, currency: 'USD' }],
    onRerun: (entry) => { refilled = entry },
  }))
  const button = tree.find((node) => node.type === 'button' && node.children[0] === '回填参数')
  assert.ok(button, 'history entries must offer a refill action')
  button.props.onClick()
  assert.equal(refilled.taskId, 't1')
  assert.match(tree.map((n) => String(n.children?.[0] ?? '')).join(' '), /一只猫/u)
})

test('an empty history renders nothing rather than an empty box', async () => {
  const { exports, harness } = await loadExports()
  assert.equal(harness.render(exports.HistoryList, { entries: [], onRerun: () => {} }), null)
  assert.equal(harness.render(exports.HistoryList, { entries: undefined, onRerun: () => {} }), null)
})

// #region image preview

test('historyImageUrl carries only a task id and an index', async () => {
  const { exports } = await loadExports()
  // The browser never names a path; the host resolves the file from its own
  // record, which is what makes a traversal bug impossible rather than patched.
  const url = exports.historyImageUrl('image:abc/../x', 2)
  assert.equal(url, '/api/jws-image/history-image?taskId=image%3Aabc%2F..%2Fx&index=2')
  assert.equal(url.includes('/tmp/'), false)
})

test('baseName handles both separators and an empty path', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.baseName('C:\\Users\\me\\image-1.png'), 'image-1.png')
  assert.equal(exports.baseName('/tmp/out/image-2.jpg'), 'image-2.jpg')
  assert.equal(exports.baseName(''), '')
  assert.equal(exports.baseName(undefined), '')
})

test('every recorded file gets a lazy thumbnail', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.HistoryList, {
    entries: [{
      taskId: 't1',
      model: 'image:x',
      prompt: '一只猫',
      amount: 0.05,
      currency: 'USD',
      files: ['/tmp/out/image-1.png', '/tmp/out/image-2.png'],
    }],
    onRerun: () => {},
    onPreview: () => {},
  }))
  const thumbs = tree.filter((node) => node.props?.className === 'jws-thumb')
  assert.equal(thumbs.length, 2)
  assert.equal(thumbs[0].props.src, '/api/jws-image/history-image?taskId=t1&index=0')
  assert.equal(thumbs[1].props.src, '/api/jws-image/history-image?taskId=t1&index=1')
  // Twenty full-size PNGs would be tens of megabytes; only load what is looked at.
  assert.equal(thumbs[0].props.loading, 'lazy')
  assert.equal(thumbs[0].props.alt, 'image-1.png')
})

test('an entry with no recorded file renders no thumbnail', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.HistoryList, {
    entries: [{ taskId: 't1', files: [], prompt: 'x' }],
    onRerun: () => {},
    onPreview: () => {},
  }))
  assert.equal(tree.some((node) => node.props?.className === 'jws-thumb'), false)
})

test('clicking a thumbnail previews that exact image', async () => {
  const { exports, harness } = await loadExports()
  const seen = []
  const tree = walk(harness.render(exports.HistoryList, {
    entries: [{ taskId: 't1', model: 'image:x', prompt: '一只猫', amount: 0.05, currency: 'USD', files: ['/tmp/out/a.png', '/tmp/out/b.png'] }],
    onRerun: () => {},
    onPreview: (value) => seen.push(value),
  }))
  tree.filter((node) => node.props?.className === 'jws-thumb')[1].props.onClick()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].src, '/api/jws-image/history-image?taskId=t1&index=1')
  assert.equal(seen[0].title, 'b.png')
  assert.match(seen[0].caption, /0\.05 USD/u)
  assert.match(seen[0].caption, /b\.png/u)
})

test('clicking a fresh result previews the image it just generated', async () => {
  const { exports, harness } = await loadExports()
  const seen = []
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY', onPreview: (value) => seen.push(value) }
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
          model: 'image:dual',
        },
      },
    },
    async () => {
      let tree = walk(harness.render(exports.GenerateForm, props))
      tree.find((node) => node.type === 'textarea').props.onChange({ target: { value: 'a cat' } })
      tree = walk(harness.render(exports.GenerateForm, props))
      await tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true').props.onClick()

      tree = walk(harness.render(exports.GenerateForm, props))
      const image = tree.find((node) => node.type === 'img')
      assert.equal(typeof image.props.onClick, 'function')
      image.props.onClick()
      assert.equal(seen.length, 1)
      // The fresh image is already in hand, so no second round trip.
      assert.equal(seen[0].src, 'data:image/png;base64,AAEC')
      assert.equal(seen[0].title, 'image-1.png')
      assert.match(seen[0].caption, /0\.5 USD/u)
    },
  )
})

test('the lightbox shows the image with its caption and closes on both gestures', async () => {
  // Effects must run here: the Escape handler is installed by one.
  const { exports, harness } = await loadExports(createHarness({ runEffects: true }))
  const original = globalThis.document
  const listeners = []
  globalThis.document = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
    body: {},
  }
  try {
    // Nothing to show: renders nothing at all.
    assert.equal(harness.render(exports.Lightbox, { preview: null, onClose: () => {} }), null)

    let closed = 0
    const tree = walk(harness.render(exports.Lightbox, {
      preview: { src: 'data:image/png;base64,AA', title: 'image-1.png', caption: '0.5 USD · image:dual' },
      onClose: () => { closed += 1 },
    }))
    const overlay = tree.find((node) => node.props?.className === 'jws-lightbox')
    assert.ok(overlay, 'the lightbox must render an overlay')
    assert.equal(overlay.props.role, 'dialog')
    const image = tree.find((node) => node.type === 'img')
    assert.equal(image.props.src, 'data:image/png;base64,AA')
    assert.match(tree.find((node) => node.props?.className === 'jws-lightbox-caption').children[0], /0\.5 USD/u)

    // Escape closes it.
    const keyHandler = listeners.find((entry) => entry.type === 'keydown')
    assert.ok(keyHandler, 'the lightbox must listen for Escape')
    keyHandler.fn({ key: 'Escape' })
    assert.equal(closed, 1)
    // Clicking the backdrop closes it, but clicking the image itself must not.
    overlay.props.onClick()
    assert.equal(closed, 2)
    image.props.onClick({ stopPropagation: () => {} })
    assert.equal(closed, 2, 'clicking the image must not close the lightbox')
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
  }
})

// #endregion

test('maxCount reads the model capability and defaults to 4', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.maxCount({ capabilities: { maxOutputImages: 8 } }), 8)
  assert.equal(exports.maxCount({ capabilities: {} }), 4)
  assert.equal(exports.maxCount({}), 4)
  assert.equal(exports.maxCount({ capabilities: { maxOutputImages: 0 } }), 4)
})

test('looksLikeAuthFailure recognises the cases the user can fix', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.looksLikeAuthFailure('JWS HTTP 401: unauthorized'), true)
  assert.equal(exports.looksLikeAuthFailure('密钥格式不对'), true)
  assert.equal(exports.looksLikeAuthFailure('报价已过期'), false)
  assert.equal(exports.looksLikeAuthFailure(undefined), false)
})

test('the model picker gets a full-width row of its own', async () => {
  // The model id is the longest string in the form; squeezing it into a
  // quarter-width column truncated it in the shipped layout.
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.GenerateForm, {
    models: [MODEL],
    maxAmount: 20,
    budgetCurrency: 'CNY',
  }))
  const selects = tree.filter((node) => node.type === 'select')
  const rows = tree.filter((node) => node.props?.className === 'jws-row')
  // MODEL advertises no `supportsCustomSize`, so the custom-size row is absent
  // and the form is: the model, the four compact fields, then the per-call
  // budget.
  assert.equal(rows.length, 3, 'the form uses three rows: model, compact fields, budget')
  // Row 1 holds the model alone, so a long model id is never truncated.
  const modelRow = walk(rows[0]).filter((node) => node.type === 'select')
  assert.equal(modelRow.length, 1)
  assert.equal(modelRow[0].props.value, 'image:dual')
  assert.equal(rows[0].children[0].props.className, 'jws-field jws-field-wide')
  // Row 2 holds the four compact fields together.
  const compactRow = walk(rows[1]).filter((node) => node.type === 'select' || node.type === 'input')
  assert.equal(compactRow.length, 4)
  // Row 3 is the per-call budget, and it cannot exceed the configured ceiling.
  const budgetRow = walk(rows[2]).filter((node) => node.type === 'input')
  assert.equal(budgetRow.length, 1)
  assert.equal(budgetRow[0].props.max, '20')
  assert.equal(selects.length, 4)
})

test('a seed from history refills the form on mount', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.GenerateForm, {
    models: [MODEL],
    maxAmount: 20,
    budgetCurrency: 'CNY',
    seed: { model: 'image:dual', params: { size: '16:9', resolution: '2K', quality: 'high', count: 2 }, prompt: '一只猫' },
  }))
  const selects = tree.filter((node) => node.type === 'select')
  assert.equal(selects[0].props.value, 'image:dual')
  assert.equal(selects[1].props.value, '16:9')
  assert.equal(selects[2].props.value, '2K')
  assert.equal(selects[3].props.value, 'high')
  const textarea = tree.find((node) => node.type === 'textarea')
  assert.equal(textarea.props.value, '一只猫')
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

// #region estimate, references, cancel

test('estimateForSelection prices exactly the chosen SKU', async () => {
  const { exports } = await loadExports()
  const skus = PRICED.skus
  assert.deepEqual(
    exports.estimateForSelection(skus, { size: '16:9', resolution: '2K', quality: 'high', count: 2 }),
    { price: 0.11, currency: 'USD', count: 2 },
  )
  // A combination the catalog does not sell gets no estimate rather than a guess.
  assert.equal(exports.estimateForSelection(skus, { size: '1:1', resolution: '2K', quality: 'high', count: 1 }), null)
  assert.equal(exports.estimateForSelection([], { count: 1 }), null)
  // A SKU with no price is not a price.
  assert.equal(exports.estimateForSelection([{ size: '1:1' }], { size: '1:1', count: 1 }), null)
})

test('the form shows a catalog estimate before any quote is requested', async () => {
  const { exports, harness } = await loadExports()
  await withFetch({}, async () => {
    const tree = walk(harness.render(exports.GenerateForm, {
      models: [PRICED],
      maxAmount: 20,
      budgetCurrency: 'CNY',
    }))
    const line = byClass(tree, 'jws-estimate')
    assert.ok(line, 'the form must show an estimate when the catalog prices the SKU')
    assert.match(String(line.children[0]), /0\.05 USD/u)
    // It must not read as a commitment: the quote is what gates the budget.
    assert.match(String(line.children[0]), /以报价为准/u)
  })
})

test('the form shows no estimate when the catalog carries no price', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.GenerateForm, {
    models: [MODEL],
    maxAmount: 20,
    budgetCurrency: 'CNY',
  }))
  assert.equal(byClass(tree, 'jws-estimate'), undefined)
})

test('the reference picker offers a drop zone and a file input', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.ReferencePicker, {
    references: [],
    disabled: false,
    onAdd: () => {},
    onRemove: () => {},
  }))
  const input = tree.find((node) => node.type === 'input' && node.props.type === 'file')
  assert.ok(input, 'there must be a file input')
  assert.equal(input.props.accept, 'image/*')
  assert.equal(input.props.multiple, true)
  assert.ok(byClass(tree, 'jws-drop'), 'there must be a drop target')
  assert.match(String(byClass(tree, 'jws-hint').children[0]), /拖一张图/u)
})

test('existing references render thumbnails and can be removed', async () => {
  const { exports, harness } = await loadExports()
  const removed = []
  const references = [
    { name: 'a.png', mimeType: 'image/png', data: 'AA' },
    { name: 'b.jpg', mimeType: 'image/jpeg', data: 'BB' },
  ]
  const tree = walk(harness.render(exports.ReferencePicker, {
    references,
    disabled: false,
    onAdd: () => {},
    onRemove: (index) => removed.push(index),
  }))
  const thumbs = tree.filter((node) => node.props?.className === 'jws-thumb')
  assert.equal(thumbs.length, 2)
  assert.equal(thumbs[0].props.src, 'data:image/png;base64,AA')
  assert.equal(thumbs[0].props.alt, 'a.png')
  const removeButtons = tree.filter((node) => node.type === 'button' && node.children[0] === '移除')
  assert.equal(removeButtons.length, 2)
  removeButtons[1].props.onClick()
  assert.deepEqual(removed, [1])
})

test('a drop is forwarded to the same handler as the picker', async () => {
  const { exports, harness } = await loadExports()
  const added = []
  const tree = walk(harness.render(exports.ReferencePicker, {
    references: [],
    disabled: false,
    onAdd: (files) => added.push(files),
    onRemove: () => {},
  }))
  const zone = byClass(tree, 'jws-drop')
  let prevented = 0
  zone.props.onDrop({
    preventDefault: () => { prevented += 1 },
    dataTransfer: { files: ['a', 'b'] },
  })
  assert.equal(prevented, 1, 'the drop must not navigate the page')
  assert.deepEqual(added, [['a', 'b']])
})

test('a running generation can be cancelled, and says the task may still be billed', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    if (String(url).endsWith('/generate')) {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
      return
    }
    resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
  })
  try {
    let tree = walk(harness.render(exports.GenerateForm, props))
    tree.find((node) => node.type === 'textarea').props.onChange({ target: { value: 'a cat' } })
    tree = walk(harness.render(exports.GenerateForm, props))
    const pending = tree.find((node) => node.type === 'button' && node.props['data-primary'] === 'true').props.onClick()

    tree = walk(harness.render(exports.GenerateForm, props))
    const cancel = tree.find((node) => node.type === 'button' && node.children[0] === '取消等待')
    assert.ok(cancel, 'a cancel control must appear while generating')
    cancel.props.onClick()
    await pending

    tree = walk(harness.render(exports.GenerateForm, props))
    // Cancelling stops the wait; the submitted task still completes and bills,
    // so the message must not imply the money was saved.
    assert.match(String(byClass(tree, 'jws-error').children[0]), /可能仍在服务端进行并计费/u)
  } finally {
    globalThis.fetch = original
  }
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

// #region custom size

/** A model that takes pixel dimensions, with the live catalog's own limits. */
const CUSTOM = {
  id: 'image:custom',
  name: 'Custom',
  modes: ['text-to-image'],
  capabilities: {
    maxOutputImages: 4,
    supportsCustomSize: true,
    sizeLimits: { multipleOf: 16, maxSide: 3840, maxAspectRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 },
  },
  skus: [{ mode: 'text-to-image', size: '1:1', resolution: '1K', quality: 'auto' }],
}

/** `supportsCustomSize` with no `sizeLimits` — what the two Wan models show. */
const CUSTOM_LIMITLESS = {
  id: 'image:wan',
  name: 'Wan',
  modes: ['text-to-image'],
  capabilities: { supportsCustomSize: true },
  skus: [{ mode: 'text-to-image', size: '1:1' }],
}

test('customSizeLimits distinguishes unsupported, unstated and stated', async () => {
  const { exports } = await loadExports()
  // Not advertised at all: no custom-size control.
  assert.equal(exports.customSizeLimits(MODEL), null)
  assert.equal(exports.customSizeLimits({ capabilities: {} }), null)
  assert.equal(exports.customSizeLimits({ capabilities: { supportsCustomSize: false } }), null)
  // Advertised with no numbers: allowed, with nothing to validate against.
  assert.deepEqual(exports.customSizeLimits(CUSTOM_LIMITLESS), {})
  assert.deepEqual(exports.customSizeLimits(CUSTOM).multipleOf, 16)
})

test('customSizeValue names the pixel pair the API expects', async () => {
  const { exports } = await loadExports()
  assert.equal(exports.customSizeValue(1024, 1280), '1024x1280')
})

test('validateCustomSize names the rule that was broken', async () => {
  const { exports } = await loadExports()
  const limits = exports.customSizeLimits(CUSTOM)
  // "invalid size" would send the user hunting, so each rule is its own message.
  assert.equal(exports.validateCustomSize(1024, 1280, limits), null)
  assert.equal(exports.validateCustomSize(1000, 1280, limits).key, 'sizeError.multipleOf')
  assert.equal(exports.validateCustomSize(1024, 4000, limits).key, 'sizeError.maxSide')
  assert.equal(exports.validateCustomSize(32, 1024, limits).key, 'sizeError.aspect')
  assert.equal(exports.validateCustomSize(16, 16, limits).key, 'sizeError.minPixels')
  assert.equal(exports.validateCustomSize(3840, 3840, limits).key, 'sizeError.maxPixels')
  assert.equal(exports.validateCustomSize('', 1280, limits).key, 'sizeError.positive')
  assert.equal(exports.validateCustomSize(1024, 0, limits).key, 'sizeError.positive')
  assert.equal(exports.validateCustomSize(1024.5, 1280, limits).key, 'sizeError.positive')
  // With no limits stated there is nothing to refuse.
  assert.equal(exports.validateCustomSize(7, 9, exports.customSizeLimits(CUSTOM_LIMITLESS)), null)
})

test('every size failure the validator can name is translated', async () => {
  // A validator that returns a key the dictionary does not carry would render
  // the raw key at the user, so both dictionaries must have all of them.
  const { exports } = await loadExports()
  const keys = new Set()
  const limits = { multipleOf: 16, maxSide: 3840, maxAspectRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 }
  for (const [w, h] of [[1000, 1280], [1024, 4000], [32, 1024], [16, 16], [3840, 3840], ['', 1280]]) {
    const failure = exports.validateCustomSize(w, h, limits)
    assert.notEqual(failure, null)
    keys.add(failure.key)
  }
  for (const id of ['zh', 'en']) {
    exports.setLanguage(id)
    for (const key of keys) {
      assert.notEqual(exports.t(key), key, `${key} missing from ${id}`)
    }
  }
  exports.setLanguage('zh')
  // And each one interpolates its number, so the message is actionable.
  assert.match(exports.t('sizeError.multipleOf', { n: 16 }), /16/u)
})

test('the custom-size control appears only for a model that advertises it', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [CUSTOM_LIMITLESS], maxAmount: 20, budgetCurrency: 'CNY' }

  // Before the toggle there is no width or height field: the only two number
  // inputs are the image count and the per-call budget.
  let tree = walk(harness.render(exports.GenerateForm, props))
  assert.equal(tree.filter((node) => node.type === 'input' && node.props.type === 'number').length, 2)

  const toggle = tree.find((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.ok(toggle, 'a custom-size model must offer the toggle')
  toggle.props.onChange({ target: { checked: true } })

  tree = walk(harness.render(exports.GenerateForm, props))
  const numbers = tree.filter((node) => node.type === 'input' && node.props.type === 'number')
  // Count, budget, width and height.
  assert.equal(numbers.length, 4)
  // The SKU-derived size list is disabled while a custom size is in force.
  assert.equal(tree.find((node) => node.type === 'select' && node.children[0]?.props?.value === '1:1').props.disabled, true)
})

test('a model with no custom size gets no toggle at all', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.GenerateForm, { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }))
  assert.equal(tree.some((node) => node.type === 'input' && node.props.type === 'checkbox'), false)
})

// #endregion

// #region references

test('maxReferences and supportsReferences read the model, not a constant', async () => {
  const { exports } = await loadExports()
  // The live catalog varies from 0 to 16, so one fixed number is wrong.
  assert.equal(exports.maxReferences({ capabilities: { maxInputImages: 0 } }), 0)
  assert.equal(exports.maxReferences({ capabilities: { maxInputImages: 15 } }), 15)
  // Unstated: the transport ceiling, which is the most the host will forward.
  assert.equal(exports.maxReferences({}), 16)

  // Room for images but no image-to-image SKU to quote with.
  assert.equal(exports.supportsReferences({ capabilities: { maxInputImages: 5 }, modes: ['text-to-image'] }), false)
  assert.equal(exports.supportsReferences({ capabilities: { maxInputImages: 5 }, modes: ['image-to-image'] }), true)
  // Declared image-to-image, but explicitly takes no images.
  assert.equal(exports.supportsReferences({ capabilities: { maxInputImages: 0 }, modes: ['image-to-image'] }), false)
  // An unstated mode list is not a refusal.
  assert.equal(exports.supportsReferences({ capabilities: { maxInputImages: 5 } }), true)
})

test('a model that takes no references says so instead of hiding the control', async () => {
  // A disabled control explains nothing, so the reason is stated in its place.
  const { exports, harness } = await loadExports()
  const textOnly = { ...MODEL, capabilities: { maxOutputImages: 4, maxInputImages: 0 } }
  const tree = walk(harness.render(exports.GenerateForm, { models: [textOnly], maxAmount: 20, budgetCurrency: 'CNY' }))
  assert.equal(tree.some((node) => node.props.className === 'jws-drop'), false)
  const hints = allByClass(tree, 'jws-hint').map((node) => String(node.children[0]))
  assert.equal(hints.some((hint) => hint.includes('不接受参考图')), true)
})

// #endregion

// #region model info

test('the model info lists the limits of the model actually chosen', async () => {
  const { exports, harness } = await loadExports()
  const model = {
    id: 'image:full',
    name: 'Full',
    capabilities: {
      maxOutputImages: 4,
      maxInputImages: 15,
      maxPromptLength: 4000,
      countUnit: '张',
      outputFormats: ['png', 'jpeg'],
      moderations: ['nsfw'],
      supportsMask: true,
      supportsCustomSize: true,
      sizeLimits: { multipleOf: 16, maxSide: 3840 },
      parameters: [{ name: 'seed', description: '随机种子' }],
      notes: ['需要实名认证'],
    },
  }
  const text = walk(harness.render(exports.ModelInfo, { model })).map((node) => node.children[0]).join(' ')
  assert.match(text, /4/u)
  assert.match(text, /15/u)
  assert.match(text, /4000/u)
  assert.match(text, /png \/ jpeg/u)
  assert.match(text, /nsfw/u)
  assert.match(text, /seed/u)
  assert.match(text, /实名认证/u)
  assert.match(text, /16/u)
})

test('the model info renders nothing rather than an empty box', async () => {
  const { exports, harness } = await loadExports()
  assert.equal(harness.render(exports.ModelInfo, { model: { id: 'x', name: 'X' } }), null)
  assert.equal(harness.render(exports.ModelInfo, { model: null }), null)
})

// #endregion

// #region sending an image into the conversation

/** A conversation service stub recording what the composer was asked to do. */
function fakeConversation(options = {}) {
  const calls = { drafts: [], released: [], accepted: [], drafts_: [] }
  return {
    calls,
    service: {
      createDrafts: (sessionId, files) => {
        calls.drafts.push({ sessionId, names: files.map((file) => file.name) })
        if (options.failDrafts === true) throw new Error('drafts unavailable')
        if (options.noDrafts === true) return []
        return [{ id: 'draft-1', file: files[0], previewUrl: 'blob:x' }]
      },
      releaseDraftAttachments: (list) => { calls.released.push(list.length) },
    },
  }
}

/** A session face whose attachment registry accepts (or refuses) the drafts. */
function fakeSession(options = {}) {
  const calls = { accepted: [], drafts: [] }
  return {
    calls,
    session: {
      sessionId: 'session-1',
      inputActions: {
        addAttachments: (ids) => {
          calls.accepted.push(ids)
          if (options.refuseAttachments === true) return false
          if (options.throwAttachments === true) throw new Error('busy')
          return true
        },
        setDraft: (text) => { calls.drafts.push(text) },
      },
    },
  }
}

test('sendImageToComposer degrades to a reason, never a throw', async () => {
  const { exports } = await loadExports()
  // No session props at all: the dock can be rendered outside a session.
  assert.deepEqual(
    await exports.sendImageToComposer({ imageUrl: 'blob:x', name: 'a.png' }),
    { ok: false, reason: 'no-session' },
  )
  // A session but no reachable conversation service.
  const { session } = fakeSession()
  exports.apply({ get: () => undefined })
  assert.deepEqual(
    await exports.sendImageToComposer({ session, imageUrl: 'blob:x', name: 'a.png' }),
    { ok: false, reason: 'no-service' },
  )
})

test('sendImageToComposer registers the attachment and merges the prompt', async () => {
  const { exports } = await loadExports()
  const { service, calls: conversationCalls } = fakeConversation()
  exports.apply({ get: (name) => (name === 'conversation' ? service : undefined) })
  const { session, calls } = fakeSession()

  await withFetch(
    { 'index=0': { body: null } },
    async () => {
      // `imageFileFrom` needs bytes; a JSON body is not one, so stub the blob.
      const original = globalThis.fetch
      globalThis.fetch = async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      })
      try {
        const result = await exports.sendImageToComposer({
          session,
          imageUrl: '/api/jws-image/history-image?taskId=t&index=0',
          name: 'image-1.png',
          path: '/tmp/out/image-1.png',
          text: '一只猫',
          draft: '接着写：',
        })
        assert.deepEqual(result, { ok: true })
      } finally {
        globalThis.fetch = original
      }
    },
  )

  assert.deepEqual(conversationCalls.drafts, [{ sessionId: 'session-1', names: ['image-1.png'] }])
  assert.deepEqual(calls.accepted, [['draft-1']])
  // The user's half-written message is kept, not clobbered.
  assert.deepEqual(calls.drafts, ['接着写：\n一只猫'])
})

test('a refused attachment releases the drafts instead of leaking them', async () => {
  const { exports } = await loadExports()
  const { service, calls: conversationCalls } = fakeConversation()
  exports.apply({ get: () => service })
  const { session } = fakeSession({ refuseAttachments: true })

  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
  })
  try {
    const result = await exports.sendImageToComposer({ session, imageUrl: 'blob:x', name: 'a.png', path: '/tmp/a.png' })
    assert.deepEqual(result, { ok: false, reason: 'attach-refused' })
  } finally {
    globalThis.fetch = original
  }
  // The ids stay registered until released, so the next send would otherwise
  // find the composer carrying an attachment nothing refers to.
  assert.deepEqual(conversationCalls.released, [1])
})

test('a failing draft creation becomes a reason, not an exception', async () => {
  const { exports } = await loadExports()
  const { service } = fakeConversation({ failDrafts: true })
  exports.apply({ get: () => service })
  const { session } = fakeSession()

  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
  })
  try {
    const result = await exports.sendImageToComposer({ session, imageUrl: 'blob:x', name: 'a.png' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'drafts unavailable')
  } finally {
    globalThis.fetch = original
  }
})

test('the send button is never a dead end: it falls back to copying the path', async () => {
  const { exports, harness } = await loadExports()
  const copied = []
  const originalNavigator = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  })
  try {
    // No session: the send fails, and the path is copied instead.
    const tree = walk(harness.render(exports.SendToChat, {
      imageUrl: 'blob:x',
      name: 'image-1.png',
      path: '/tmp/out/image-1.png',
    }))
    const buttons = tree.filter((node) => node.type === 'button')
    assert.deepEqual(buttons.map((node) => node.children[0]), ['送进对话', '复制路径'])

    await buttons[0].props.onClick()
    assert.deepEqual(copied, ['/tmp/out/image-1.png'])
    const after = walk(harness.render(exports.SendToChat, {
      imageUrl: 'blob:x',
      name: 'image-1.png',
      path: '/tmp/out/image-1.png',
    }))
    const errors = allByClass(after, 'jws-error').map((node) => String(node.children[0]))
    assert.equal(errors.some((text) => text.includes('没有可用的会话')), true)
    // And it says the path was copied, so the fallback is not a silent no-op.
    assert.equal(errors.some((text) => text.includes('复制图片路径')), true)
  } finally {
    if (originalNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  }
})

// #endregion

// #region history management

test('each history entry deletes itself, not the whole list', async () => {
  const { exports, harness } = await loadExports()
  const deleted = []
  const entries = [
    { taskId: 'a', files: [], amount: 1, currency: 'USD', model: 'image:a', prompt: 'one' },
    { taskId: 'b', files: [], amount: 1, currency: 'USD', model: 'image:b', prompt: 'two' },
  ]
  const tree = walk(harness.render(exports.HistoryList, {
    entries,
    onRerun: () => {},
    onPreview: () => {},
    onDelete: (entry) => deleted.push(entry.taskId),
  }))
  const buttons = tree.filter((node) => node.type === 'button')
  // Two reruns and two deletes, and no clear-all when no handler was given.
  assert.equal(buttons.length, 4)
  assert.equal(buttons.some((node) => node.children[0] === '清空历史'), false)
  buttons.find((node) => node.children[0] === '删除').props.onClick()
  assert.deepEqual(deleted, ['a'])
})

test('clear-all needs two clicks, and the first one only asks', async () => {
  const { exports, harness } = await loadExports()
  let cleared = 0
  const props = {
    entries: [{ taskId: 'a', files: [], amount: 1, currency: 'USD', model: 'image:a', prompt: 'one' }],
    onRerun: () => {},
    onPreview: () => {},
    onClear: () => { cleared += 1 },
  }
  let tree = walk(harness.render(exports.HistoryList, props))
  const clear = () => tree.filter((node) => node.type === 'button')
    .find((node) => typeof node.children[0] === 'string' && /^清空历史$|^再点一次/.test(node.children[0]))
  clear().props.onClick()
  // A single stray click must not empty the list.
  assert.equal(cleared, 0)
  tree = walk(harness.render(exports.HistoryList, props))
  assert.match(clear().children[0], /^再点一次/u)
  clear().props.onClick()
  assert.equal(cleared, 1)
})

test('an empty history renders nothing rather than an empty box', async () => {
  const { exports, harness } = await loadExports()
  assert.equal(harness.render(exports.HistoryList, { entries: [], onRerun: () => {} }), null)
  assert.equal(harness.render(exports.HistoryList, {}), null)
})

// #endregion

// #region first-run onboarding

test('the first run explains what this is, the key, and the money', async () => {
  const { exports, harness } = await loadExports()
  let dismissed = 0
  const tree = walk(harness.render(exports.Onboarding, {
    maxAmount: 20,
    budgetCurrency: 'CNY',
    onDismiss: () => { dismissed += 1 },
  }))
  const text = tree.map((node) => (typeof node.children?.[0] === 'string' ? node.children[0] : '')).join(' ')
  assert.match(text, /jws_live_/u)
  // The currency mismatch is the part nobody would guess.
  assert.match(text, /USD/u)
  assert.match(text, /20/u)
  // And the ceiling can only be lowered, which is what the host enforces.
  assert.match(text, /不能调高/u)

  tree.find((node) => node.type === 'button').props.onClick()
  assert.equal(dismissed, 1)
})

test('a USD budget needs no mismatch warning', async () => {
  const { exports, harness } = await loadExports()
  const tree = walk(harness.render(exports.Onboarding, { maxAmount: 20, budgetCurrency: 'USD', onDismiss: () => {} }))
  const hints = allByClass(tree, 'jws-hint').map((node) => String(node.children[0]))
  assert.equal(hints.some((text) => text.includes('USD')), false)
})

// #endregion

// #region language

test('both dictionaries carry exactly the same keys', async () => {
  // A key present in one language only would render the raw key to half the
  // users, which is exactly the bug a dictionary split invites.
  const { exports } = await loadExports()
  const zh = Object.keys(exports.MESSAGES.zh).sort()
  const en = Object.keys(exports.MESSAGES.en).sort()
  assert.deepEqual(zh, en)
  assert.equal(zh.length > 40, true)
})

test('t interpolates placeholders and leaves an unknown key visible', async () => {
  const { exports } = await loadExports()
  // A missing translation must be visible in a screenshot, not silently blank.
  assert.equal(exports.t('no.such.key'), 'no.such.key')
  assert.equal(exports.t('form.customWidth'), '宽')
})

test('setLanguage normalises a BCP 47 tag and ignores one it cannot render', async () => {
  const { exports } = await loadExports()
  exports.setLanguage('en-US')
  assert.equal(exports.language(), 'en')
  assert.equal(exports.t('form.customWidth'), 'W')
  exports.setLanguage('zh-Hant-TW')
  assert.equal(exports.language(), 'zh')
  assert.equal(exports.t('form.customWidth'), '宽')
  // A tag naming no language this file ships leaves the current one alone.
  exports.setLanguage('de-DE')
  assert.equal(exports.language(), 'zh')
  exports.setLanguage(undefined)
  assert.equal(exports.language(), 'zh')
})

test('the whole window follows a language switch', async () => {
  const { exports, harness } = await loadExports()
  const props = { models: [MODEL], maxAmount: 20, budgetCurrency: 'CNY' }
  const labelsOf = () => {
    const tree = walk(harness.render(exports.GenerateForm, props))
    return tree.filter((node) => node.props?.className === 'jws-label').map((node) => String(node.children[0]))
  }
  assert.equal(labelsOf().includes('模型'), true)
  exports.setLanguage('en')
  assert.equal(labelsOf().includes('Model'), true)
})

test('the locale service drives the language, not the browser', async () => {
  const { exports, harness } = await loadExports()
  const registered = []
  let listener
  // The host's locale wins over `navigator`, which is the whole point of
  // following it: the user picked a language in the app, not in the browser.
  let active = 'en-US'
  const locale = {
    register: (ns, id, dict) => { registered.push({ ns, id, keys: Object.keys(dict).length }) },
    getLocale: () => ({ active }),
    subscribe: (fn) => {
      listener = fn
      return () => { listener = undefined }
    },
  }
  exports.apply({
    inject: (services, callback) => {
      if (services.includes('locale')) {
        callback({ locale, effect: (fn) => { fn(); return () => {} } })
        return
      }
      // No right column on this build: the dock entry keeps the modal.
      callback({ effect: (fn) => { fn(); return () => {} } })
    },
  })

  // Both dictionaries are offered to the registry under one namespace.
  assert.deepEqual(registered.map((item) => item.id), ['zh', 'en'])
  assert.equal(registered.every((item) => item.ns === 'jws-image'), true)
  assert.equal(registered[0].keys > 40, true)

  assert.equal(exports.language(), 'en')
  const props = { maxAmount: 20, budgetCurrency: 'CNY', onDismiss: () => {} }
  const painted = walk(harness.render(exports.Onboarding, props))
  assert.equal(painted.find((node) => node.type === 'button').children[0], 'Got it')

  // A later switch on the service comes through the same subscription.
  active = 'zh-CN'
  listener()
  assert.equal(exports.language(), 'zh')
  assert.equal(exports.t('onboarding.dismiss'), '知道了')
})

test('a language the service reports that we do not ship leaves us alone', async () => {
  const { exports } = await loadExports()
  let listener
  const locale = { register: () => {}, getLocale: () => ({ active: 'de-DE' }), subscribe: (fn) => { listener = fn; return () => {} } }
  exports.apply({ inject: (services, callback) => callback({ locale, effect: (fn) => { fn(); return () => {} } }) })
  // Falls back to the browser/default rather than rendering nothing.
  assert.equal(exports.language(), 'zh')
  listener()
  assert.equal(exports.language(), 'zh')
})

test('the chip text follows the language without re-registering the tab', async () => {
  const { exports, harness } = await loadExports()
  exports.apply({ slots: fakeSlots().slots })
  const chip = () => walk(harness.render(exports.SidebarTitle, {}))[0].children[0]
  assert.equal(chip(), 'JWS 生图')
  exports.setLanguage('en')
  // The chip reads the language at paint time, so nothing re-registers.
  assert.equal(chip(), 'JWS image')
})

// #endregion