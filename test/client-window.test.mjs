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
  assert.equal(rows.length, 2, 'the form uses two rows: the model, then the compact fields')
  // Row 1 holds the model alone, so a long model id is never truncated.
  const modelRow = walk(rows[0]).filter((node) => node.type === 'select')
  assert.equal(modelRow.length, 1)
  assert.equal(modelRow[0].props.value, 'image:dual')
  assert.equal(rows[0].children[0].props.className, 'jws-field jws-field-wide')
  // Row 2 holds the four compact fields together.
  const compactRow = walk(rows[1]).filter((node) => node.type === 'select' || node.type === 'input')
  assert.equal(compactRow.length, 4)
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