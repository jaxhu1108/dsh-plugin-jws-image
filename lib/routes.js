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

/** Every route lives below this prefix. */
const ROUTE_PREFIX = '/api/jws-image'
/** How many finished generations the in-memory history keeps. */
const HISTORY_LIMIT = 20

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
    fetchImpl = fetch,
  } = deps

  /** Resolve the key or fail the request with a message the UI can act on. */
  async function requireKey() {
    const key = await readApiKey()
    if (key === undefined) return { key: undefined, response: fail(409, '未配置 JWS 密钥，请先在生图窗口里设置。') }
    return { key, response: undefined }
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
      try {
        const client = createClient(key)
        const chosen = await resolveModelAndParams({
          client,
          args: { model: body.model, params: body.params },
          spec,
          mode: 'text-to-image',
        })
        const quote = await client.quote({
          type: 'image',
          model: chosen.model,
          params: { mode: 'text-to-image', referenceCount: 0, ...chosen.params },
        })
        return json({
          ok: true,
          model: chosen.model,
          params: chosen.params,
          quoteId: quote.quoteId,
          amount: quote.amount,
          currency: quote.currency,
          expiresAt: quote.expiresAt,
          maxAmount: spec.maxAmount,
          budgetCurrency: deps.budgetCurrency,
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
      const { key, response } = await requireKey()
      if (response !== undefined) return response
      const body = await readJsonBody(request)
      if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
        return fail(400, '请先填写提示词。')
      }
      try {
        const client = createClient(key)
        const chosen = await resolveModelAndParams({
          client,
          args: { model: body.model, params: body.params },
          spec,
          mode: 'text-to-image',
        })
        const collected = []
        const result = await runGeneration({
          client,
          args: {
            prompt: body.prompt,
            model: chosen.model,
            params: chosen.params,
            quoteOnly: false,
          },
          maxAmount: spec.maxAmount,
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
          files: result.files,
          amount: result.amount,
          currency: result.currency,
          at: Date.now(),
          status: 'done',
        })
        history.length = Math.min(history.length, HISTORY_LIMIT)
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
      return json({ ok: true, entries: history })
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

export { HISTORY_LIMIT, ROUTE_PREFIX, createRouteHandlers, publicModel, redact, registerRoutes }