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
    /**
     * Tab-type identity in the right sidebar.
     *
     * A tab type needs an `id` of its own because a *kind* is not unique — an
     * extension may take over a builtin's kind. The `id` is also the key the
     * body and title register under in the two `sidebar.right.pane.tab*` seats.
     */
    const SIDEBAR_ID = 'dsh-plugin-jws-image'
    /** The page kind `openTab` names. A page type recognises no resource address. */
    const SIDEBAR_KIND = 'jws-image'

    const h = React === null ? null : React.createElement

    /**
     * Opens the right-sidebar tab, or `null` while that column is unavailable.
     *
     * Set from `apply` once the sidebar services are in scope. Keeping it in a
     * module variable is what lets the dock entry prefer the sidebar and still
     * fall back to the modal on a build that has no right column.
     */
    let openSidebarTab = null

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

    /**
     * The route URL for one image of one history entry.
     *
     * The task id and index are the only things the browser sends: the host
     * resolves the actual file from its own record, so a thumbnail request can
     * never name a path.
     */
    function historyImageUrl(taskId, index) {
      return `${API}/history-image?taskId=${encodeURIComponent(String(taskId))}&index=${index}`
    }

    /** The file name part of a path, for a caption. */
    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]/u)
      return parts[parts.length - 1] ?? path
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

    /** The upper bound on `count` a model advertises, defaulting to 4. */
    function maxCount(model) {
      const value = model?.capabilities?.maxOutputImages
      return typeof value === 'number' && value > 0 ? value : 4
    }

    /**
     * The catalog's price for exactly this selection.
     *
     * The catalog carries `price` per SKU, so the form can show a figure before
     * any quote round-trip. It is an estimate: the quote is what gates the
     * budget, and the UI line says so.
     *
     * @param skus - the chosen model's SKU list (as the catalog route trims it).
     * @param selection - the current size/resolution/quality/count.
     * @returns the estimate, or `null` when nothing matches.
     */
    function estimateForSelection(skus, selection) {
      const match = (Array.isArray(skus) ? skus : []).find((sku) =>
        (selection.size === undefined || sku.size === selection.size)
        && (selection.resolution === undefined || sku.resolution === selection.resolution)
        && (selection.quality === undefined || sku.quality === selection.quality))
      if (match === undefined || typeof match.price !== 'number') return null
      return { price: match.price, currency: match.currency ?? '?', count: selection.count }
    }

    /** Whether a failure reads like a credential problem the user can fix. */
    function looksLikeAuthFailure(message) {
      if (typeof message !== 'string') return false
      return /401|403|unauthor|密钥|未授权|无效/i.test(message)
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
      const { method = 'GET', body, signal } = options
      try {
        const response = await fetch(`${API}${path}`, {
          method,
          signal,
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
        if (signal?.aborted === true || error?.name === 'AbortError') {
          return { ok: false, status: -1, cancelled: true, body: { error: '已取消等待。' } }
        }
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
        '.jws-modal{width:min(680px,94vw)}',
        '.jws-body{display:flex;flex-direction:column;gap:10px;max-height:70vh;overflow:auto;padding:2px}',
        '.jws-panel{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:10px 12px}',
        '.jws-panel .jws-body{max-height:none;overflow:visible;padding:0}',
        '.jws-tab-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.jws-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}',
        '.jws-field{display:flex;flex-direction:column;gap:4px;flex:1 1 104px;min-width:0}',
        '.jws-field-wide{flex:1 1 100%}',
        '.jws-field-narrow{flex:0 1 84px}',
        '.jws-label{font-size:11px;opacity:.65}',
        '.jws-hint{font-size:11px;opacity:.5}',
        '.jws-control{background:transparent;border:1px solid rgba(128,128,128,.45);border-radius:6px;color:inherit;font:inherit;font-size:13px;padding:5px 7px;width:100%;box-sizing:border-box}',
        '.jws-control:disabled{opacity:.55}',
        '.jws-textarea{min-height:132px;resize:vertical;line-height:1.5}',
        '.jws-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.jws-button{appearance:none;border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px;padding:5px 12px}',
        '.jws-button:hover:not(:disabled){border-color:currentColor}',
        '.jws-button:disabled{cursor:default;opacity:.45}',
        '.jws-button[data-primary="true"]{border-color:currentColor;font-weight:600}',
        '.jws-link{appearance:none;background:none;border:0;color:inherit;cursor:pointer;font:inherit;font-size:12px;opacity:.65;padding:0;text-decoration:underline}',
        '.jws-link:hover{opacity:1}',
        '.jws-note{font-size:12px;line-height:1.5;opacity:.8}',
        '.jws-cost{border-left:3px solid #3fa66b;font-size:12px;line-height:1.6;padding:4px 8px}',
        '.jws-error{border-left:3px solid #d9534f;color:#d9534f;font-size:12px;line-height:1.5;padding:4px 8px;white-space:pre-wrap;word-break:break-word}',
        '.jws-status{border-left:3px solid currentColor;font-size:12px;line-height:1.5;opacity:.85;padding:4px 8px}',
        '.jws-status[data-status="breaking"]{border-color:#d9534f;color:#d9534f;opacity:1}',
        '.jws-status[data-status="changed"]{border-color:#d9822b;color:#d9822b;opacity:1}',
        '.jws-preview{display:flex;flex-wrap:wrap;gap:10px}',
        '.jws-preview figure{margin:0;flex:1 1 220px;min-width:0}',
        '.jws-preview img{border-radius:8px;cursor:zoom-in;display:block;max-height:320px;max-width:100%}',
        '.jws-thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}',
        '.jws-thumb{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.3);border-radius:6px;cursor:zoom-in;height:58px;object-fit:cover;width:58px}',
        '.jws-thumb:hover{border-color:currentColor}',
        '.jws-refs{display:flex;flex-direction:column;gap:6px}',
        '.jws-ref{align-items:center;display:flex;gap:6px}',
        '.jws-ref .jws-thumb{width:44px;height:44px}',
        '.jws-drop{align-items:center;border:1px dashed rgba(128,128,128,.4);border-radius:8px;display:flex;gap:8px;padding:6px 10px}',
        '.jws-drop[data-dragging="true"]{border-color:currentColor}',
        '.jws-estimate{font-size:12px;opacity:.85}',
        '.jws-lightbox{align-items:center;background:rgba(0,0,0,.74);cursor:zoom-out;display:flex;inset:0;justify-content:center;padding:24px;position:fixed;z-index:2147483001}',
        '.jws-lightbox img{border-radius:8px;box-shadow:0 14px 48px rgba(0,0,0,.55);cursor:default;max-height:calc(100vh - 96px);max-width:calc(100vw - 48px)}',
        '.jws-lightbox-caption{bottom:14px;color:#fff;font-size:12px;left:0;line-height:1.6;opacity:.88;padding:0 28px;position:absolute;right:0;text-align:center;word-break:break-all}',
        '.jws-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.7;word-break:break-all;margin-top:4px}',
        '.jws-history{display:flex;flex-direction:column;gap:6px}',
        '.jws-history-item{border:1px solid rgba(128,128,128,.3);border-radius:6px;display:flex;flex-direction:column;gap:3px;font-size:12px;padding:6px 8px}',
        '.jws-history-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between}',
        '.jws-history-prompt{opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      ].join('\n')
      document.head.appendChild(style)
    }

    // #endregion

    // #region components

    /** A labelled select driven by the values a model actually offers. */
    function SelectField(props) {
      const { label, value, values, onChange, disabled } = props
      if (values.length === 0) return null
      return h('label', { className: 'jws-field' },
        h('span', { className: 'jws-label' }, label),
        h('select', {
          className: 'jws-control',
          value: value ?? '',
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }, values.map((item) => h('option', { key: String(item), value: String(item) }, String(item)))),
      )
    }

    /**
     * The first-run key form, also used to replace an expired key.
     *
     * The host verifies the key before storing it, so a typo is reported here
     * instead of failing every later call.
     */
    function KeyForm(props) {
      const { onSaved, onCancel } = props
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
          '密钥以 jws_live_ 开头，在生图站创建；它只保存在宿主进程里，不会写进浏览器存储，也不会回显。'),
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
          onCancel === undefined
            ? null
            : h('button', { type: 'button', className: 'jws-button', disabled: busy, onClick: onCancel }, '取消'),
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

    /**
     * A full-size view of one image.
     *
     * Portalled to the body when react-dom is available, because the sidebar
     * pane clips its own overflow and a preview inside it would be cut off.
     * Escape and a backdrop click both close it.
     */
    function Lightbox(props) {
      const { preview, onClose } = props
      React.useEffect(() => {
        if (preview === null || preview === undefined || typeof document === 'undefined') return undefined
        function onKey(event) { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [preview, onClose])
      if (preview === null || preview === undefined) return null

      const overlay = h('div', {
        className: 'jws-lightbox',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': preview.title ?? '图片预览',
        onClick: onClose,
      },
      h('img', {
        src: preview.src,
        alt: preview.title ?? '图片预览',
        onClick: (event) => event.stopPropagation(),
      }),
      preview.caption === undefined
        ? null
        : h('div', { className: 'jws-lightbox-caption' }, preview.caption))

      if (ReactDOM?.createPortal !== undefined && typeof document !== 'undefined') {
        return ReactDOM.createPortal(overlay, document.body)
      }
      return overlay
    }

    /** What the user paid and which task produced it. */
    function CostLine(props) {
      const { result } = props
      if (result === null || result === undefined) return null
      const images = Array.isArray(result.images) ? result.images.length : 0
      return h('div', { className: 'jws-cost' },
        h('div', null, `已生成 ${images} 张 · 实际费用 ${formatCost(result.amount, result.currency)}`),
        h('div', { className: 'jws-path' }, `模型 ${result.model ?? '—'} · 参数 ${JSON.stringify(result.params ?? {})}`),
        result.taskId === undefined ? null : h('div', { className: 'jws-path' }, `任务 ${result.taskId}`),
      )
    }

    /** This process's finished generations, with thumbnails and a one-click parameter refill. */
    function HistoryList(props) {
      const { entries, onRerun, onPreview } = props
      if (!Array.isArray(entries) || entries.length === 0) return null
      return h('div', { className: 'jws-history' },
        h('div', { className: 'jws-label' }, `本次会话历史（${entries.length}）`),
        entries.map((entry, index) => {
          const files = Array.isArray(entry.files) ? entry.files : []
          return h('div', { key: `${entry.taskId ?? index}`, className: 'jws-history-item' },
            h('div', { className: 'jws-history-head' },
              h('span', null, `${formatCost(entry.amount, entry.currency)} · ${entry.model ?? '—'}`),
              h('button', { type: 'button', className: 'jws-link', onClick: () => onRerun(entry) }, '回填参数'),
            ),
            files.length === 0
              ? null
              : h('div', { className: 'jws-thumbs' },
                files.map((path, imageIndex) => {
                  const src = historyImageUrl(entry.taskId, imageIndex)
                  return h('img', {
                    key: imageIndex,
                    className: 'jws-thumb',
                    src,
                    alt: baseName(path),
                    title: path,
                    // Twenty entries of full-size PNGs would be tens of
                    // megabytes; only fetch what is actually looked at.
                    loading: 'lazy',
                    onClick: () => onPreview({
                      src,
                      title: baseName(path),
                      caption: `${formatCost(entry.amount, entry.currency)} · ${entry.model ?? ''} · ${path}`,
                    }),
                  })
                }),
              ),
            h('div', { className: 'jws-history-prompt', title: entry.prompt ?? '' }, entry.prompt ?? ''),
          )
        }),
      )
    }

    /**
     * Reference-image input: a picker plus a drop zone.
     *
     * Files are read locally and sent to the host as base64, which the host
     * uploads through the inputs flow. The bytes never go through this file
     * again except back out as thumbnails.
     */
    function ReferencePicker(props) {
      const { references, disabled, onAdd, onRemove } = props
      const [dragging, setDragging] = React.useState(false)

      function onDrop(event) {
        event.preventDefault()
        setDragging(false)
        if (event.dataTransfer?.files !== undefined) onAdd(event.dataTransfer.files)
      }

      return h('div', { className: 'jws-refs' },
        references.length === 0
          ? null
          : h('div', { className: 'jws-thumbs' },
            references.map((reference, index) => h('span', { key: index, className: 'jws-ref' },
              h('img', {
                className: 'jws-thumb',
                src: `data:${reference.mimeType};base64,${reference.data}`,
                alt: reference.name ?? `参考图 ${index + 1}`,
                title: reference.name ?? `参考图 ${index + 1}`,
              }),
              h('button', { type: 'button', className: 'jws-link', disabled, onClick: () => onRemove(index) }, '移除'),
            )),
          ),
        h('div', {
          className: 'jws-drop',
          'data-dragging': dragging ? 'true' : 'false',
          onDragOver: (event) => { event.preventDefault(); setDragging(true) },
          onDragLeave: () => setDragging(false),
          onDrop,
        },
          h('label', { className: 'jws-link' },
            references.length > 0 ? '再加参考图' : '添加参考图',
            h('input', {
              type: 'file',
              accept: 'image/*',
              multiple: true,
              disabled,
              style: { display: 'none' },
              onChange: (event) => {
                onAdd(event.target.files)
                event.target.value = ''
              },
            }),
          ),
          references.length > 0 ? null : h('span', { className: 'jws-hint' }, '或拖一张图进来（图生图）'),
        ),
      )
    }

    /** The generation form, driven entirely by the live catalog. */
    function GenerateForm(props) {
      const { models, maxAmount, budgetCurrency, seed, onGenerated, onPreview } = props
      const usable = models.filter(isUsableModel)
      const options = usable.length > 0 ? usable : models

      // A seed (from history) only applies on mount; the parent remounts this
      // component with a fresh `key` to request a refill.
      const seededModel = seed?.model !== undefined && options.some((item) => item.id === seed.model)
        ? seed.model
        : options[0]?.id
      const [modelId, setModelId] = React.useState(seededModel)
      const model = options.find((item) => item.id === modelId) ?? options[0]
      const skus = skusForMode(model, MODE)
      const fallback = defaultSku(model, MODE)
      const limit = maxCount(model)

      const [size, setSize] = React.useState(seed?.params?.size ?? fallback?.size)
      const [resolution, setResolution] = React.useState(seed?.params?.resolution ?? fallback?.resolution)
      const [quality, setQuality] = React.useState(seed?.params?.quality ?? fallback?.quality)
      const [count, setCount] = React.useState(seed?.params?.count ?? 1)
      const [prompt, setPrompt] = React.useState(seed?.prompt ?? '')
      const [quote, setQuote] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [phase, setPhase] = React.useState('')
      const [elapsed, setElapsed] = React.useState(0)
      const [error, setError] = React.useState(null)
      const [references, setReferences] = React.useState([])
      // One controller per generation, so "取消" can stop the wait.
      const [controller, setController] = React.useState(null)

      // A long generation gives no server-side progress, so at least show that
      // time is passing and how long it has been.
      React.useEffect(() => {
        if (!busy) return undefined
        const started = Date.now()
        setElapsed(0)
        const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(id)
      }, [busy])

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
        setCount((current) => Math.min(current, maxCount(options.find((item) => item.id === nextId))))
        setQuote(null)
        setError(null)
      }

      function selection() {
        return { size, resolution, quality, count }
      }

      // Reference images switch the call to image-to-image, whose SKUs differ.
      const mode = references.length > 0 ? 'image-to-image' : 'text-to-image'
      const estimate = estimateForSelection(skusForMode(model, mode), selection())

      /** Read local image files into base64 records the host can upload. */
      function addReferences(files) {
        const list = Array.from(files ?? [])
          .filter((file) => typeof file?.type === 'string' && file.type.startsWith('image/'))
          .slice(0, 16 - references.length)
        if (list.length === 0) return
        let remaining = list.length
        const added = []
        for (const file of list) {
          const reader = new FileReader()
          reader.onload = () => {
            const data = String(reader.result).split(',')[1] ?? ''
            added.push({ name: file.name, mimeType: file.type, data })
            remaining -= 1
            if (remaining === 0) setReferences((current) => [...current, ...added])
          }
          reader.readAsDataURL(file)
        }
      }

      function removeReference(index) {
        setReferences((current) => current.filter((_, i) => i !== index))
        setQuote(null)
      }

      function cancel() {
        controller?.abort()
      }

      async function askQuote() {
        setBusy(true)
        setPhase('报价中')
        setError(null)
        const response = await call('/quote', {
          method: 'POST',
          body: {
            prompt,
            model: modelId,
            params: paramsFromSelection(selection()),
            ...(references.length === 0 ? {} : { references }),
          },
        })
        setBusy(false)
        setPhase('')
        if (!response.ok) {
          setQuote(null)
          setError(describeError(response.body))
          return
        }
        setQuote(response.body)
      }

      async function generate() {
        const current = new AbortController()
        setController(current)
        setBusy(true)
        setPhase('生成中')
        setError(null)
        const response = await call('/generate', {
          method: 'POST',
          signal: current.signal,
          body: {
            prompt,
            model: modelId,
            params: paramsFromSelection(selection()),
            ...(references.length === 0 ? {} : { references }),
          },
        })
        setBusy(false)
        setPhase('')
        setController(null)
        if (response.cancelled === true) {
          // The host finishes the task it already submitted, and the account is
          // still billed for it: cancelling stops the wait, not the charge.
          setError('已取消等待。任务可能仍在服务端进行并计费——刷新历史可以看到最终结果。')
          return
        }
        if (!response.ok) {
          setError(describeError(response.body))
          return
        }
        setQuote(null)
        setResult(response.body)
        if (onGenerated !== undefined) onGenerated()
      }

      const ready = prompt.trim().length > 0 && !busy

      return h('div', { className: 'jws-body' },
        h('div', { className: 'jws-row' },
          h('label', { className: 'jws-field jws-field-wide' },
            h('span', { className: 'jws-label' }, '模型'),
            h('select', {
              className: 'jws-control',
              value: modelId ?? '',
              disabled: busy,
              onChange: (event) => pickModel(event.target.value),
            }, options.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id))),
          ),
        ),
        h('div', { className: 'jws-row' },
          h(SelectField, { label: '尺寸', value: size, values: optionValues(skus, 'size'), onChange: setSize, disabled: busy }),
          h(SelectField, { label: '分辨率', value: resolution, values: optionValues(skus, 'resolution'), onChange: setResolution, disabled: busy }),
          h(SelectField, { label: '质量', value: quality, values: optionValues(skus, 'quality'), onChange: setQuality, disabled: busy }),
          h('label', { className: 'jws-field jws-field-narrow' },
            h('span', { className: 'jws-label' }, '数量'),
            h('input', {
              className: 'jws-control',
              type: 'number',
              min: 1,
              max: limit,
              value: count,
              disabled: busy,
              onChange: (event) => {
                const next = Math.max(1, Math.min(limit, Number(event.target.value) || 1))
                setCount(next)
              },
            }),
            h('span', { className: 'jws-hint' }, `最多 ${limit}`),
          ),
        ),
        h('label', { className: 'jws-field' },
          h('span', { className: 'jws-label' }, '提示词'),
          h('textarea', {
            className: 'jws-control jws-textarea',
            value: prompt,
            disabled: busy,
            placeholder: '描述你想生成的画面…',
            onChange: (event) => { setPrompt(event.target.value); setQuote(null) },
          }),
        ),
        h(ReferencePicker, { references, disabled: busy, onAdd: addReferences, onRemove: removeReference }),
        error === null ? null : h('div', { className: 'jws-error' }, error),
        error !== null && looksLikeAuthFailure(error)
          ? h('div', { className: 'jws-actions' }, h('span', { className: 'jws-hint' }, '这看起来是密钥问题，可用窗口底部的「更换密钥」重新设置。'))
          : null,
        estimate === null ? null : h('div', { className: 'jws-estimate' },
          `估算 ${formatCost(estimate.price * estimate.count, estimate.currency)}`
          + `（${formatCost(estimate.price, estimate.currency)}/张 × ${estimate.count}，实际以报价为准）`),
        quote === null ? null : h('div', { className: 'jws-note' },
          `报价 ${formatCost(quote.amount, quote.currency)}（预算上限 ${maxAmount} ${budgetCurrency}）。确认后才会提交。`),
        h('div', { className: 'jws-actions' },
          h('button', { type: 'button', className: 'jws-button', disabled: !ready, onClick: askQuote },
            busy && phase === '报价中' ? '报价中…' : '报价'),
          h('button', {
            type: 'button',
            className: 'jws-button',
            'data-primary': 'true',
            disabled: !ready,
            onClick: generate,
          }, busy && phase === '生成中' ? `生成中… ${elapsed}s` : (quote === null ? '生成' : '确认生成')),
          busy && phase === '生成中'
            ? h('button', { type: 'button', className: 'jws-button', onClick: cancel }, '取消等待')
            : null,
        ),
        h(CostLine, { result }),
        result === null || !Array.isArray(result.images) || result.images.length === 0
          ? null
          : h('div', { className: 'jws-preview' },
            result.images.map((image, index) => {
              const url = imageDataUrl(image)
              const caption = `${formatCost(result.amount, result.currency)} · ${result.model ?? ''} · ${image.path ?? ''}`
              return h('figure', { key: index },
                url === null
                  ? null
                  : h('img', {
                    src: url,
                    alt: `生成结果 ${index + 1}`,
                    title: '点击看大图',
                    onClick: () => onPreview({
                      src: url,
                      title: baseName(image.path) || `生成结果 ${index + 1}`,
                      caption,
                    }),
                  }),
                h('div', { className: 'jws-path' }, image.path ?? ''),
              )
            }),
          ),
      )
    }

    /** The window body: key setup first, then the generation form. */
    function WindowBody(props) {
      const { state, onReload } = props
      const [models, setModels] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [seed, setSeed] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)
      const [changingKey, setChangingKey] = React.useState(false)
      // One lightbox for the whole panel, shared by fresh results and history
      // thumbnails, so both surfaces preview identically.
      const [preview, setPreview] = React.useState(null)
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
        call('/history').then((result) => {
          if (live && result.ok) setHistory(result.body.entries ?? [])
        })
        return () => { live = false }
      }, [hasKey, nonce])

      /** Re-read the history after a generation, without re-fetching the catalog. */
      function refreshHistory() {
        call('/history').then((result) => {
          if (result.ok) setHistory(result.body.entries ?? [])
        })
      }

      if (state === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '读取中…'))
      if (state.error !== undefined) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-error' }, state.error))
      if (!hasKey || changingKey) {
        return h('div', null,
          h(KeyForm, {
            onSaved: () => { setChangingKey(false); setError(null); setModels(null); onReload() },
            ...(hasKey ? { onCancel: () => setChangingKey(false) } : {}),
          }),
        )
      }
      if (error !== null) {
        return h('div', { className: 'jws-body' },
          h('div', { className: 'jws-error' }, error),
          h('div', { className: 'jws-actions' },
            h('button', { type: 'button', className: 'jws-button', onClick: () => setChangingKey(true) }, '更换密钥')),
        )
      }
      if (models === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '读取模型目录…'))
      if (models.length === 0) {
        return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, '账号下没有可用的图片模型。'))
      }

      return h(React.Fragment, null,
        h(GenerateForm, {
          key: nonce,
          models,
          maxAmount: state.maxAmount,
          budgetCurrency: state.budgetCurrency,
          seed,
          onGenerated: refreshHistory,
          onPreview: setPreview,
        }),
        h(HistoryList, {
          entries: history,
          onPreview: setPreview,
          onRerun: (entry) => {
            setSeed({ model: entry.model, params: entry.params, prompt: entry.prompt })
            setNonce((value) => value + 1)
          },
        }),
        h('div', { className: 'jws-actions' },
          h('button', { type: 'button', className: 'jws-link', onClick: () => setChangingKey(true) }, '更换密钥'),
          h('span', { className: 'jws-hint' }, `输出目录 ${state.outputDir ?? '—'}`),
        ),
        h(Lightbox, { preview, onClose: () => setPreview(null) }),
      )
    }

    /**
     * The right-sidebar tab body.
     *
     * Unlike the modal, this panel owns its own state load: a tab can be opened
     * by the sidebar itself (its guide page, a restored layout) with no dock
     * entry involved, so it cannot depend on the entry having fetched anything.
     */
    function SidebarPanel() {
      const [state, setState] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      async function load() {
        const result = await call('/state')
        setState(result.ok
          ? result.body
          : { hasKey: false, maxAmount: 0, budgetCurrency: 'CNY', error: describeError(result.body) })
      }

      React.useEffect(() => {
        // The sidebar can open this tab on its own — from the guide page or a
        // restored layout — without the dock entry ever being clicked, so the
        // stylesheet cannot depend on that click having happened.
        ensureStyles()
        let live = true
        load().then(() => {
          call('/api-status').then((result) => { if (live && result.ok) setStatus(result.body) })
        })
        return () => { live = false }
      }, [])

      return h('div', { className: 'jws-panel' },
        h(StatusBar, { status }),
        h(WindowBody, { state, onReload: load }),
      )
    }

    /** The tab chip's text, shown in the sidebar's tab strip. */
    function SidebarTitle() {
      return h('span', { className: 'jws-tab-title' }, 'JWS 生图')
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
          width: 'min(680px, 94vw)',
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

      // Learn about a missing key without waiting for a click: this entry now
      // opens the sidebar rather than the modal, so the "no key" hint would
      // otherwise never be able to appear.
      React.useEffect(() => {
        reload()
      }, [])

      async function openWindow() {
        ensureStyles()
        // Prefer the right sidebar; fall back to the modal when this build has
        // no right column, or when the column refused the registration.
        if (openSidebarTab !== null) {
          try {
            openSidebarTab()
            return
          } catch {
            openSidebarTab = null
          }
        }
        setOpen(true)
        setState(null)
        setStatus(null)
        await reload()
        const apiStatus = await call('/api-status')
        if (apiStatus.ok) setStatus(apiStatus.body)
      }

      const needsKey = state !== null && state.hasKey !== true && state.error === undefined

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

      // The right sidebar is optional: a build without it (or without the tab
      // registry) keeps the modal, which is why `sidebarRightTabs` is awaited
      // through ctx.inject instead of being added to this plugin's own inject
      // list — that would gate the whole browser half on the column existing.
      try {
        if (typeof ctx?.inject !== 'function') return
        ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], (scope) => {
          try {
            // Stage one: what the type IS (identity, kind, chip text).
            scope.effect(() => scope.sidebarRightTabs.register({
              id: SIDEBAR_ID,
              kind: SIDEBAR_KIND,
              // A type from outside the product; it outranks shipped viewers.
              priority: 'extension',
              title: () => 'JWS 生图',
              guide: [{
                order: 20,
                title: () => 'JWS 生图',
                description: () => '用 JWS 接口生成图片',
              }],
            }), 'jws-image: sidebar tab type')

            // Stage two: the body, keyed by the definition's own id.
            scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
              { name: 'sidebar.right.pane.tab', key: SIDEBAR_ID },
              SidebarPanel,
            )), 'jws-image: sidebar tab body')

            scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_ID },
              SidebarTitle,
            )), 'jws-image: sidebar tab title')

            openSidebarTab = () => scope.sidebarRight.openTab(SIDEBAR_KIND)
          } catch {
            // Any part of the column refusing the registration leaves the modal
            // in place rather than breaking the plugin.
            openSidebarTab = null
          }
        })
      } catch {
        openSidebarTab = null
      }
    }

    exports.apply = apply
    exports.inject = inject
    // The pure core and the window's pieces are exported so the browser-half
    // tests can exercise them without a DOM; shipped plugins export their
    // internals the same way.
    exports.CostLine = CostLine
    exports.GenerateForm = GenerateForm
    exports.HistoryList = HistoryList
    exports.KeyForm = KeyForm
    exports.Lightbox = Lightbox
    exports.ReferencePicker = ReferencePicker
    exports.SIDEBAR_ID = SIDEBAR_ID
    exports.SIDEBAR_KIND = SIDEBAR_KIND
    exports.SidebarPanel = SidebarPanel
    exports.SidebarTitle = SidebarTitle
    exports.StatusBar = StatusBar
    exports.WindowBody = WindowBody
    exports.defaultSku = defaultSku
    exports.baseName = baseName
    exports.describeError = describeError
    exports.estimateForSelection = estimateForSelection
    exports.formatCost = formatCost
    exports.historyImageUrl = historyImageUrl
    exports.imageDataUrl = imageDataUrl
    exports.isUsableModel = isUsableModel
    exports.looksLikeAuthFailure = looksLikeAuthFailure
    exports.maxCount = maxCount
    exports.optionValues = optionValues
    exports.paramsFromSelection = paramsFromSelection
    exports.skusForMode = skusForMode
    return module.exports
  },
})