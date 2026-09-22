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
 *
 * SESSION-SCOPED PROPS — the other part that is easy to get wrong:
 * every slot this plugin occupies is `scope: 'session'`, so the occupant is
 * handed the session's standard props (`sessionId`, `inputActions`, `useInput`,
 * `useSession`, …) on top of its own. Those are what "送进对话" needs, and every
 * one of them is optional here: a build that stops passing them degrades the
 * button to "copy the path" instead of breaking the window.
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
    /** The mode a call without reference images uses. */
    const MODE = 'text-to-image'
    /** The mode a call with reference images uses. */
    const REFERENCE_MODE = 'image-to-image'
    /**
     * How many reference images to assume when the catalog does not say.
     *
     * Mirrors the transport ceiling in the host half, and matches the
     * `referenceCount` maximum in the live generation schema. A model that
     * publishes `maxInputImages` always overrides it.
     */
    const REFERENCE_FALLBACK_LIMIT = 16
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
    /** Namespace this plugin registers its dictionaries under. */
    const I18N_NS = 'jws-image'

    const h = React === null ? null : React.createElement

    /**
     * Opens the right-sidebar tab, or `null` while that column is unavailable.
     *
     * Set from `apply` once the sidebar services are in scope. Keeping it in a
     * module variable is what lets the dock entry prefer the sidebar and still
     * fall back to the modal on a build that has no right column.
     */
    let openSidebarTab = null

    /**
     * The plugin's own client context, captured so the window can reach the
     * conversation service (which is a root singleton, not a slot prop).
     */
    let hostContext = null

    // #region i18n

    /**
     * Every user-facing string, keyed rather than inlined.
     *
     * Two dictionaries, not a translation service: the window is small enough
     * that a flat table is cheaper than a resolver, and the active language is
     * read at render time so a switch repaints without re-registering slots.
     * Chinese is the default and the fallback — it is the language this plugin
     * was written in, so a key missing from another dictionary still reads as
     * something a human wrote.
     */
    const MESSAGES = {
      zh: {
        'app.title': 'JWS 生图',
        'app.guide': '用 JWS 接口生成图片',
        'entry.needsKey': '未配置密钥 · 点此设置',
        'entry.title': 'JWS 生图',

        'common.cancel': '取消',
        'common.remove': '移除',
        'common.delete': '删除',
        'common.close': '关闭',

        'onboarding.title': '这是什么',
        'onboarding.body': '用 JWS 接口生成图片：先在生图站创建以 jws_live_ 开头的密钥，填进这里；'
          + '然后在窗口里选模型和尺寸，先报价再生成，费用按张计。',
        'onboarding.budget': '配置上限是 {amount} {currency}；窗口里可以按次调低，'
          + '但不能调高。超限会熔断，不提交生成。',
        'onboarding.currency': '注意：预算按 {currency} 书写，而接口以 USD 报价，两者不换算即直接比较。',
        'onboarding.dismiss': '知道了',

        'key.note': '密钥以 jws_live_ 开头，在生图站创建；它只保存在宿主进程里，'
          + '不会写进浏览器存储，也不会回显。',
        'key.label': 'API 密钥',
        'key.busy': '校验中…',
        'key.save': '保存并校验',

        'status.refreshing': '刷新中…',
        'status.update': '更新快照',

        'lightbox.label': '图片预览',
        'lightbox.alt': '图片预览',

        'cost.generated': '已生成 {count} 张 · 实际费用 {cost}',
        'cost.model': '模型 {model} · 参数 {params}',
        'cost.task': '任务 {task}',

        'history.title': '本次会话历史（{count}）',
        'history.rerun': '回填参数',
        'history.clear': '清空历史',
        'history.clearConfirm': '再点一次确认清空（只清列表，不删文件）',
        'history.clearConfirmFiles': '再点一次确认清空（连磁盘文件一起删，无法恢复）',
        'history.deleteHint': '从列表移除，不删除磁盘上的文件',
        'history.deleteHintFiles': '删除这条记录，并删除磁盘上的图片文件（无法恢复）',
        'history.deleteConfirm': '再点一次删除（连文件）',
        'history.withFiles': '同时删除磁盘文件',
        'history.withFilesHint': '默认只从列表移除。勾选后图片文件也一并删除，且无法恢复。',
        'history.removedRecords': '已删除 {count} 条记录（磁盘文件保留）',
        'history.removedWithFiles': '已删除 {count} 条记录，连同 {files} 个文件',
        'history.filesFailed': '{count} 个文件没能删除：{reason}',

        'refs.add': '添加参考图',
        'refs.addMore': '再加参考图',
        'refs.dropHint': '或拖一张图进来（图生图）',
        'refs.label': '参考图 {index}',
        'refs.limit': '最多 {limit} 张；已选 {count}',
        'refs.unsupported': '该模型没有图生图模式，不能加参考图。',
        'refs.none': '该模型不接受参考图（maxInputImages = 0）。',
        'refs.full': '已达该模型的参考图上限（{limit} 张）。',

        'form.model': '模型',
        'form.size': '尺寸',
        'form.resolution': '分辨率',
        'form.quality': '质量',
        'form.count': '数量',
        'form.countMax': '最多 {limit}',
        'form.prompt': '提示词',
        'form.promptPlaceholder': '描述你想生成的画面…',
        'form.promptCount': '{used} / {limit} 字',
        'form.promptTooLong': '提示词超过该模型上限（{limit} 字）。',
        'form.customToggle': '自定义尺寸',
        'form.customWidth': '宽',
        'form.customHeight': '高',
        'form.customReset': '还原为预设尺寸',
        'form.customNoPrice': '自定义尺寸没有目录价，请先报价确认金额。',
        'form.budget': '本次预算',
        'form.budgetHint': '按 {currency} 书写；最高 {amount}（配置上限）',
        'form.estimate': '估算 {total}（{unit} × {count}，实际以报价为准）',
        'form.quoteNote': '报价 {amount}（本次预算 {budget} {currency}）。确认后才会提交。',
        'form.quote': '报价',
        'form.quoteBusy': '报价中…',
        'form.generate': '生成',
        'form.confirmGenerate': '确认生成',
        'form.generating': '生成中… {seconds}s',
        'form.cancelWait': '取消等待',
        'form.cancelled': '已取消等待。任务可能仍在服务端进行并计费——刷新历史可以看到最终结果。',
        'form.authHint': '这看起来是密钥问题，可用窗口底部的「更换密钥」重新设置。',

        'info.title': '模型信息 {model}',
        'info.maxOutput': '最多输出 {count} 张',
        'info.maxInput': '最多参考图 {count} 张',
        'info.maxPrompt': '提示词上限 {count} 字',
        'info.countUnit': '计价单位 {unit}',
        'info.outputs': '输出格式 {list}',
        'info.moderations': '审查级别 {list}',
        'info.supports': '支持 {list}',
        'info.flagMask': '遮罩',
        'info.flagBackground': '背景控制',
        'info.flagCustomSize': '自定义尺寸',
        'info.params': '模型专属参数：{list}',
        'info.sizeLimits': '自定义尺寸限制：{list}，请先用报价确认',
        'info.notes': '说明：{text}',
        'info.noLimit': '目录未声明额外限制',

        'sizeLimit.multipleOf': '边长须为 {n} 的倍数',
        'sizeLimit.maxSide': '最长边 ≤ {n}',
        'sizeLimit.aspect': '宽高比 ≤ {n}',
        'sizeLimit.minPixels': '像素数 ≥ {n}',
        'sizeLimit.maxPixels': '像素数 ≤ {n}',
        'sizeError.positive': '宽和高必须是正整数。',
        'sizeError.multipleOf': '宽和高都必须是 {n} 的倍数。',
        'sizeError.maxSide': '最长边不能超过 {n}。',
        'sizeError.aspect': '宽高比不能超过 {n}。',
        'sizeError.minPixels': '像素总数不能少于 {n}。',
        'sizeError.maxPixels': '像素总数不能超过 {n}。',

        'send.button': '送进对话',
        'send.busy': '放入中…',
        'send.done': '已放进输入框（含这段提示词）。确认后按回车发送。',
        'send.noSession': '当前没有可用的会话，送不进去。已改为复制图片路径。',
        'send.noService': '宿主没有暴露会话写入能力，送不进去。已改为复制图片路径。',
        'send.attachRefused': '输入框现在不接受附件（可能正在提交中）。已改为复制图片路径。',
        'send.failed': '放入输入框失败：{reason}。已改为复制图片路径。',
        'send.gateHint': '若路由模型不支持图片输入，发送时会被拦下——换一个支持视觉的模型即可。',

        'copy.button': '复制路径',
        'copy.done': '已复制图片路径。',
        'copy.failed': '复制失败，请手动复制：{path}',

        'window.loading': '读取中…',
        'window.catalog': '读取模型目录…',
        'window.noModels': '账号下没有可用的图片模型。',
        'window.changeKey': '更换密钥',
        'window.outputDir': '输出目录 {dir}',
      },
      en: {
        'app.title': 'JWS image',
        'app.guide': 'Generate images through the JWS API',
        'entry.needsKey': 'No API key · set one',
        'entry.title': 'JWS image',

        'common.cancel': 'Cancel',
        'common.remove': 'Remove',
        'common.delete': 'Delete',
        'common.close': 'Close',

        'onboarding.title': 'What this is',
        'onboarding.body': 'Generate images through the JWS API. Create a key starting with '
          + 'jws_live_ on the image site and paste it here, then pick a model and a size, quote '
          + 'first, and generate. Each image is billed individually.',
        'onboarding.budget': 'The configured ceiling is {amount} {currency}. You can lower it for a '
          + 'single call in the window, but never raise it; anything above it is refused before '
          + 'submission.',
        'onboarding.currency': 'Note: the cap is written in {currency} while the API quotes in USD, '
          + 'and the two are compared without conversion.',
        'onboarding.dismiss': 'Got it',

        'key.note': 'The key starts with jws_live_ and is created on the image site. It is stored '
          + 'only in the host process — never in browser storage, and never echoed back.',
        'key.label': 'API key',
        'key.busy': 'Verifying…',
        'key.save': 'Save and verify',

        'status.refreshing': 'Refreshing…',
        'status.update': 'Update snapshot',

        'lightbox.label': 'Image preview',
        'lightbox.alt': 'Image preview',

        'cost.generated': 'Generated {count} · charged {cost}',
        'cost.model': 'Model {model} · params {params}',
        'cost.task': 'Task {task}',

        'history.title': 'History ({count})',
        'history.rerun': 'Refill',
        'history.clear': 'Clear history',
        'history.clearConfirm': 'Click again to clear (the list only — files stay on disk)',
        'history.clearConfirmFiles': 'Click again to clear — records AND image files, which cannot be recovered',
        'history.deleteHint': 'Remove from the list; the file on disk is kept',
        'history.deleteHintFiles': 'Delete this entry and its image files on disk (cannot be undone)',
        'history.deleteConfirm': 'Click again to delete (files too)',
        'history.withFiles': 'Also delete the files',
        'history.withFilesHint': 'Off by default: the list only. Ticked, the image files go too, and that cannot be undone.',
        'history.removedRecords': 'Removed {count} entries; the files on disk were kept',
        'history.removedWithFiles': 'Removed {count} entries and {files} files',
        'history.filesFailed': '{count} files could not be deleted: {reason}',

        'refs.add': 'Add reference',
        'refs.addMore': 'Add another',
        'refs.dropHint': 'or drop an image here (image-to-image)',
        'refs.label': 'Reference {index}',
        'refs.limit': 'Up to {limit}; {count} selected',
        'refs.unsupported': 'This model has no image-to-image mode, so it takes no reference images.',
        'refs.none': 'This model accepts no reference images (maxInputImages = 0).',
        'refs.full': 'This model already has its maximum of {limit} reference image(s).',

        'form.model': 'Model',
        'form.size': 'Size',
        'form.resolution': 'Resolution',
        'form.quality': 'Quality',
        'form.count': 'Count',
        'form.countMax': 'max {limit}',
        'form.prompt': 'Prompt',
        'form.promptPlaceholder': 'Describe the image you want…',
        'form.promptCount': '{used} / {limit} chars',
        'form.promptTooLong': 'The prompt exceeds this model’s limit ({limit} chars).',
        'form.customToggle': 'Custom size',
        'form.customWidth': 'W',
        'form.customHeight': 'H',
        'form.customReset': 'Back to preset sizes',
        'form.customNoPrice': 'A custom size has no catalog price — quote it to see the amount.',
        'form.budget': 'Per-call budget',
        'form.budgetHint': 'written in {currency}; at most {amount} (the configured ceiling)',
        'form.estimate': 'Estimate {total} ({unit} × {count}; the quote is what counts)',
        'form.quoteNote': 'Quote {amount} (per-call budget {budget} {currency}). Nothing is submitted until you confirm.',
        'form.quote': 'Quote',
        'form.quoteBusy': 'Quoting…',
        'form.generate': 'Generate',
        'form.confirmGenerate': 'Confirm',
        'form.generating': 'Generating… {seconds}s',
        'form.cancelWait': 'Stop waiting',
        'form.cancelled': 'Stopped waiting. The task may still be running and billed on the server — '
          + 'refresh the history for the final result.',
        'form.authHint': 'That looks like a key problem. Use “Change key” at the bottom of the window.',

        'info.title': 'Model info — {model}',
        'info.maxOutput': 'up to {count} image(s)',
        'info.maxInput': 'up to {count} reference image(s)',
        'info.maxPrompt': 'prompt limit {count} chars',
        'info.countUnit': 'priced per {unit}',
        'info.outputs': 'output formats {list}',
        'info.moderations': 'moderation {list}',
        'info.supports': 'supports {list}',
        'info.flagMask': 'mask',
        'info.flagBackground': 'background',
        'info.flagCustomSize': 'custom size',
        'info.params': 'Model parameters: {list}',
        'info.sizeLimits': 'Custom-size limits: {list} — confirm with a quote',
        'info.notes': 'Notes: {text}',
        'info.noLimit': 'the catalog declares no further limits',

        'sizeLimit.multipleOf': 'sides multiple of {n}',
        'sizeLimit.maxSide': 'longest side ≤ {n}',
        'sizeLimit.aspect': 'aspect ratio ≤ {n}',
        'sizeLimit.minPixels': 'pixels ≥ {n}',
        'sizeLimit.maxPixels': 'pixels ≤ {n}',
        'sizeError.positive': 'Width and height must be positive integers.',
        'sizeError.multipleOf': 'Width and height must both be multiples of {n}.',
        'sizeError.maxSide': 'The longest side cannot exceed {n}.',
        'sizeError.aspect': 'The aspect ratio cannot exceed {n}.',
        'sizeError.minPixels': 'Total pixels cannot be below {n}.',
        'sizeError.maxPixels': 'Total pixels cannot exceed {n}.',

        'send.button': 'Send to chat',
        'send.busy': 'Placing…',
        'send.done': 'Placed in the composer together with this prompt. Press Enter to send.',
        'send.noSession': 'No session is available, so it cannot be placed. The image path was copied instead.',
        'send.noService': 'The host exposes no conversation write path. The image path was copied instead.',
        'send.attachRefused': 'The composer is not accepting attachments right now. The image path was copied instead.',
        'send.failed': 'Could not place it: {reason}. The image path was copied instead.',
        'send.gateHint': 'If the routed model does not accept image input the send will be refused — '
          + 'switch to a vision-capable model.',

        'copy.button': 'Copy path',
        'copy.done': 'Image path copied.',
        'copy.failed': 'Copy failed; copy it manually: {path}',

        'window.loading': 'Loading…',
        'window.catalog': 'Reading the model catalog…',
        'window.noModels': 'This account has no usable image models.',
        'window.changeKey': 'Change key',
        'window.outputDir': 'Output {dir}',
      },
    }

    /** Language ids this plugin can render, in fallback order. */
    const LANGUAGE_IDS = ['zh', 'en']
    /** The language used when nothing better is known. */
    const DEFAULT_LANGUAGE = 'zh'

    /**
     * The active language, resolved once and then kept by the locale service.
     * `undefined` until something asks.
     */
    let activeLanguage

    /** Reduce a BCP 47 tag to one of the languages this file ships. */
    function normaliseLanguage(id) {
      if (typeof id !== 'string' || id.length === 0) return undefined
      const lower = id.toLowerCase()
      for (const candidate of LANGUAGE_IDS) {
        if (lower === candidate || lower.startsWith(`${candidate}-`)) return candidate
      }
      // `zh-hans`, `zh-tw`, … all reduce through the prefix check above; a tag
      // naming no language we ship is not a match.
      return lower.startsWith('zh') ? 'zh' : undefined
    }

    /** The browser's own preference, when the host has not stated one. */
    function detectLanguage() {
      try {
        if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
        const ids = Array.isArray(navigator.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language]
        for (const id of ids) {
          const normalised = normaliseLanguage(id)
          if (normalised !== undefined) return normalised
        }
      } catch {
        // A locked-down navigator is not a reason to fail a render.
      }
      return DEFAULT_LANGUAGE
    }

    /** The language to render in right now. */
    function language() {
      if (activeLanguage === undefined) activeLanguage = detectLanguage()
      return activeLanguage
    }

    /** Adopt a language, ignoring ids this file has no dictionary for. */
    function setLanguage(id) {
      const normalised = normaliseLanguage(id)
      if (normalised !== undefined) activeLanguage = normalised
    }

    /**
     * Translate one key, interpolating `{name}` placeholders.
     *
     * Reads the active language at call time, so a component that re-renders
     * after a switch renders in the new language without being re-registered.
     * An unknown key returns itself rather than an empty string: a missing
     * translation should be visible in a screenshot, not silently blank.
     *
     * @param key - dictionary key.
     * @param vars - placeholder values.
     * @returns the rendered string.
     */
    function t(key, vars) {
      const dict = MESSAGES[language()] ?? MESSAGES[DEFAULT_LANGUAGE]
      let template = dict[key]
      if (typeof template !== 'string') template = MESSAGES[DEFAULT_LANGUAGE][key]
      if (typeof template !== 'string') return key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (match, name) => (
        vars[name] === undefined || vars[name] === null ? match : String(vars[name])
      ))
    }

    /** Listeners wanting a repaint when the active language changes. */
    const languageListeners = new Set()

    /** @param listener - called on every language change. @returns the unsubscribe. */
    function subscribeLanguage(listener) {
      languageListeners.add(listener)
      return () => { languageListeners.delete(listener) }
    }

    /** Push a new language and ask every subscriber to repaint. */
    function publishLanguage(id) {
      const before = language()
      setLanguage(id)
      if (language() === before) return
      for (const listener of [...languageListeners]) {
        try {
          listener()
        } catch {
          // A subscriber throwing must not stop the others from repainting.
        }
      }
    }

    /**
     * Repaint this component when the active language changes.
     *
     * Returns the language it just painted with, but callers normally ignore it:
     * the point is the subscription, since {@link t} reads the language itself.
     */
    function useLanguage() {
      const [current, setCurrent] = React.useState(language())
      React.useEffect(() => {
        setCurrent(language())
        return subscribeLanguage(() => setCurrent(language()))
      }, [])
      return current
    }

    // #endregion

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
     * How many reference images a model accepts.
     *
     * Read from the model's own capability, because the live catalog varies a
     * lot (0, 1, 5, 9, 10, 15, 16) and one fixed number is wrong in both
     * directions: too permissive where the model takes none (the API rejects the
     * call), too strict where it takes fifteen.
     *
     * @param model - the catalog record.
     * @returns the ceiling; {@link REFERENCE_FALLBACK_LIMIT} when it is unstated.
     */
    function maxReferences(model) {
      const value = model?.capabilities?.maxInputImages
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
      return REFERENCE_FALLBACK_LIMIT
    }

    /**
     * Whether a model can take reference images at all.
     *
     * Both halves matter: a model may list `image-to-image` and still declare
     * `maxInputImages: 0`, and a model may declare room for images while its
     * `modes` never offers image-to-image (so the SKUs to quote with do not
     * exist). Either way the picker must not be offered.
     */
    function supportsReferences(model) {
      if (maxReferences(model) <= 0) return false
      const modes = Array.isArray(model?.modes) ? model.modes : []
      return modes.length === 0 || modes.includes(REFERENCE_MODE)
    }

    /**
     * The pixel constraints on a custom size, or `null` when unsupported.
     *
     * A model with `supportsCustomSize` but no `sizeLimits` gets `{}` — allowed,
     * with nothing to validate against — which is exactly what the live catalog
     * shows for the two Wan models.
     */
    function customSizeLimits(model) {
      if (model?.capabilities?.supportsCustomSize !== true) return null
      const limits = model.capabilities.sizeLimits
      return limits !== null && typeof limits === 'object' ? limits : {}
    }

    /** The `size` value a pair of pixel dimensions maps onto. */
    function customSizeValue(width, height) {
      return `${width}x${height}`
    }

    /**
     * Check a custom size against the model's declared limits.
     *
     * Returning the *reason* rather than a boolean is what lets the form say
     * which rule was broken; "invalid size" would send the user hunting.
     *
     * @param width - the width field's current value.
     * @param height - the height field's current value.
     * @param limits - `capabilities.sizeLimits`, or `{}` when unstated.
     * @returns `{ key, vars }` naming a message, or `null` when acceptable.
     */
    function validateCustomSize(width, height, limits = {}) {
      const w = Number(width)
      const h = Number(height)
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        return { key: 'sizeError.positive', vars: {} }
      }
      if (typeof limits.multipleOf === 'number' && limits.multipleOf > 0
        && (w % limits.multipleOf !== 0 || h % limits.multipleOf !== 0)) {
        return { key: 'sizeError.multipleOf', vars: { n: limits.multipleOf } }
      }
      if (typeof limits.maxSide === 'number' && Math.max(w, h) > limits.maxSide) {
        return { key: 'sizeError.maxSide', vars: { n: limits.maxSide } }
      }
      if (typeof limits.maxAspectRatio === 'number' && limits.maxAspectRatio > 0
        && Math.max(w / h, h / w) > limits.maxAspectRatio) {
        return { key: 'sizeError.aspect', vars: { n: limits.maxAspectRatio } }
      }
      const pixels = w * h
      if (typeof limits.minPixels === 'number' && pixels < limits.minPixels) {
        return { key: 'sizeError.minPixels', vars: { n: limits.minPixels } }
      }
      if (typeof limits.maxPixels === 'number' && pixels > limits.maxPixels) {
        return { key: 'sizeError.maxPixels', vars: { n: limits.maxPixels } }
      }
      return null
    }

    /**
     * The catalog's price for exactly this selection.
     *
     * The catalog carries `price` per SKU, so the form can show a figure before
     * any quote round-trip. It is an estimate: the quote is what gates the
     * budget, and the UI line says so. A custom size matches no SKU, which is
     * why it gets no estimate rather than a guess.
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

    /**
     * The model's prompt ceiling, when the catalog states one.
     * 13 of the 13 live models state one, so this is normally known.
     */
    function promptLimit(model) {
      const value = model?.capabilities?.maxPromptLength
      return typeof value === 'number' && value > 0 ? value : undefined
    }

    /** Which optional features the catalog advertises for one model. */
    function supportedFlags(model) {
      const capabilities = model?.capabilities ?? {}
      const flags = []
      if (capabilities.supportsMask === true) flags.push('info.flagMask')
      if (capabilities.supportsBackground === true) flags.push('info.flagBackground')
      if (capabilities.supportsCustomSize === true) flags.push('info.flagCustomSize')
      return flags
    }

    /** The custom-size constraints, rendered as message parts. */
    function sizeLimitParts(limits) {
      const parts = []
      if (typeof limits?.multipleOf === 'number' && limits.multipleOf > 0) {
        parts.push(t('sizeLimit.multipleOf', { n: limits.multipleOf }))
      }
      if (typeof limits?.maxSide === 'number') parts.push(t('sizeLimit.maxSide', { n: limits.maxSide }))
      if (typeof limits?.maxAspectRatio === 'number') parts.push(t('sizeLimit.aspect', { n: limits.maxAspectRatio }))
      if (typeof limits?.minPixels === 'number') parts.push(t('sizeLimit.minPixels', { n: limits.minPixels }))
      if (typeof limits?.maxPixels === 'number') parts.push(t('sizeLimit.maxPixels', { n: limits.maxPixels }))
      return parts
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

    // #region conversation hand-off

    /**
     * The session-scoped slot props this plugin uses, normalised.
     *
     * Every field is optional: the slot contract says a session-scoped entry gets
     * them, but a build that stops providing one must cost the button its
     * function, not the window its render.
     *
     * @param props - the props the slot handed the occupant.
     * @returns `{ sessionId, inputActions, useInput }`.
     */
    function sessionFaceFrom(props) {
      return {
        sessionId: typeof props?.sessionId === 'string' && props.sessionId.length > 0
          ? props.sessionId
          : undefined,
        inputActions: props?.inputActions,
        useInput: props?.useInput,
      }
    }

    /** A hook that reads no draft, used when the slot exposes no session. */
    function noInputHook() {
      return ''
    }

    /**
     * The conversation service, when this plugin's context can reach it.
     *
     * `conversation` is a root singleton, so it is reachable from the plugin's
     * own context even though the *methods* are scope-addressed. Only
     * `createDrafts` is used here, and it takes the session id explicitly — so
     * nothing depends on this file's context carrying a session tag.
     *
     * @returns the service, or `undefined`.
     */
    function conversationService() {
      try {
        if (hostContext === null || hostContext === undefined) return undefined
        if (typeof hostContext.get === 'function') return hostContext.get('conversation')
        return hostContext.conversation
      } catch {
        return undefined
      }
    }

    /** Copy text to the clipboard. Returns whether it worked. */
    async function copyText(text) {
      if (typeof text !== 'string' || text.length === 0) return false
      try {
        if (navigator?.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Falls through: a denied clipboard permission is a normal outcome.
      }
      return false
    }

    /**
     * Read an image off one of our own routes, or off a data URL, into a File.
     * @param url - the image source.
     * @param name - the file name to give it.
     * @returns the file, or `undefined` when it could not be read.
     */
    async function imageFileFrom(url, name) {
      try {
        const response = await fetch(url)
        if (response.ok !== true) return undefined
        const blob = await response.blob()
        if (blob.size === 0) return undefined
        return new File([blob], name, { type: blob.type || 'image/png' })
      } catch {
        return undefined
      }
    }

    /**
     * Put one generated image into the current session's composer.
     *
     * The chain is the composer's own: `createDrafts` turns browser `File`s into
     * draft attachments, `inputActions.addAttachments` registers them on *this*
     * session's input machine, and the prompt text is merged into the draft the
     * user already has. Nothing is submitted — the user reviews it and presses
     * Enter, which is what keeps a mis-click from spending money and from
     * clobbering a half-written message.
     *
     * The image is deliberately NOT sent through `session.prompt` directly: the
     * host gates image input on the routed model's `inputModalities` at submit
     * time, so going through the composer surfaces that refusal in the composer
     * the user is already looking at, instead of in a toast this plugin owns.
     *
     * @param options - the session face, the image source, its name, and the
     *   prompt text to place beside it.
     * @returns `{ ok: true }` or `{ ok: false, reason }`.
     */
    async function sendImageToComposer(options) {
      const { session, imageUrl, name, path, text, draft } = options
      const actions = session?.inputActions
      if (session?.sessionId === undefined || actions === undefined) return { ok: false, reason: 'no-session' }

      const conversation = conversationService()
      if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
        return { ok: false, reason: 'no-service' }
      }

      let drafts
      try {
        const file = await imageFileFrom(imageUrl, name)
        if (file === undefined) return { ok: false, reason: path === undefined ? 'no-bytes' : path }
        drafts = conversation.createDrafts(session.sessionId, [file])
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }

      const list = Array.isArray(drafts) ? drafts : []
      const ids = list.map((item) => item?.id).filter((id) => id !== undefined)
      if (ids.length === 0) return { ok: false, reason: 'draft-failed' }

      let accepted
      try {
        accepted = actions.addAttachments(ids)
      } catch {
        accepted = false
      }
      if (accepted === false) {
        // The registry refuses while the input machine is busy, and the ids stay
        // registered until released — so release them, or the next send would
        // find the composer carrying an attachment nothing refers to.
        try {
          conversation.releaseDraftAttachments?.(list)
        } catch {
          // Best-effort cleanup.
        }
        return { ok: false, reason: 'attach-refused' }
      }

      try {
        const existing = typeof draft === 'string' ? draft : ''
        const addition = typeof text === 'string' ? text.trim() : ''
        if (addition.length > 0) {
          const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
          actions.setDraft(`${existing}${separator}${addition}`)
        }
      } catch {
        // The attachment is already registered; losing the text is survivable.
      }
      return { ok: true }
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
        '.jws-button[data-tiny="true"]{font-size:11px;padding:2px 7px}',
        '.jws-link{appearance:none;background:none;border:0;color:inherit;cursor:pointer;font:inherit;font-size:12px;opacity:.65;padding:0;text-decoration:underline}',
        '.jws-link:hover{opacity:1}',
        '.jws-link:disabled{cursor:default;opacity:.4;text-decoration:none}',
        '.jws-link[data-danger="true"]{color:#d9534f;opacity:1}',
        '.jws-note{font-size:12px;line-height:1.5;opacity:.8}',
        '.jws-cost{border-left:3px solid #3fa66b;font-size:12px;line-height:1.6;padding:4px 8px}',
        '.jws-error{border-left:3px solid #d9534f;color:#d9534f;font-size:12px;line-height:1.5;padding:4px 8px;white-space:pre-wrap;word-break:break-word}',
        '.jws-ok{border-left:3px solid #3fa66b;font-size:12px;line-height:1.5;padding:4px 8px}',
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
        '.jws-drop[data-disabled="true"]{opacity:.5}',
        '.jws-estimate{font-size:12px;opacity:.85}',
        '.jws-info{border:1px solid rgba(128,128,128,.28);border-radius:8px;display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:1.6;opacity:.85;padding:6px 9px}',
        '.jws-info-title{font-weight:600;opacity:.75}',
        '.jws-onboarding{border:1px solid rgba(128,128,128,.28);border-radius:8px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.55;opacity:.85;padding:7px 10px}',
        '.jws-onboarding strong{font-size:12px}',
        '.jws-lightbox{align-items:center;background:rgba(0,0,0,.74);cursor:zoom-out;display:flex;inset:0;justify-content:center;padding:24px;position:fixed;z-index:2147483001}',
        '.jws-lightbox img{border-radius:8px;box-shadow:0 14px 48px rgba(0,0,0,.55);cursor:default;max-height:calc(100vh - 96px);max-width:calc(100vw - 48px)}',
        '.jws-lightbox-caption{bottom:14px;color:#fff;font-size:12px;left:0;line-height:1.6;opacity:.88;padding:0 28px;position:absolute;right:0;text-align:center;word-break:break-all}',
        '.jws-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.7;word-break:break-all;margin-top:4px}',
        '.jws-history{display:flex;flex-direction:column;gap:6px}',
        '.jws-history-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between}',
        '.jws-history-item{border:1px solid rgba(128,128,128,.3);border-radius:6px;display:flex;flex-direction:column;gap:3px;font-size:12px;padding:6px 8px}',
        '.jws-history-prompt{opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.jws-history-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.jws-check{align-items:center;cursor:pointer;display:flex;font-size:12px;gap:5px;opacity:.8}',
        '.jws-check:hover{opacity:1}',
        '.jws-check input{cursor:pointer;margin:0}',
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

    /** A labelled number input. */
    function NumberField(props) {
      const { label, value, onChange, disabled, min, max, step, hint, className } = props
      return h('label', { className: className ?? 'jws-field' },
        h('span', { className: 'jws-label' }, label),
        h('input', {
          className: 'jws-control',
          type: 'number',
          min: min === undefined ? undefined : String(min),
          max: max === undefined ? undefined : String(max),
          step: step === undefined ? undefined : String(step),
          value: value === undefined || value === null ? '' : String(value),
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }),
        hint === undefined ? null : h('span', { className: 'jws-hint' }, hint),
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
      useLanguage()
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
        h('div', { className: 'jws-note' }, t('key.note')),
        h('label', { className: 'jws-field' },
          h('span', { className: 'jws-label' }, t('key.label')),
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
          }, busy ? t('key.busy') : t('key.save')),
          onCancel === undefined
            ? null
            : h('button', { type: 'button', className: 'jws-button', disabled: busy, onClick: onCancel }, t('common.cancel')),
        ),
      )
    }

    /** The API contract status bar, with the snapshot refresh action. */
    function StatusBar(props) {
      const { status } = props
      useLanguage()
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
              busy ? t('status.refreshing') : t('status.update')))
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
      useLanguage()
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
        'aria-label': preview.title ?? t('lightbox.label'),
        onClick: onClose,
      },
      h('img', {
        src: preview.src,
        alt: preview.title ?? t('lightbox.alt'),
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
      useLanguage()
      if (result === null || result === undefined) return null
      const images = Array.isArray(result.images) ? result.images.length : 0
      return h('div', { className: 'jws-cost' },
        h('div', null, t('cost.generated', { count: images, cost: formatCost(result.amount, result.currency) })),
        h('div', { className: 'jws-path' },
          t('cost.model', { model: result.model ?? '—', params: JSON.stringify(result.params ?? {}) })),
        result.taskId === undefined ? null : h('div', { className: 'jws-path' }, t('cost.task', { task: result.taskId })),
      )
    }

    /**
     * The model's declared limits, shown so the form is not a guessing game.
     *
     * Renders nothing when the catalog said nothing: an empty box would imply a
     * model with no limits rather than a record without the field.
     */
    function ModelInfo(props) {
      const { model } = props
      useLanguage()
      if (model === null || model === undefined) return null
      const capabilities = model.capabilities ?? {}
      const items = []

      if (typeof capabilities.maxOutputImages === 'number') {
        items.push(t('info.maxOutput', { count: capabilities.maxOutputImages }))
      }
      if (typeof capabilities.maxInputImages === 'number') {
        items.push(t('info.maxInput', { count: capabilities.maxInputImages }))
      }
      if (typeof capabilities.maxPromptLength === 'number') {
        items.push(t('info.maxPrompt', { count: capabilities.maxPromptLength }))
      }
      if (typeof capabilities.countUnit === 'string' && capabilities.countUnit.length > 0) {
        items.push(t('info.countUnit', { unit: capabilities.countUnit }))
      }
      if (Array.isArray(capabilities.outputFormats) && capabilities.outputFormats.length > 0) {
        items.push(t('info.outputs', { list: capabilities.outputFormats.join(' / ') }))
      }
      if (Array.isArray(capabilities.moderations) && capabilities.moderations.length > 0) {
        items.push(t('info.moderations', { list: capabilities.moderations.join(' / ') }))
      }
      const flags = supportedFlags(model).map((key) => t(key))
      if (flags.length > 0) items.push(t('info.supports', { list: flags.join(' / ') }))

      if (items.length === 0) return null

      const parameters = Array.isArray(capabilities.parameters) ? capabilities.parameters : []
      const notes = Array.isArray(capabilities.notes) ? capabilities.notes.filter((note) => typeof note === 'string' && note.length > 0) : []
      const limits = customSizeLimits(model)
      const limitParts = limits === null ? [] : sizeLimitParts(limits)

      return h('div', { className: 'jws-info' },
        h('div', { className: 'jws-info-title' }, t('info.title', { model: model.name ?? model.id ?? '—' })),
        h('ul', { style: { margin: 0, paddingLeft: '16px' } },
          items.map((item, index) => h('li', { key: index }, item))),
        limitParts.length === 0
          ? null
          : h('div', null, t('info.sizeLimits', { list: limitParts.join('，') })),
        parameters.length === 0
          ? null
          : h('div', null, t('info.params', {
            list: parameters
              .map((parameter) => `${parameter?.name ?? '?'}${parameter?.description === undefined ? '' : `（${parameter.description}）`}`)
              .join('、'),
          })),
        notes.length === 0 ? null : h('div', null, t('info.notes', { text: notes.join(' ') })),
      )
    }

    /**
     * "Send into this conversation", with the fallback that always works.
     *
     * The button is never a dead end: when the session props or the conversation
     * service are missing, or the composer refuses the attachment, the image path
     * is copied instead and the reason is stated. See
     * {@link sendImageToComposer} for why the composer is the target rather than
     * `session.prompt` itself.
     */
    function SendToChat(props) {
      const { session, imageUrl, name, path, text, draft } = props
      useLanguage()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)

      async function copyPath() {
        const copied = await copyText(path)
        if (copied) setNotice(t('copy.done'))
        else setError(t('copy.failed', { path: path ?? name }))
      }

      async function send() {
        setBusy(true)
        setNotice(null)
        setError(null)
        const result = await sendImageToComposer({ session, imageUrl, name, path, text, draft })
        setBusy(false)
        if (result.ok) {
          setNotice(t('send.done'))
          return
        }
        // Every failure path lands here, and every one of them still hands the
        // user the path — the picture exists whether or not it can be pasted.
        const copied = await copyText(path)
        const reasonKey = result.reason === 'no-session'
          ? 'send.noSession'
          : result.reason === 'no-service'
            ? 'send.noService'
            : result.reason === 'attach-refused' ? 'send.attachRefused' : undefined
        if (reasonKey !== undefined) {
          setError(t(reasonKey))
        } else {
          setError(t('send.failed', { reason: result.reason ?? 'unknown' }))
        }
        if (!copied) setNotice(t('copy.failed', { path: path ?? name }))
      }

      return h('div', { className: 'jws-actions' },
        h('button', {
          type: 'button',
          className: 'jws-link',
          disabled: busy,
          title: t('send.gateHint'),
          onClick: send,
        }, busy ? t('send.busy') : t('send.button')),
        h('button', { type: 'button', className: 'jws-link', disabled: busy, onClick: copyPath }, t('copy.button')),
        notice === null ? null : h('span', { className: 'jws-hint' }, notice),
        error === null ? null : h('span', { className: 'jws-error', style: { border: 0, padding: 0 } }, error),
      )
    }

    /**
     * This process's finished generations, with thumbnails, a one-click
     * parameter refill, a per-entry delete and a clear-all action.
     *
     * Deletion has two modes, and the destructive one is opt-in per visit:
     * `withFiles` is a checkbox the caller owns, defaulting to off. When it is
     * on, *both* delete gestures need a second click — the list-only path keeps
     * its single click, because removing a row is recoverable (the file is
     * still there) and deleting a file is not.
     */
    function HistoryList(props) {
      const { entries, onRerun, onPreview, onDelete, onClear, session, useInput, withFiles, onFilesChange } = props
      useLanguage()
      const [confirmClear, setConfirmClear] = React.useState(false)
      // Which entry is armed for a second click. One at a time, so a second
      // entry cannot inherit the arming of the first.
      const [armed, setArmed] = React.useState(null)
      const draft = (useInput ?? noInputHook)((state) => state?.draft ?? '')
      if (!Array.isArray(entries) || entries.length === 0) return null

      /**
       * A row's key. Used as its identity, so arming one row cannot arm another
       * — an entry without a task id falls back to its position.
       */
      function keyOf(entry, index) {
        return String(entry.taskId ?? index)
      }

      /** Flip the mode, and drop any arming made under the old one. */
      function toggleFiles(checked) {
        setConfirmClear(false)
        setArmed(null)
        onFilesChange(checked)
      }

      return h('div', { className: 'jws-history' },
        h('div', { className: 'jws-actions' },
          h('span', { className: 'jws-label' }, t('history.title', { count: entries.length })),
          onFilesChange === undefined
            ? null
            : h('label', { className: 'jws-check', title: t('history.withFilesHint') },
              h('input', {
                type: 'checkbox',
                checked: withFiles === true,
                onChange: (event) => toggleFiles(event.target.checked),
              }),
              h('span', null, t('history.withFiles'))),
          onClear === undefined
            ? null
            : h('button', {
              type: 'button',
              className: 'jws-link',
              'data-danger': withFiles === true ? 'true' : 'false',
              onClick: () => {
                // Two clicks, because this one is destructive to the list and a
                // single stray click should not empty it.
                if (confirmClear) {
                  setConfirmClear(false)
                  onClear()
                  return
                }
                setConfirmClear(true)
              },
            }, confirmClear
              ? (withFiles === true ? t('history.clearConfirmFiles') : t('history.clearConfirm'))
              : t('history.clear')),
        ),
        withFiles === true
          ? h('div', { className: 'jws-hint' }, t('history.withFilesHint'))
          : null,
        entries.map((entry, index) => {
          const files = Array.isArray(entry.files) ? entry.files : []
          const key = keyOf(entry, index)
          const isArmed = armed === key
          return h('div', { key, className: 'jws-history-item' },
            h('div', { className: 'jws-history-head' },
              h('span', null, `${formatCost(entry.amount, entry.currency)} · ${entry.model ?? '—'}`),
              h('div', { className: 'jws-history-actions' },
                h('button', { type: 'button', className: 'jws-link', onClick: () => onRerun(entry) }, t('history.rerun')),
                onDelete === undefined
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'jws-link',
                    'data-danger': isArmed ? 'true' : 'false',
                    title: withFiles === true ? t('history.deleteHintFiles') : t('history.deleteHint'),
                    onClick: () => {
                      // Without the file mode this is recoverable, so it stays
                      // one click; with it, the image is gone for good.
                      if (withFiles !== true) {
                        onDelete(entry)
                        return
                      }
                      if (isArmed) {
                        setArmed(null)
                        onDelete(entry)
                        return
                      }
                      setArmed(key)
                    },
                  }, isArmed ? t('history.deleteConfirm') : t('common.delete')),
              ),
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
            files.length === 0
              ? null
              : h(SendToChat, {
                session,
                // A history image is only reachable through the host route; the
                // bytes are read on demand rather than all up front.
                imageUrl: historyImageUrl(entry.taskId, 0),
                name: baseName(files[0]) || 'jws-image.png',
                path: files[0],
                text: entry.prompt ?? '',
                draft,
              }),
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
      const { references, disabled, limit, enabled, refusal, onAdd, onRemove } = props
      useLanguage()
      const [dragging, setDragging] = React.useState(false)

      function onDrop(event) {
        event.preventDefault()
        setDragging(false)
        if (event.dataTransfer?.files !== undefined) onAdd(event.dataTransfer.files)
      }

      // The picker is not merely disabled for a model that takes no references:
      // a disabled control explains nothing, so the reason is stated instead.
      if (enabled === false) {
        return refusal === undefined
          ? null
          : h('div', { className: 'jws-refs' }, h('div', { className: 'jws-hint' }, refusal))
      }

      return h('div', { className: 'jws-refs' },
        references.length === 0
          ? null
          : h('div', { className: 'jws-thumbs' },
            references.map((reference, index) => h('span', { key: index, className: 'jws-ref' },
              h('img', {
                className: 'jws-thumb',
                src: `data:${reference.mimeType};base64,${reference.data}`,
                alt: reference.name ?? t('refs.label', { index: index + 1 }),
                title: reference.name ?? t('refs.label', { index: index + 1 }),
              }),
              h('button', { type: 'button', className: 'jws-link', disabled, onClick: () => onRemove(index) }, t('common.remove')),
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
            references.length > 0 ? t('refs.addMore') : t('refs.add'),
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
          references.length > 0 ? null : h('span', { className: 'jws-hint' }, t('refs.dropHint')),
          limit === undefined || limit <= 0
            ? null
            : h('span', { className: 'jws-hint' }, t('refs.limit', { limit, count: references.length })),
        ),
      )
    }

    /**
     * The first-run orientation, shown until the user has generated once.
     *
     * Three questions and no more: what this is, where the key comes from, and
     * how the money works — the last one including the currency mismatch, which
     * is the part nobody would guess.
     */
    function Onboarding(props) {
      const { maxAmount, budgetCurrency, onDismiss } = props
      useLanguage()
      return h('div', { className: 'jws-onboarding' },
        h('strong', null, t('onboarding.title')),
        h('div', null, t('onboarding.body')),
        h('div', null, t('onboarding.budget', { amount: maxAmount ?? '—', currency: budgetCurrency ?? 'CNY' })),
        budgetCurrency === undefined || budgetCurrency === 'USD'
          ? null
          : h('div', { className: 'jws-hint' }, t('onboarding.currency', { currency: budgetCurrency })),
        typeof onDismiss !== 'function'
          ? null
          : h('div', { className: 'jws-actions' },
            h('button', { type: 'button', className: 'jws-link', onClick: onDismiss }, t('onboarding.dismiss'))),
      )
    }

    /** The generation form, driven entirely by the live catalog. */
    function GenerateForm(props) {
      const { models, maxAmount, budgetCurrency, seed, session, onGenerated, onPreview } = props
      useLanguage()
      // The configured ceiling (`state.maxAmount`). The budget field may only
      // lower it: the host clamps to this same number, so offering a larger one
      // in the form would promise a budget the host refuses to honour.
      const ceiling = typeof maxAmount === 'number' && Number.isFinite(maxAmount) && maxAmount > 0
        ? maxAmount
        : undefined
      // One draft read for the whole form, at the top: the composer's draft is
      // what "送进对话" merges into, and a read inside the image loop would make
      // the hook count depend on how many images came back.
      const draft = sessionDraft(session)
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
      const [budget, setBudget] = React.useState(ceiling ?? 20)
      const [quote, setQuote] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [phase, setPhase] = React.useState('')
      const [elapsed, setElapsed] = React.useState(0)
      const [error, setError] = React.useState(null)
      const [references, setReferences] = React.useState([])
      // One controller per generation, so "取消" can stop the wait.
      const [controller, setController] = React.useState(null)

      // Custom pixel dimensions are a separate mode from the SKU-derived aspect
      // ratios, because they are priced by the API rather than by the catalog.
      const [customSize, setCustomSize] = React.useState(false)
      const [customWidth, setCustomWidth] = React.useState(1024)
      const [customHeight, setCustomHeight] = React.useState(1024)

      // A long generation gives no server-side progress, so at least show that
      // time is passing and how long it has been.
      React.useEffect(() => {
        if (!busy) return undefined
        const started = Date.now()
        setElapsed(0)
        const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(id)
      }, [busy])

      const limits = customSizeLimits(model)
      const sizeError = customSize ? validateCustomSize(customWidth, customHeight, limits ?? {}) : null
      const effectiveSize = customSize ? customSizeValue(customWidth, customHeight) : size

      /**
       * Re-seat every SKU field from the new model's own record.
       *
       * Carrying a size across models would quote a combination the API does
       * not sell. References are dropped when the new model cannot take them,
       * rather than left in place to be refused at the API.
       */
      function pickModel(nextId) {
        const next = options.find((item) => item.id === nextId)
        setModelId(nextId)
        const sku = defaultSku(next, MODE)
        setSize(sku?.size)
        setResolution(sku?.resolution)
        setQuality(sku?.quality)
        setCount((current) => Math.min(current, maxCount(next)))
        setCustomSize(false)
        if (!supportsReferences(next)) setReferences([])
        setQuote(null)
        setError(null)
      }

      function selection() {
        return { size: effectiveSize, resolution, quality, count }
      }

      // Reference images switch the call to image-to-image, whose SKUs differ.
      const mode = references.length > 0 ? REFERENCE_MODE : MODE
      const estimate = estimateForSelection(skusForMode(model, mode), selection())
      const referenceLimit = maxReferences(model)
      const referencesEnabled = supportsReferences(model)
      const promptCeiling = promptLimit(model)
      const promptTooLong = promptCeiling !== undefined && prompt.length > promptCeiling

      /** Read local image files into base64 records the host can upload. */
      function addReferences(files) {
        if (!referencesEnabled) return
        const room = referenceLimit - references.length
        if (room <= 0) return
        const list = Array.from(files ?? [])
          .filter((file) => typeof file?.type === 'string' && file.type.startsWith('image/'))
          .slice(0, room)
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
        setPhase('quote')
        setError(null)
        const response = await call('/quote', {
          method: 'POST',
          body: {
            prompt,
            model: modelId,
            params: paramsFromSelection(selection()),
            maxAmount: Number(budget),
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
        setPhase('generate')
        setError(null)
        const response = await call('/generate', {
          method: 'POST',
          signal: current.signal,
          body: {
            prompt,
            model: modelId,
            params: paramsFromSelection(selection()),
            maxAmount: Number(budget),
            ...(references.length === 0 ? {} : { references }),
          },
        })
        setBusy(false)
        setPhase('')
        setController(null)
        if (response.cancelled === true) {
          // The host finishes the task it already submitted, and the account is
          // still billed for it: cancelling stops the wait, not the charge.
          setError(t('form.cancelled'))
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

      const ready = prompt.trim().length > 0 && !busy && sizeError === null && !promptTooLong

      return h('div', { className: 'jws-body' },
        h('div', { className: 'jws-row' },
          h('label', { className: 'jws-field jws-field-wide' },
            h('span', { className: 'jws-label' }, t('form.model')),
            h('select', {
              className: 'jws-control',
              value: modelId ?? '',
              disabled: busy,
              onChange: (event) => pickModel(event.target.value),
            }, options.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id))),
          ),
        ),
        h(ModelInfo, { model }),
        h('div', { className: 'jws-row' },
          h(SelectField, { label: t('form.size'), value: size, values: optionValues(skus, 'size'), onChange: setSize, disabled: busy || customSize }),
          h(SelectField, { label: t('form.resolution'), value: resolution, values: optionValues(skus, 'resolution'), onChange: setResolution, disabled: busy }),
          h(SelectField, { label: t('form.quality'), value: quality, values: optionValues(skus, 'quality'), onChange: setQuality, disabled: busy }),
          NumberField({
            label: t('form.count'),
            value: count,
            min: 1,
            max: limit,
            hint: t('form.countMax', { limit }),
            disabled: busy,
            className: 'jws-field jws-field-narrow',
            onChange: (value) => setCount(Math.max(1, Math.min(limit, Number(value) || 1))),
          }),
        ),
        limits === null
          ? null
          : h('div', { className: 'jws-row' },
            h('div', { className: 'jws-field' },
              h('span', { className: 'jws-label' }, t('form.customToggle')),
              h('div', { className: 'jws-actions' },
                h('input', {
                  type: 'checkbox',
                  checked: customSize,
                  disabled: busy,
                  onChange: (event) => { setCustomSize(event.target.checked); setQuote(null) },
                }),
                h('span', { className: 'jws-hint' },
                  sizeLimitParts(limits).join('，') || t('info.noLimit')),
              ),
            ),
            customSize
              ? h(NumberField, {
                label: t('form.customWidth'),
                value: customWidth,
                min: 1,
                step: 1,
                className: 'jws-field jws-field-narrow',
                disabled: busy,
                onChange: setCustomWidth,
              })
              : null,
            customSize
              ? h(NumberField, {
                label: t('form.customHeight'),
                value: customHeight,
                min: 1,
                step: 1,
                className: 'jws-field jws-field-narrow',
                disabled: busy,
                onChange: setCustomHeight,
              })
              : null,
            customSize
              ? h('button', {
                type: 'button',
                className: 'jws-link',
                disabled: busy,
                onClick: () => { setCustomSize(false); setQuote(null) },
              }, t('form.customReset'))
              : null,
          ),
        sizeError === null ? null : h('div', { className: 'jws-error' }, t(sizeError.key, sizeError.vars)),
        h('div', { className: 'jws-row' },
          NumberField({
            label: t('form.budget'),
            value: budget,
            // 1, not 0: the host treats a non-positive cap as "unset" and falls
            // back to the configured ceiling, so 0 would silently mean 20.
            min: 1,
            // The ceiling is the operator's, and the host clamps to it anyway;
            // capping the input here means the field cannot promise a budget the
            // host will refuse to honour.
            ...(ceiling === undefined ? {} : { max: ceiling }),
            step: 1,
            hint: t('form.budgetHint', { currency: budgetCurrency ?? 'CNY', amount: ceiling ?? '—' }),
            disabled: busy,
            className: 'jws-field jws-field-narrow',
            onChange: (value) => setBudget(Math.min(Math.max(1, Number(value) || 1), ceiling ?? Number.MAX_SAFE_INTEGER)),
          }),
        ),
        h('label', { className: 'jws-field' },
          h('span', { className: 'jws-label' }, t('form.prompt')),
          h('textarea', {
            className: 'jws-control jws-textarea',
            value: prompt,
            disabled: busy,
            placeholder: t('form.promptPlaceholder'),
            ...(promptCeiling === undefined ? {} : { maxLength: String(promptCeiling) }),
            onChange: (event) => { setPrompt(event.target.value); setQuote(null) },
          }),
          promptCeiling === undefined
            ? null
            : h('span', { className: 'jws-hint' }, t('form.promptCount', { used: prompt.length, limit: promptCeiling })),
        ),
        promptTooLong ? h('div', { className: 'jws-error' }, t('form.promptTooLong', { limit: promptCeiling })) : null,
        h(ReferencePicker, {
          references,
          disabled: busy,
          limit: referenceLimit,
          enabled: referencesEnabled,
          refusal: referenceLimit === 0 ? t('refs.none') : t('refs.unsupported'),
          onAdd: addReferences,
          onRemove: removeReference,
        }),
        error === null ? null : h('div', { className: 'jws-error' }, error),
        error !== null && looksLikeAuthFailure(error)
          ? h('div', { className: 'jws-actions' }, h('span', { className: 'jws-hint' }, t('form.authHint')))
          : null,
        customSize && estimate === null
          ? h('div', { className: 'jws-estimate' }, t('form.customNoPrice'))
          : null,
        estimate === null
          ? null
          : h('div', { className: 'jws-estimate' },
            t('form.estimate', {
              total: formatCost(estimate.price * estimate.count, estimate.currency),
              unit: formatCost(estimate.price, estimate.currency),
              count: estimate.count,
            })),
        quote === null ? null : h('div', { className: 'jws-note' },
          t('form.quoteNote', {
            amount: formatCost(quote.amount, quote.currency),
            budget: quote.maxAmount ?? budget,
            currency: quote.budgetCurrency ?? budgetCurrency ?? 'CNY',
          })),
        h('div', { className: 'jws-actions' },
          h('button', { type: 'button', className: 'jws-button', disabled: !ready, onClick: askQuote },
            busy && phase === 'quote' ? t('form.quoteBusy') : t('form.quote')),
          h('button', {
            type: 'button',
            className: 'jws-button',
            'data-primary': 'true',
            disabled: !ready,
            onClick: generate,
          }, busy && phase === 'generate'
            ? t('form.generating', { seconds: elapsed })
            : (quote === null ? t('form.generate') : t('form.confirmGenerate'))),
          busy && phase === 'generate'
            ? h('button', { type: 'button', className: 'jws-button', onClick: cancel }, t('form.cancelWait'))
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
                url === null
                  ? null
                  : h(SendToChat, {
                    session,
                    imageUrl: url,
                    name: baseName(image.path) || 'jws-image.png',
                    path: image.path,
                    text: prompt,
                    draft,
                  }),
              )
            }),
          ),
      )
    }

    /** The composer's current draft, read through the session's own hook. */
    function sessionDraft(session) {
      try {
        const hook = session?.useInput
        if (typeof hook !== 'function') return ''
        const value = hook((state) => state?.draft ?? '')
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    }

    /** The window body: key setup first, then the generation form. */
    function WindowBody(props) {
      const { state, onReload, session } = props
      useLanguage()
      const [models, setModels] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [seed, setSeed] = React.useState(null)
      const [historyError, setHistoryError] = React.useState(null)
      const [historyNotice, setHistoryNotice] = React.useState(null)
      // Off on every mount. Deleting the bytes is a deliberate act, so it must
      // be re-chosen rather than inherited from the last time the window opened.
      const [withFiles, setWithFiles] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      const [changingKey, setChangingKey] = React.useState(false)
      // The orientation block is not modal and not dismissible state: it simply
      // stops being rendered once the user has seen it do something.
      const [sawStart, setSawStart] = React.useState(false)
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

      /**
       * Apply one history deletion and take the host's own answer as truth.
       *
       * The route returns the surviving list, so the window never has to guess
       * what a concurrent write did. It also returns how many files it deleted
       * and which ones it could not, and both are reported: a file the user
       * asked to delete and did not get deleted is exactly the thing they would
       * never find out about otherwise.
       */
      async function deleteHistory(body) {
        setHistoryError(null)
        setHistoryNotice(null)
        const result = await call('/history-delete', {
          method: 'POST',
          body: { ...body, deleteFiles: withFiles === true },
        })
        if (!result.ok) {
          setHistoryError(describeError(result.body))
          return
        }
        setHistory(result.body.entries ?? [])
        const removed = result.body.removed ?? 0
        const files = withFiles === true ? (result.body.deletedFiles ?? 0) : 0
        setHistoryNotice(files > 0
          ? t('history.removedWithFiles', { count: removed, files })
          : t('history.removedRecords', { count: removed }))
        const failed = Array.isArray(result.body.failedFiles) ? result.body.failedFiles : []
        if (failed.length > 0) {
          const first = failed[0]
          setHistoryError(t('history.filesFailed', {
            count: failed.length,
            reason: `${baseName(first?.path) || first?.path || '?'}：${first?.error ?? '—'}`,
          }))
        }
      }

      if (state === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, t('window.loading')))
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
            h('button', { type: 'button', className: 'jws-button', onClick: () => setChangingKey(true) }, t('window.changeKey'))),
        )
      }
      if (models === null) return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, t('window.catalog')))
      if (models.length === 0) {
        return h('div', { className: 'jws-body' }, h('div', { className: 'jws-note' }, t('window.noModels')))
      }

      return h(React.Fragment, null,
        sawStart || history.length > 0
          ? null
          : h(Onboarding, {
            maxAmount: state.maxAmount,
            budgetCurrency: state.budgetCurrency,
            onDismiss: () => setSawStart(true),
          }),
        h(GenerateForm, {
          key: nonce,
          models,
          maxAmount: state.maxAmount,
          budgetCurrency: state.budgetCurrency,
          seed,
          session,
          onGenerated: () => { refreshHistory(); if (!sawStart) setSawStart(true) },
          onPreview: setPreview,
        }),
        historyError === null ? null : h('div', { className: 'jws-error' }, historyError),
        historyNotice === null ? null : h('div', { className: 'jws-ok' }, historyNotice),
        h(HistoryList, {
          entries: history,
          session,
          withFiles,
          onFilesChange: setWithFiles,
          onPreview: setPreview,
          onDelete: (entry) => deleteHistory({ taskId: entry.taskId }),
          onClear: () => deleteHistory({ all: true }),
          onRerun: (entry) => {
            setSeed({ model: entry.model, params: entry.params, prompt: entry.prompt })
            setNonce((value) => value + 1)
          },
        }),
        h('div', { className: 'jws-actions' },
          h('button', { type: 'button', className: 'jws-link', onClick: () => setChangingKey(true) }, t('window.changeKey')),
          h('span', { className: 'jws-hint' }, t('window.outputDir', { dir: state.outputDir ?? '—' })),
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
    function SidebarPanel(props) {
      useLanguage()
      const [state, setState] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const session = sessionFaceFrom(props)

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
        h(WindowBody, { state, onReload: load, session }),
      )
    }

    /** The tab chip's text, shown in the sidebar's tab strip. */
    function SidebarTitle() {
      useLanguage()
      return h('span', { className: 'jws-tab-title' }, t('app.title'))
    }

    /** The fallback overlay, used when the native Modal is unavailable. */
    function FallbackModal(props) {
      const { title, onClose, children } = props
      useLanguage()
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
        h('button', { type: 'button', className: 'jws-button', onClick: onClose }, t('common.close')),
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
    function JwsImageEntry(props) {
      useLanguage()
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const session = sessionFaceFrom(props)

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
          title: t('entry.title'),
          onClick: openWindow,
        }, needsKey ? t('entry.needsKey') : t('entry.title')),
        h(Window, { open, onClose: () => setOpen(false), title: t('app.title') },
          h(StatusBar, { status }),
          h(WindowBody, { state, onReload: reload, session }),
        ),
      )
    }

    // #endregion

    /**
     * Follow the platform's locale service, when this build has one.
     *
     * `locale` is deliberately NOT in this plugin's `inject` list: adding it
     * would gate the whole browser half on a service that is not part of the
     * slot contract, and a build without it must keep rendering (in the language
     * detected from the browser). Registering the dictionaries too means the
     * platform's own translation lookup can resolve our keys if anything ever
     * asks for them; a refusal from the registry is ignored, since the window
     * reads its own table either way.
     *
     * @param ctx - the cordis client context.
     */
    function followLocale(ctx) {
      try {
        if (typeof ctx?.inject !== 'function') return
        ctx.inject(['locale'], (scope) => {
          try {
            const locale = scope?.locale
            if (locale === undefined) return
            for (const id of LANGUAGE_IDS) {
              try {
                scope.effect(() => locale.register(I18N_NS, id, MESSAGES[id]), `jws-image: ${id} dictionary`)
              } catch {
                // A namespace already taken is not a reason to lose the switch.
              }
            }
            publishLanguage(locale.getLocale?.()?.active)
            scope.effect(() => {
              const off = locale.subscribe?.(() => publishLanguage(locale.getLocale?.()?.active))
              return () => { if (typeof off === 'function') off() }
            }, 'jws-image: locale follow')
          } catch {
            // Any failure here costs live language switching, never the render.
          }
        })
      } catch {
        // Same: the browser-detected language stays in force.
      }
    }

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
      hostContext = ctx ?? null
      followLocale(ctx)
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
              { name: slot, id: ENTRY_ID, order: ENTRY_ORDER, label: t('app.title') },
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
              // Thunks, so the chip and the guide follow a language switch
              // without the tab type being re-registered.
              title: () => t('app.title'),
              guide: [{
                order: 20,
                title: () => t('app.title'),
                description: () => t('app.guide'),
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
    exports.MESSAGES = MESSAGES
    exports.ModelInfo = ModelInfo
    exports.Onboarding = Onboarding
    exports.ReferencePicker = ReferencePicker
    exports.SIDEBAR_ID = SIDEBAR_ID
    exports.SIDEBAR_KIND = SIDEBAR_KIND
    exports.SendToChat = SendToChat
    exports.SidebarPanel = SidebarPanel
    exports.SidebarTitle = SidebarTitle
    exports.StatusBar = StatusBar
    exports.WindowBody = WindowBody
    exports.copyText = copyText
    exports.customSizeLimits = customSizeLimits
    exports.customSizeValue = customSizeValue
    exports.defaultSku = defaultSku
    exports.baseName = baseName
    exports.describeError = describeError
    exports.estimateForSelection = estimateForSelection
    exports.formatCost = formatCost
    exports.historyImageUrl = historyImageUrl
    exports.imageDataUrl = imageDataUrl
    exports.isUsableModel = isUsableModel
    exports.language = language
    exports.looksLikeAuthFailure = looksLikeAuthFailure
    exports.maxCount = maxCount
    exports.maxReferences = maxReferences
    exports.optionValues = optionValues
    exports.paramsFromSelection = paramsFromSelection
    exports.promptLimit = promptLimit
    exports.sendImageToComposer = sendImageToComposer
    exports.sessionFaceFrom = sessionFaceFrom
    exports.setLanguage = setLanguage
    exports.sizeLimitParts = sizeLimitParts
    exports.skusForMode = skusForMode
    exports.supportedFlags = supportedFlags
    exports.supportsReferences = supportsReferences
    exports.t = t
    exports.validateCustomSize = validateCustomSize
    return module.exports
  },
})
