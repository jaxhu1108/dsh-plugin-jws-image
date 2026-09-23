/**
 * Browser-facing routes under `/api/jws-image/*`.
 *
 * The browser half never holds the API key: it asks these routes, which run in
 * the host process where the key lives. Everything is mounted under one unusual
 * prefix because `/api` is a shared namespace with no isolation and no way to
 * pre-check a conflict.
 *
 * The handlers are built by {@link createRouteHandlers} from injected
 * dependencies, so every branch is testable without a live gateway; the plugin
 * only wires the result into `ctx.connection.fetch`.
 *
 * @module dsh-plugin-jws-image/routes
 */

import { readFile, rmdir, unlink } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'

/** Every route lives below this prefix. */
const ROUTE_PREFIX = '/api/jws-image'
/** How many finished generations the history keeps. */
const HISTORY_LIMIT = 20
/**
 * Transport ceiling on reference images.
 *
 * Mirrors the `referenceCount` maximum in the live generation schema: entries
 * past it would be discarded by the API regardless, so reading more than this
 * off the wire only wastes memory.
 */
const REFERENCE_TRANSPORT_LIMIT = 16
/** Content type per file extension, for the image-serving route. */
const MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

/**
 * A JSON response that must never be cached.
 * @param body - the JSON-serializable body.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * A failed response with a readable reason.
 * @param status - the HTTP status.
 * @param message - the reason shown to the user.
 * @returns the response.
 */
function fail(status, message) {
  return json({ ok: false, error: message }, status)
}

/**
 * Remove anything key-shaped from text that is about to leave the host.
 *
 * A JWS error message can quote the credential back, and the browser must never
 * receive it.
 *
 * @param text - the message to sanitize.
 * @param secret - the key to redact.
 * @returns the message with the key replaced.
 */
function redact(text, secret) {
  const message = typeof text === 'string' ? text : '接口暂不可用'
  if (typeof secret !== 'string' || secret.length === 0) return message
  return message.replaceAll(secret, '[已隐藏]')
}

/**
 * Read a JSON request body, tolerating an empty or malformed one.
 * @param request - the incoming request.
 * @returns the parsed object, or an empty object.
 */
async function readJsonBody(request) {
  try {
    const value = await request.json()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Normalize one catalog model for the browser.
 *
 * Only what the form needs crosses the wire; the raw record can be large and
 * carries pricing internals the UI has no use for.
 *
 * @param model - one catalog record.
 * @returns the trimmed record.
 */
function publicModel(model) {
  return {
    id: model?.id,
    name: model?.name ?? model?.id,
    type: model?.type,
    modes: Array.isArray(model?.modes) ? model.modes : [],
    pricingMode: model?.pricingMode,
    capabilities: model?.capabilities ?? {},
    skus: Array.isArray(model?.skus)
      ? model.skus.map((sku) => ({
        mode: sku?.mode,
        size: sku?.size,
        resolution: sku?.resolution,
        quality: sku?.quality,
        unit: sku?.unit,
        price: sku?.price,
        currency: sku?.currency,
        estimatedPrice: sku?.estimatedPrice,
      }))
      : [],
  }
}

/**
 * Read a JSON value as a finite positive number, or the fallback.
 *
 * An absent or nonsensical value must fall back to the configured ceiling
 * rather than disabling the circuit breaker.
 *
 * @param value - the candidate value.
 * @param fallback - what to use when the value is unusable.
 * @returns a positive finite number.
 */
function readPositiveNumber(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * The budget one call actually runs under.
 *
 * The window's budget field is a *tighter cap*, not a replacement: it lets the
 * user spend 5 of a configured 20 on a single image. It must never raise the
 * configured ceiling — these routes are reachable from the page, so accepting a
 * looser number would turn the operator's circuit breaker in `settings.yaml`
 * into a suggestion that any script can talk its way past.
 *
 * @param value - the per-call request from the window.
 * @param ceiling - the configured ceiling (`spec.maxAmount`).
 * @returns the acting budget: the smaller of the two, or whichever is present.
 */
function effectiveMaxAmount(value, ceiling) {
  const cap = readPositiveNumber(ceiling, undefined)
  const asked = readPositiveNumber(value, cap)
  if (cap === undefined) return asked
  return asked === undefined ? cap : Math.min(asked, cap)
}

/**
 * Whether a path resolves to something *inside* a directory, never the directory
 * itself.
 *
 * Two callers depend on this, for opposite reasons. The image route uses it so a
 * corrupt history record cannot serve a file from anywhere else on the machine;
 * the deletion path uses it so the same corrupt record cannot *delete* one. That
 * is why the directory itself is excluded: `rmdir(outputDir)` would take the
 * whole output tree with it, and nothing this plugin does should be able to
 * remove the directory it was told to write into.
 *
 * @param root - the directory that acts as the boundary.
 * @param target - the candidate path.
 * @returns `true` only for a strict descendant of `root`.
 */
function insideDirectory(root, target) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (typeof target !== 'string' || target.length === 0) return false
  const base = resolve(root)
  const full = resolve(target)
  if (full === base) return false
  const prefix = base.endsWith(sep) ? base : base + sep
  return full.startsWith(prefix)
}

/**
 * The ceiling a model advertises on reference images, when it advertises one.
 *
 * `maxInputImages` is per model and varies a lot in the live catalog (0, 1, 5,
 * 9, 10, 15, 16), so a single fixed limit is wrong in both directions: too
 * permissive for the models that take none, too strict for the ones that take
 * fifteen.
 *
 * @param chosen - the resolved model record.
 * @returns the ceiling, or `undefined` when the catalog did not say.
 */
function referenceLimit(chosen) {
  const value = chosen?.capabilities?.maxInputImages
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Why the chosen model cannot take this many reference images, if it cannot.
 *
 * Both checks are skipped when the catalog record did not carry the field: an
 * unknown capability must not turn into a refusal, or a model the API would
 * happily accept an image for becomes unusable because a proxy trimmed the
 * record.
 *
 * @param chosen - the resolved model record.
 * @param count - how many reference images the call carries.
 * @returns a message to refuse with, or `undefined` to proceed.
 */
function refusalForReferences(chosen, count) {
  if (count === 0) return undefined
  const name = chosen?.model ?? chosen?.id ?? '该模型'
  const modes = Array.isArray(chosen?.modes) ? chosen.modes : []
  if (modes.length > 0 && !modes.includes('image-to-image')) {
    return `模型 ${name} 不支持图生图，无法使用参考图。`
  }
  const limit = referenceLimit(chosen)
  if (limit !== undefined && count > limit) {
    return limit === 0
      ? `模型 ${name} 不接受参考图（maxInputImages=0）。`
      : `模型 ${name} 最多接受 ${limit} 张参考图，收到 ${count} 张。`
  }
  return undefined
}

/**
 * Normalize the reference images a browser uploads.
 *
 * The browser sends `references: [{ mimeType, data: <base64>, name? }]`; the
 * host converts them to the byte payloads {@link runGeneration} feeds to the
 * inputs upload. The count decides the mode and `referenceCount`, which is why
 * both halves of the returned pair matter.
 *
 * The `limit` here is only a transport guard — the schema caps `referenceCount`
 * at 16, and everything past that would be thrown away by the API anyway. The
 * per-model ceiling is a separate, *rejecting* check
 * ({@link refusalForReferences}), because silently dropping the images a user
 * attached would charge them for a picture they did not ask for.
 *
 * @param body - the parsed request body.
 * @param limit - how many entries to keep at most.
 * @returns `{ references, referenceFiles }`, each at most `limit` entries.
 */
function referencesFromBody(body, limit = REFERENCE_TRANSPORT_LIMIT) {
  const raw = Array.isArray(body?.references) ? body.references : []
  const references = []
  const referenceFiles = []
  for (const item of raw) {
    if (referenceFiles.length >= limit) break
    if (item === null || typeof item !== 'object') continue
    if (typeof item.data !== 'string' || item.data.length === 0) continue
    let bytes
    try {
      bytes = new Uint8Array(Buffer.from(item.data, 'base64'))
    } catch {
      continue
    }
    if (bytes.length === 0) continue
    const mimeType = typeof item.mimeType === 'string' && /^image\//u.test(item.mimeType)
      ? item.mimeType
      : 'image/png'
    references.push({ mimeType, name: typeof item.name === 'string' ? item.name : undefined })
    referenceFiles.push({ bytes, mimeType })
  }
  return { references, referenceFiles }
}

/**
 * Build every route handler from injected dependencies.
 *
 * @param deps - config, credential access, the client factory, the generation
 *   flow, the contract checker, and the shared history.
 * @returns handlers keyed by route name.
 */
function createRouteHandlers(deps) {
  const {
    spec,
    readApiKey,
    writeApiKey,
    isValidKey,
    createClient,
    runGeneration,
    resolveModelAndParams,
    checkApiStatus,
    readSnapshot,
    writeSnapshot,
    readApiCache,
    writeApiCache,
    writeFileAtomic,
    history,
    historyReady = Promise.resolve(),
    persistHistory,
    readImageFile = readFile,
    deleteFile = unlink,
    removeEmptyDir = rmdir,
    fetchImpl = fetch,
  } = deps

  /** Resolve the key or fail the request with a message the UI can act on. */
  async function requireKey() {
    const key = await readApiKey()
    if (key === undefined) return { key: undefined, response: fail(409, '未配置 JWS 密钥，请先在生图窗口里设置。') }
    return { key, response: undefined }
  }

  /**
   * Delete the image files one history entry recorded.
   *
   * Best-effort per file, and never throws: a file that is already gone, or
   * locked by another process, is *reported* rather than aborting the run — the
   * record still has to go, or the window keeps listing a task the user asked to
   * forget and the only retry path is the button they just pressed.
   *
   * Every path is re-checked against the output directory first. The paths come
   * from the server's own history file, but that file is plain JSON on disk: a
   * hand-edited or corrupt record must not be able to turn "delete this task's
   * images" into deleting something else.
   *
   * @param entry - one history record.
   * @returns `{ deleted, failed }` — paths, with a reason per failure.
   */
  async function deleteEntryFiles(entry) {
    const deleted = []
    const failed = []
    const directories = new Set()
    const files = Array.isArray(entry?.files) ? entry.files : []
    for (const path of files) {
      if (typeof path !== 'string' || path.length === 0) continue
      if (!insideDirectory(spec.outputDir, path)) {
        failed.push({ path, error: '不在输出目录里，已跳过' })
        continue
      }
      const target = resolve(path)
      try {
        await deleteFile(target)
        deleted.push(path)
        directories.add(dirname(target))
      } catch (error) {
        // Already missing is the outcome the caller wanted, not a failure.
        if (error?.code === 'ENOENT') {
          deleted.push(path)
          directories.add(dirname(target))
          continue
        }
        failed.push({ path, error: error instanceof Error ? error.message : String(error) })
      }
    }

    // Each task owns one directory, which is empty now. `rmdir` refuses a
    // non-empty directory, so this can never take anything with it — the worst
    // case is a NoSuchFile/ENOTEMPTY that is not worth reporting.
    for (const directory of directories) {
      if (!insideDirectory(spec.outputDir, directory)) continue
      try {
        await removeEmptyDir(directory)
      } catch {
        // Not empty (another task's file landed there), already gone, or the
        // filesystem said no. None of those is worth failing the deletion for.
      }
    }
    return { deleted, failed }
  }

  return {
    /** Whether a key is configured, plus the budget the tool enforces. */
    async state() {
      const key = await readApiKey()
      return json({
        ok: true,
        hasKey: key !== undefined,
        defaultModel: spec.defaultModel ?? null,
        maxAmount: spec.maxAmount,
        budgetCurrency: deps.budgetCurrency,
        outputDir: spec.outputDir,
        pending: history.filter((entry) => entry.status === 'running').length,
      })
    },

    /**
     * Store a key, but only after the API accepts it.
     *
     * Verifying before writing means a typo is reported instead of being
     * persisted and then failing on every later call.
     */
    async key(request) {
      const body = await readJsonBody(request)
      const candidate = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (!isValidKey(candidate)) {
        return fail(400, '密钥格式不对：生图站创建的密钥以 jws_live_ 开头。')
      }
      try {
        const models = await createClient(candidate).catalog()
        await writeApiKey(spec.credentialsDir, candidate)
        return json({ ok: true, modelCount: Array.isArray(models) ? models.length : 0 })
      } catch (error) {
        return fail(401, redact(error instanceof Error ? error.message : String(error), candidate))
      }
    },

    /** Proxy the model catalog, minus the pricing internals. */
    async catalog() {
      const { key, response } = await requireKey()
      if (response !== undefined) return response
      try {
        const models = await createClient(key).catalog()
        return json({ ok: true, models: (Array.isArray(models) ? models : []).map(publicModel) })
      } catch (error) {
        return fail(502, redact(error instanceof Error ? error.message : String(error), key))
      }
    },

    /** Price one request without spending anything. */
    async quote(request) {
      const { key, response } = await requireKey()
      if (response !== undefined) return response
      const body = await readJsonBody(request)
      if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
        return fail(400, '请先填写提示词。')
      }
      // A per-call cap from the window, clamped to the configured ceiling.
      const maxAmount = effectiveMaxAmount(body.maxAmount, spec.maxAmount)
      const { references } = referencesFromBody(body)
      const mode = references.length > 0 ? 'image-to-image' : 'text-to-image'
      try {
        const client = createClient(key)
        const chosen = await resolveModelAndParams({
          client,
          args: { model: body.model, params: body.params },
          spec,
          mode,
        })
        const refusal = refusalForReferences(chosen, references.length)
        if (refusal !== undefined) return fail(400, refusal)
        const quote = await client.quote({
          type: 'image',
          model: chosen.model,
          params: { mode, referenceCount: references.length, ...chosen.params },
        })
        return json({
          ok: true,
          model: chosen.model,
          params: chosen.params,
          quoteId: quote.quoteId,
          amount: quote.amount,
          currency: quote.currency,
          expiresAt: quote.expiresAt,
          maxAmount,
          budgetCurrency: deps.budgetCurrency,
          referenceLimit: referenceLimit(chosen) ?? null,
        })
      } catch (error) {
        return fail(502, redact(error instanceof Error ? error.message : String(error), key))
      }
    },

    /**
     * Generate, then hand the bytes back for an in-window preview.
     *
     * The images are written to disk by the same code the tool uses, so both
     * entry points leave identical files behind.
     */
    async generate(request) {
      await historyReady
      const { key, response } = await requireKey()
      if (response !== undefined) return response
      const body = await readJsonBody(request)
      if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
        return fail(400, '请先填写提示词。')
      }
      const maxAmount = effectiveMaxAmount(body.maxAmount, spec.maxAmount)
      const { references, referenceFiles } = referencesFromBody(body)
      const mode = references.length > 0 ? 'image-to-image' : 'text-to-image'
      try {
        const client = createClient(key)
        const chosen = await resolveModelAndParams({
          client,
          args: { model: body.model, params: body.params },
          spec,
          mode,
        })
        const refusal = refusalForReferences(chosen, references.length)
        if (refusal !== undefined) return fail(400, refusal)
        const collected = []
        const result = await runGeneration({
          client,
          args: {
            prompt: body.prompt,
            model: chosen.model,
            params: chosen.params,
            quoteOnly: false,
            references,
            referenceFiles,
          },
          maxAmount,
          outputDir: spec.outputDir,
          writeFile: writeFileAtomic,
          attach: async (image) => {
            collected.push(image)
            return undefined
          },
        })
        if (result.overBudget === true) {
          return fail(402, `报价 ${result.amount} ${result.currency} 超过预算上限 ${result.maxAmount} ${deps.budgetCurrency}，已熔断，未提交生成。`)
        }
        const images = collected.map((image) => ({
          path: image.path,
          mediaType: image.mediaType,
          bytes: image.bytes.length,
          data: Buffer.from(image.bytes).toString('base64'),
        }))
        history.unshift({
          taskId: result.taskId,
          model: chosen.model,
          params: chosen.params,
          prompt: body.prompt,
          referenceCount: references.length,
          files: result.files,
          amount: result.amount,
          currency: result.currency,
          // Recorded so the window can show which ceiling actually applied: the
          // budget is adjustable per call, so "the budget" is not one number.
          maxAmount,
          at: Date.now(),
          status: 'done',
        })
        history.length = Math.min(history.length, HISTORY_LIMIT)
        if (persistHistory !== undefined) {
          try {
            await persistHistory(history)
          } catch {
            // Best-effort: the image is already generated and paid for, so a
            // failed history write must not turn into a failed generation.
          }
        }
        return json({
          ok: true,
          taskId: result.taskId,
          files: result.files,
          images,
          amount: result.amount,
          currency: result.currency,
          model: chosen.model,
          params: chosen.params,
        })
      } catch (error) {
        return fail(502, redact(error instanceof Error ? error.message : String(error), key))
      }
    },

    /** One task snapshot, for the progress poll. */
    async task(request) {
      const { key, response } = await requireKey()
      if (response !== undefined) return response
      const id = new URL(request.url).searchParams.get('id')
      if (typeof id !== 'string' || id.length === 0) return fail(400, '缺少任务 id。')
      try {
        return json({ ok: true, task: await createClient(key).poll(id) })
      } catch (error) {
        return fail(502, redact(error instanceof Error ? error.message : String(error), key))
      }
    },

    /** This process's finished generations, newest first. */
    async history() {
      await historyReady
      return json({ ok: true, entries: history })
    },

    /**
     * Drop one history entry, or the whole list — and optionally the files too.
     *
     * The default is **records only**, and that default is the whole safety
     * story: the images are already paid for, so a mis-click on "清空历史" must
     * not be able to destroy them. Deleting the bytes is a second, explicit
     * decision the caller has to make (`deleteFiles: true`), which the window
     * only sends after its own confirmation.
     *
     * When the files *are* deleted the order is files first, then the record.
     * The record is the only pointer to the bytes, so removing it first would
     * strand them: nothing left to list, nothing left to retry from.
     */
    async historyDelete(request) {
      await historyReady
      const body = await readJsonBody(request)
      const all = body.all === true
      const withFiles = body.deleteFiles === true
      const taskId = typeof body.taskId === 'string' && body.taskId.length > 0 ? body.taskId : undefined
      if (!all && taskId === undefined) return fail(400, '需要 taskId，或 all: true 清空全部。')

      // Decide what goes before touching anything, so a miss cannot half-run.
      const doomed = all
        ? history.filter((entry) => entry !== null && typeof entry === 'object')
        : history.filter((entry) => entry?.taskId === taskId)
      if (doomed.length === 0) return fail(404, '历史里没有匹配的记录。')

      let deleted = []
      let failed = []
      if (withFiles) {
        for (const entry of doomed) {
          const result = await deleteEntryFiles(entry)
          deleted = deleted.concat(result.deleted)
          failed = failed.concat(result.failed)
        }
      }

      const before = history.length
      if (all) {
        // In place: the array instance is shared with the tool half.
        history.length = 0
      } else {
        for (let index = history.length - 1; index >= 0; index -= 1) {
          if (history[index]?.taskId === taskId) history.splice(index, 1)
        }
      }
      const removed = before - history.length

      if (persistHistory !== undefined) {
        try {
          await persistHistory(history)
        } catch {
          // Best-effort, exactly as on the write path: the list in memory is
          // already correct, and a read-only home directory must not turn a
          // deletion into a failure.
        }
      }
      return json({
        ok: true,
        removed,
        entries: history,
        // Counted, not enumerated: the window only needs to say how much went.
        deletedFiles: deleted.length,
        // Enumerated with reasons, because a file the user asked to delete and
        // did not get deleted is exactly the thing they would never find out.
        failedFiles: failed,
      })
    },

    /**
     * Serve one image from the history, for the thumbnails and the lightbox.
     *
     * The file path is never taken from the caller — it is read out of the
     * server's own history record by task id and index. That removes path
     * traversal as a category rather than trying to sanitize it, and the
     * containment check below is only there so a corrupt record cannot escape
     * the output directory either.
     */
    async historyImage(request) {
      const params = new URL(request.url).searchParams
      const taskId = params.get('taskId')
      const index = Number(params.get('index') ?? '0')
      if (typeof taskId !== 'string' || taskId.length === 0) return fail(400, '缺少 taskId。')
      if (!Number.isSafeInteger(index) || index < 0) return fail(400, '图片序号不合法。')

      const entry = history.find((item) => item.taskId === taskId)
      if (entry === undefined) return fail(404, '历史里没有这个任务，可能已被删除。')
      const path = Array.isArray(entry.files) ? entry.files[index] : undefined
      if (typeof path !== 'string' || path.length === 0) return fail(404, '这条历史没有对应的图片。')

      const target = resolve(path)
      if (!insideDirectory(spec.outputDir, path)) {
        return fail(403, '图片不在输出目录里。')
      }

      try {
        const bytes = await readImageFile(target)
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': MEDIA_TYPE_BY_EXTENSION[extname(target).toLowerCase()] ?? 'application/octet-stream',
            // The file behind a task id never changes, but the *task id* can
            // stop resolving: history deletion removes the record, and a cached
            // response would keep serving an image the window no longer lists.
            'cache-control': 'no-store',
          },
        })
      } catch {
        return fail(404, '图片文件读不到了，可能已被移动或删除。')
      }
    },

    /** Contract freshness, honouring the same TTL cache the tool uses. */
    async apiStatus(request) {
      const force = new URL(request.url).searchParams.get('force') === 'true'
      const snapshot = await readSnapshot()
      if (snapshot === undefined) return json({ ok: true, status: 'unknown', changes: [], line: 'API: 无法核对（离线）' })
      const result = await checkApiStatus({
        fetchSpec: async () => (await fetchImpl(`${spec.baseURL}/openapi.json`, { redirect: 'error' })).json(),
        snapshot,
        cache: await readApiCache(spec.cacheFile),
        now: Date.now(),
        ttlMs: spec.apiCheckTtlMs,
        force,
      })
      if (result.summary !== undefined) {
        await writeApiCache(spec.cacheFile, { checkedAt: Date.now(), summary: result.summary })
      }
      return json({
        ok: true,
        status: result.status,
        local: result.local,
        live: result.live,
        changes: result.changes ?? [],
        cached: result.cached === true,
        line: deps.renderApiStatus(result),
      })
    },

    /**
     * Refresh the pinned contract snapshot from the live document.
     *
     * This only re-pins what the plugin compares against. It never rewrites how
     * a request is built: adapting by guesswork would spend money invisibly.
     */
    async apiUpdate() {
      const snapshot = await readSnapshot()
      if (snapshot === undefined) return fail(409, '包内没有契约快照，无法比对。')
      try {
        const live = deps.summarizeSpec(await (await fetchImpl(`${spec.baseURL}/openapi.json`, { redirect: 'error' })).json())
        const comparison = deps.compareContract(snapshot, live)
        await writeSnapshot(spec.snapshotCacheFile, live)
        await writeApiCache(spec.cacheFile, { checkedAt: Date.now(), summary: live })
        return json({
          ok: true,
          status: comparison.status,
          local: comparison.local,
          live: comparison.live,
          changes: comparison.changes ?? [],
        })
      } catch (error) {
        return fail(502, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * Register every route on the Connection fetch fence.
 *
 * `ctx` may be either the plugin context or a scope produced by
 * `ctx.inject(['connection'], ...)`: the service is read from whichever of the
 * two shapes is present. Connection is deliberately NOT in the plugin's own
 * `inject` list — that would keep the whole plugin, including the agent tool,
 * from loading in a headless deployment that has no web connection.
 *
 * @param ctx - the host context (or an injected scope) carrying `connection`.
 * @param deps - the dependencies {@link createRouteHandlers} expects.
 * @returns the number of routes registered, or 0 when Connection is absent.
 */
function registerRoutes(ctx, deps) {
  const connection = ctx?.connection ?? ctx?.get?.('connection')
  if (connection?.fetch?.register === undefined) return 0
  const handlers = createRouteHandlers(deps)
  const routes = [
    { path: `${ROUTE_PREFIX}/state`, methods: ['GET'], handler: handlers.state },
    { path: `${ROUTE_PREFIX}/key`, methods: ['POST'], handler: handlers.key },
    { path: `${ROUTE_PREFIX}/catalog`, methods: ['GET'], handler: handlers.catalog },
    { path: `${ROUTE_PREFIX}/quote`, methods: ['POST'], handler: handlers.quote },
    { path: `${ROUTE_PREFIX}/generate`, methods: ['POST'], handler: handlers.generate },
    { path: `${ROUTE_PREFIX}/task`, methods: ['GET'], handler: handlers.task },
    { path: `${ROUTE_PREFIX}/history`, methods: ['GET'], handler: handlers.history },
    { path: `${ROUTE_PREFIX}/history-delete`, methods: ['POST'], handler: handlers.historyDelete },
    { path: `${ROUTE_PREFIX}/history-image`, methods: ['GET'], handler: handlers.historyImage },
    { path: `${ROUTE_PREFIX}/api-status`, methods: ['GET'], handler: handlers.apiStatus },
    { path: `${ROUTE_PREFIX}/api-update`, methods: ['POST'], handler: handlers.apiUpdate },
  ]
  let registered = 0
  for (const route of routes) {
    try {
      connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => route.handler(request),
      })
      registered += 1
    } catch (error) {
      // A path collision must not take the whole plugin down: the agent tool
      // still works without the window.
      ctx.logger?.warn?.('jws-image: could not register %s: %s', route.path, error instanceof Error ? error.message : String(error))
    }
  }
  return registered
}

export {
  HISTORY_LIMIT,
  REFERENCE_TRANSPORT_LIMIT,
  ROUTE_PREFIX,
  createRouteHandlers,
  effectiveMaxAmount,
  insideDirectory,
  publicModel,
  readPositiveNumber,
  redact,
  referenceLimit,
  referencesFromBody,
  refusalForReferences,
  registerRoutes,
}