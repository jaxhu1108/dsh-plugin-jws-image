/**
 * dsh-plugin-jws-image — browser half.
 *
 * A hand-written classic script: DSH ships no bundler and serves this file
 * verbatim, so this IS the source. Only the frozen platform modules are
 * requireable; everything is guarded because the module table is a contract
 * that can change between DSH releases.
 *
 * The API key never reaches this file. Every JWS call goes through the host
 * routes under `/api/jws-image/*`, which run where the key lives.
 *
 * REGISTRATION SHAPE — the part that is easy to get wrong:
 * a slot is a *declaration* owned by whatever renders it. `slots.register()`
 * throws `slot "<name>" is not declared` unless a parent entry's children table
 * has already declared that slot. The supported way to register into a slot we
 * do not own is `slots.inject(name, () => slots.register(...))`, which runs the
 * callback immediately when the declaration already exists and otherwise waits
 * for it (re-running it on every re-declaration).
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-jws-image',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    let ReactDOM = null
    try {
      React = require('react')
    } catch {
      React = null
    }
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }
    /** Native primitives, when this DSH build still ships them. */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    /** The one service this browser half cannot work without. */
    const inject = ['slots']

    /**
     * Slot candidates, best first — the entry lands in the first candidate that
     * is declared. A renamed slot degrades to "the UI is missing" instead of
     * breaking the plugin; the host half keeps the agent tool either way.
     */
    const SLOT_CANDIDATES = [
      'conversation.composer.dock',
      'conversation.input.right',
      'conversation.input.left',
    ]

    /** Our cell key. An id of our own is added beside the shipped entries. */
    const ENTRY_ID = 'jws-image'
    /** Sort position among the entries of the chosen slot. */
    const ENTRY_ORDER = 100

    /** Route prefix, mirrored from the host half. */
    const API = '/api/jws-image'
    /** Style element id, so re-injection stays idempotent across HMR. */
    const STYLE_ID = 'dsh-plugin-jws-image-style'
    /** The mode this window drives. Reference images are a later phase. */
    const MODE = 'text-to-image'

    const h = React === null ? null : React.createElement

    // #region pure helpers

    /** Every SKU of one model that belongs to the requested mode. */
    function skusForMode(model, mode) {
      const skus = Array.isArray(model?.skus) ? model.skus : []
      return skus.filter((sku) => sku?.mode === mode)
    }

    /** Distinct, defined values of one SKU field, in first-seen order. */
    function optionValues(skus, field) {
      const seen = []
      for (const sku of skus) {
        const value = sku?.[field]
        if (value === undefined || value === null || value === '') continue
        if (!seen.includes(value)) seen.push(value)
      }
      return seen
    }

    /**
     * The SKU a fresh selection starts from.
     *
     * The API requires mode/size/resolution/quality to come from one `skus[]`
     * record, so the default is a whole record — never a mix of fields.
     */
    function defaultSku(model, mode) {
      const skus = skusForMode(model, mode)
      if (skus.length > 0) return skus[0]
      return Array.isArray(model?.skus) ? model.skus[0] : undefined
    }

    /** A model is usable in this window when it advertises the mode. */
    function isUsableModel(model) {
      return Array.isArray(model?.modes) && model.modes.includes(MODE)
    }

    /** Render a cost for display, never inventing a currency. */
    function formatCost(amount, currency) {
      if (amount === undefined || amount === null) return '—'
      return `${amount} ${currency ?? '?'}`
    }

    /** A data URL for an image record returned by the generate route. */
    function imageDataUrl(image) {
      if (typeof image?.data !== 'string' || image.data.length === 0) return null
      return `data:${image?.mediaType ?? 'image/png'};base64,${image.data}`
    }

    /** The message to show for a failed route response. */
    function describeError(payload, fallback) {
      if (payload !== null && typeof payload === 'object'
        && typeof payload.error === 'string' && payload.error.length > 0) {
        return payload.error
      }
      return fallback ?? '请求失败，请重试。'
    }

    /**
     * The parameters a form selection maps onto.
     *
     * Only fields the model actually offers are sent: a model whose SKUs omit
     * `quality` must not be quoted with an invented one.
     */
    function paramsFromSelection(selection) {
      const params = { count: selection.count }
      if (selection.size !== undefined) params.size = selection.size
      if (selection.resolution !== undefined) params.resolution = selection.resolution
      if (selection.quality !== undefined) params.quality = selection.quality
      return params
    }

    // #endregion

    // #region transport

    /**
     * One JSON call against the host routes.
     *
     * A host failure is returned as a value rather than thrown, so a component
     * can render it instead of crashing the shell.
     *
     * @param path - route path below {@link API}.
     * @param options - method and JSON body.
     * @returns `{ ok, status, body }`.
     */
    async function call(path, options = {}) {
      const { method = 'GET', body } = options
      try {
        const response = await fetch(`${API}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        return { ok: response.ok && payload?.ok !== false, status: response.status, body: payload }
      } catch (error) {
        return {
          ok: false,
          status: 0,
          body: { error: `无法连接宿主路由：${error instanceof Error ? error.message : String(error)}` },
        }
      }
    }

    // #endregion

    // #region styles

    /**
     * Inject this plugin's stylesheet once.
     *
     * Only our own class names are used. The single exception is the class that
     * widens the native Modal, and losing it falls back to the default 380px
     * width rather than breaking the layout.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-plugin-jws-image'
      style.textContent = [
        '.jws-entry{appearance:none;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:1.4;opacity:.72;padding:2px 8px}',
        '.jws-entry:hover{opacity:1}',
        '.jws-entry[data-attention="true"]{opacity:1;border-color:#d9822b;color:#d9822b}',
        '.jws-modal{width:min(560px,94vw)}',
        '.jws-body{display:flex;flex-direction:column;gap:10px;max-height:66vh;overflow:auto;padding:2px}',
        '.jws-row{display:flex;gap:8px;flex-wrap:wrap}',
        '.jws-field{display:flex;flex-direction:column;gap:4px;flex:1 1 120px}',
        '.jws-label{font-size:11px;opacity:.65}',
        '.jws-control{background:transparent;border:1px solid rgba(128,128,128,.45);border-radius:6px;color:inherit;font:inherit;font-size:13px;padding:5px 7px;width:100%}',
        '.jws-textarea{min-height:76px;resize:vertical}',
        '.jws-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.jws-button{appearance:none;border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px;padding:5px 12px}',
        '.jws-button:hover:not(:disabled){border-color:currentColor}',
        '.jws-button:disabled{cursor:default;opacity:.45}',
        '.jws-button[data-primary="true"]{border-color:currentColor;font-weight:600}',
        '.jws-note{font-size:12px;line-height:1.5;opacity:.8}',
        '.jws-error{border-left:3px solid #d9534f;color:#d9534f;font-size:12px;line-height:1.5;padding:4px 8px;white-space:pre-wrap;word-break:break-word}',
        '.jws-status{border-left:3px solid currentColor;font-size:12px;line-height:1.5;opacity:.85;padding:4px 8px}',
        '.jws-status[data-status="breaking"]{border-color:#d9534f;color:#d9534f;opacity:1}',
        '.jws-status[data-status="changed"]{border-color:#d9822b;color:#d9822b;opacity:1}',
        '.jws-preview{display:flex;flex-wrap:wrap;gap:8px}',
        '.jws-preview img{border-radius:6px;max-height:180px;max-width:100%}',
        '.jws-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.7;word-break:break-all}',
        '.jws-list{display:flex;flex-direction:column;gap:6px}',
        '.jws-list-item{border:1px solid rgba(128,128,128,.3);border-radius:6px;font-size:12px;padding:5px 8px}',
      ].join('\n')
      document.head.appendChild(style)
    }

    // #endregion

    // #region components

    /** A labelled select driven by the values a model actually offers. */
    function SelectField(props) {
      const { label, value, values, onChange } = props
      if (values.length === 0) return null
      return h('label', { className: 'jws-field' },
        h('span', { className: 'jws-label' }, label),
        h('select', {
          className: 'jws-control',
          value: value ?? '',
          onChange: (event) => onChange(event.target.value),
        }, values.map((item) => h('option', { key: String(item), value: String(item) }, String(item)))),
      )
    }

    /**
     * The first-run key form.
     *
     * The host verifies the key before storing it, so a typo is reported here
     * instead of failing every later call.
     */
    function KeyForm(props) {
      const { onSaved } = props
      const [value, setValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      async function submit() {
        setBusy(true)
        setError(null)
        const result = await call('/key', { method: 'POST', body: { apiKey: value.trim() } })
        setBusy(false)
        if (!result.ok) {
          setError(describeError(result.body, '保存失败，请重试。'))
          return
        }
        setValue('')
        onSaved()
      }

      return h('div', { className: 'jws-body' },
        h('div', { className: 'jws-note' },
          '尚未配置 JWS 密钥。密钥以 jws_live_ 开头，在生图站创建；它只保存在宿主进程里，不会写进浏览器存储。'),
        h('label', { className: 'jws-field' },
          h('span', { className: 'jws-label' }, 'API 密钥'),
          h('input', {
            className: 'jws-control',
            type: 'password',
            autoComplete: 'off',
            placeholder: 'jws_live_...',
            value,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submit() },
          }),
        ),
        error === null ? null : h('div', { className: 'jws-error' }, error),
        h('div', { className: 'jws-actions' },
          h('button', {
            type: 'button',
            className: 'jws-button',
            'data-primary': 'true',
            disabled: busy || value.trim().length === 0,
            onClick: submit,
          }, busy ? '校验中…' : '保存并校验'),
        ),
      )
    }

    /** The API contract status bar, with the snapshot refresh action. */
    function StatusBar(props) {
      const { status } = props
      const [busy, setBusy] = React.useState(false)
      const [detail, setDetail] = React.useState(null)
      if (status === null || status === undefined) return null

      async function refresh() {
        setBusy(true)
        const result = await call('/api-update', { method: 'POST' })
        setBusy(false)
        setDetail(result.ok ? (result.body?.changes ?? []) : [describeError(result.body)])
      }

      const changes = detail ?? status.changes ?? []
      const actionable = status.status === 'changed' || status.status === 'breaking'
      return h('div', { className: 'jws-status', 'data-status': status.status },
        h('div', null, status.line ?? `API: ${status.status}`),
        changes.length === 0 ? null : h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
          changes.map((change, index) => h('li', { key: index }, String(change)))),
        actionable
          ? h('div', { className: 'jws-actions', style: { marginTop: '6px' } },
            h('button', { type: 'button', className: 'jws-button', disabled: busy, onClick: refresh },
              busy ? '刷新中…' : '更新快照'))
          : null,
      )
    }

    /** The generation form, driven entirely by the live catalog. */
    function GenerateForm(props) {
      const { models, maxAmount, budgetCurrency } = props
      const usable = models.filter(isUsableModel)
      const options = usable.length > 0 ? usable : models
      const [modelId, setModelId] = React.useState(options[0]?.id)
      const model = options.find((item) => item.id === modelId) ?? options[0]
      const skus = skusForMode(model, MODE)
      const fallback = defaultSku(model, MODE)

      const [size, setSize] = React.useState(fallback?.size)
      const [resolution, setResolution] = React.useState(fallback?.resolution)
      const [quality, setQuality] = React.useState(fallback?.quality)
      const [count, setCount] = React.useState(1)
      const [prompt, setPrompt] = React.useState('')
      const [quote, setQuote] = React.useState(null)
      const [images, setImages] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      /**
       * Re-seat every SKU field from the new model's own record.
       *
       * Carrying a size across models would quote a combination the API does
       * not sell.
       */
      function pickModel(nextId) {
        setModelId(nextId)
        const sku = defaultSku(options.find((item) => item.id === nextId), MODE)
        setSize(sku?.size)
        setResolution(sku?.resolution)
        setQuality(sku?.quality)
        setQuote(null)
        setError(null)
      }

      function selection() {
        return { size, resolution, quality, count }
      }

      async function askQuote() {
        setBusy(true)
        setError(null)
        const result = await call('/quote', {
          method: 'POST',
          body: { prompt, model: modelId, params: paramsFromSelection(selection()) },
        })
        setBusy(false)
        if (!result.ok) {
          setQuote(null)
          setError(describeError(result.body))
          return
        }
        setQuote(result.body)
      }

      async function generate() {
        setBusy(true)
        setError(null)
        const result = await call('/generate', {
          method: 'POST',
          body: { prompt, model: modelId, params: paramsFromSelection(selection()) },
        })
        setBusy(false)
        if (!result.ok) {
          setError(describeError(result.body))
          return
        }
        setQuote(null)
        setImages(result.body.images ?? [])
        setFiles(result.body.files ?? [])
      }

      const ready = prompt.trim().length > 0 && !busy

      return h('div', { className: 'jws-body' },
        h('div', { className: 'jws-row' },
          h('label', { className: 'jws-field' },
            h('span', { className: 'jws-label' }, '模型'),
            h('select', {
              className: 'jws-control',
              value: modelId ?? '',
              onChange: (event) => pickModel(event.target.value),
            }, options.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id))),
          ),
          h(SelectField, { label: '尺寸', value: size, values: optionValues(skus, 'size'), onChange: setSize }),
          h(SelectField, { label: '分辨率', value: resolution, values: optionValues(skus, 'resolution'), onChange: setResolution }),
          h(SelectField, { label: '质量', value: quality, values: optionValues(skus, 'quality'), onChange: setQuality }),
          h('label', { className: 'jws-field', style: { flex: '0 1 80px' } },
            h('span', { className: 'jws-label' }, '数量'),
            h('input', {
              className: 'jws-control',
              type: 'number',
              min: 1,
              max: model?.capabilities?.maxOutputImages ?? 4,
              value: count,
              onChange: (event) => setCount(Math.max(1, Number(event.target.value) || 1)),
            }),
          ),
        ),
        h('label', { className: 'jws-field' },
          h('span', { className: 'jws-label' }, '提示词'),
          h('textarea', {
            className: 'jws-control jws-textarea',
            value: prompt,
            placeholder: '描述你想生成的画面…',
            onChange: (event) => { setPrompt(event.target.value); setQuote(null) },
          }),
        ),
        error === null ? null : h('div', { className: 'jws-error' }, error),
        quote === null ? null : h('div', { className: 'jws-note' },
          `报价 ${formatCost(quote.amount, quote.currency)}（预算上限 ${maxAmount} ${budgetCurrency}）。确认后才会提交。`),
        h('div', { className: 'jws-actions' },
          h('button', { type: 'button', className: 'jws-button', disabled: !ready, onClick: askQuote },
            busy ? '处理中…' : '报价'),
          h('button', {
            type: 'button',
            className: 'jws-button',
            'data-primary': 'true',
            disabled: !ready,
            onClick: generate,
          }, quote === null ? '生成' : '确认生成'),
        ),
        images.length === 0 ? null : h('div', { className: 'jws-preview' },
          images.map((image, index) => {
            const url = imageDataUrl(image)
            return h('div', { key: index, style: { flex: '1 1 160px' } },
              url === null ? null : h('img', { src: url, alt: `生成结果 ${index + 1}` }),
              h('div', { className: 'jws-path' }, image.path ?? ''),
            )
          }),
        ),
        files.length === 0 ? null : h('div', { className: 'jws-note' }, `已写入 ${files.length} 个文件。`),
      )
    }

    /** The window body: key setup first, then the generation form. */
    function WindowBody(props) {
      const { state, onReload } = props
      const [models, setModels] = React.useState(null)
      const [error, setError] = React.useState(null)
      const hasKey = state?.hasKey === true

      React.useEffect(() => {
        if (!hasKey) return undefined
        let live = true
        call('/catalog').then((result) => {
          if (!live) return
          if (!result.ok) {
            setError(describeError(result.body))
            return
          }
          setModels(result.body.models ?? [])
        })
        return () => { live = false }
      }, [hasKey])

      if (state === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '读取中…'))
      if (state.error !== undefined) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-error' }, state.error))
      if (!hasKey) return h(KeyForm, { onSaved: onReload })
      if (error !== null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-error' }, error))
      if (models === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '读取模型目录…'))
      if (models.length === 0) {
        return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '账号下没有可用的图片模型。'))
      }
      return h(GenerateForm, { models, maxAmount: state.maxAmount, budgetCurrency: state.budgetCurrency })
    }

    /** The fallback overlay, used when the native Modal is unavailable. */
    function FallbackModal(props) {
      const { title, onClose, children } = props
      React.useEffect(() => {
        function onKey(event) { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      const overlay = h('div', {
        style: {
          alignItems: 'center',
          background: 'rgba(0,0,0,.45)',
          display: 'flex',
          inset: 0,
          justifyContent: 'center',
          position: 'fixed',
          zIndex: 2147483000,
        },
        onClick: onClose,
      }, h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        className: 'jws-modal',
        style: {
          background: 'var(--dsh-surface, #1c1c1e)',
          border: '1px solid rgba(128,128,128,.35)',
          borderRadius: '10px',
          color: 'inherit',
          maxHeight: '80vh',
          padding: '14px 16px',
          width: 'min(560px, 94vw)',
        },
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { style: { alignItems: 'center', display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } },
        h('strong', null, title),
        h('button', { type: 'button', className: 'jws-button', onClick: onClose }, '关闭'),
      ),
      children))
      if (ReactDOM?.createPortal !== undefined && typeof document !== 'undefined') {
        return ReactDOM.createPortal(overlay, document.body)
      }
      return overlay
    }

    /** The modal: the native primitive when available, otherwise our own. */
    function Window(props) {
      const { open, onClose, title, children } = props
      if (!open) return null
      if (typeof primitives?.Modal === 'function') {
        try {
          return h(primitives.Modal, { open, onClose, title, className: 'jws-modal' }, children)
        } catch {
          // Fall through to the built-in overlay.
        }
      }
      return h(FallbackModal, { title, onClose }, children)
    }

    /**
     * The dock entry and the window it opens.
     *
     * Opening loads the host state, the contract status and — once a key exists
     * — the live catalog, so the form never shows a hardcoded enum.
     */
    function JwsImageEntry() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      async function reload() {
        const result = await call('/state')
        setState(result.ok
          ? result.body
          : { hasKey: false, maxAmount: 0, budgetCurrency: 'CNY', error: describeError(result.body) })
      }

      async function openWindow() {
        ensureStyles()
        setOpen(true)
        setState(null)
        setStatus(null)
        await reload()
        const apiStatus = await call('/api-status')
        if (apiStatus.ok) setStatus(apiStatus.body)
      }

      const needsKey = open && state !== null && state.hasKey !== true

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'jws-entry',
          'data-attention': needsKey ? 'true' : 'false',
          title: 'JWS 生图',
          onClick: openWindow,
        }, needsKey ? '未配置密钥 · 点此设置' : 'JWS 生图'),
        h(Window, { open, onClose: () => setOpen(false), title: 'JWS 生图' },
          h(StatusBar, { status }),
          h(WindowBody, { state, onReload: reload }),
        ),
      )
    }

    // #endregion

    /**
     * Register the dock entry into the first declared candidate slot.
     *
     * Only one candidate may win. `inject` runs its callback synchronously for a
     * slot that is already declared, and the candidates are awaited best-first,
     * so the preferred slot claims the entry whenever it is available.
     *
     * @param ctx - the Cordis client context.
     */
    function apply(ctx) {
      try {
        const slots = ctx?.slots
        if (slots === undefined) return
        if (typeof slots.register !== 'function') return
        // Without the declaration-aware API there is no supported way to
        // register into a slot we do not own, so degrade to "no UI" rather than
        // calling register() and throwing into the shell's startup path.
        if (typeof slots.inject !== 'function') return
        if (React === null) return

        let claimed

        for (const slot of SLOT_CANDIDATES) {
          slots.inject(slot, () => {
            if (claimed !== undefined) return undefined
            const dispose = slots.register(
              { name: slot, id: ENTRY_ID, order: ENTRY_ORDER, label: 'JWS 生图' },
              JwsImageEntry,
            )
            claimed = slot
            return () => {
              claimed = undefined
              if (typeof dispose === 'function') dispose()
            }
          })
        }
      } catch {
        // The browser half must never throw: a throwing plugin paints a
        // "Failed to load plugins" card over the whole shell.
      }
    }

    exports.apply = apply
    exports.inject = inject
    // The pure core and the window's pieces are exported so the browser-half
    // tests can exercise them without a DOM; shipped plugins export their
    // internals the same way.
    exports.GenerateForm = GenerateForm
    exports.KeyForm = KeyForm
    exports.StatusBar = StatusBar
    exports.WindowBody = WindowBody
    exports.defaultSku = defaultSku
    exports.describeError = describeError
    exports.formatCost = formatCost
    exports.imageDataUrl = imageDataUrl
    exports.isUsableModel = isUsableModel
    exports.optionValues = optionValues
    exports.paramsFromSelection = paramsFromSelection
    exports.skusForMode = skusForMode
    return module.exports
  },
})