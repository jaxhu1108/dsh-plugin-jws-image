/**
 * dsh-plugin-jws-image — host half.
 *
 * Registers the `jws_generate_image` tool and the /api/jws-image/* routes the
 * browser half talks to. Every JWS request is made here, so the API key never
 * reaches the browser.
 *
 * @module dsh-plugin-jws-image
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { compareContract, renderApiStatus, summarizeSpec } from './contract.js'
import { readApiKey } from './credentials.js'
import { runGeneration } from './generate.js'
import { createJwsClient } from './jws-api.js'
import { formatProbe, probeCapabilities } from './probe.js'

/** Plugin name reported by the loader. */
const name = 'tool-jws-image'
/** The tool registry is the one service this plugin cannot work without. */
const inject = ['tools']

/** Fallback endpoint when the deployment config names none. */
const DEFAULT_BASE_URL = 'https://image.aijws.com'
/** Fallback per-call budget (Global Constraints: 20 元). */
const DEFAULT_MAX_AMOUNT = 20
/**
 * Currency the configured budget is written in.
 *
 * The budget is a user-facing limit the user states in 元, while the live API
 * quotes USD. The two are never converted here — see {@link renderBudgetNote}.
 */
const BUDGET_CURRENCY = 'CNY'
/** Last-resort SKU parameters, used only when the live catalog offers no SKU. */
const DEFAULT_PARAMS = Object.freeze({ size: '1:1', resolution: '1K', quality: 'auto', count: 1 })
/** Fallback window between API contract checks. */
const DEFAULT_API_CHECK_TTL_MS = 86_400_000
/** Media types the harness attachment store accepts. */
const ACCEPTED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** File extension per media type. */
const EXTENSION_BY_MEDIA_TYPE = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/** Read a config value as a trimmed non-empty string, or `undefined`. */
function readString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read a config value as a finite positive number, or the fallback. */
function readPositiveNumber(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}

/**
 * Pick the SKU whose `mode` matches the call, falling back to the first one.
 *
 * The API requires `mode`, `size`, `resolution` and `quality` to come from ONE
 * `skus[]` record, so taking the first record regardless of mode would quote an
 * image-to-image call with a text-to-image SKU and be rejected.
 *
 * @param skus - the chosen model's SKU list.
 * @param mode - the mode this call will use.
 * @returns the matching SKU, or `undefined` when the model lists none.
 */
function pickSku(skus, mode) {
  const list = Array.isArray(skus) ? skus : []
  return list.find((sku) => sku?.mode === mode) ?? list[0]
}

/**
 * Choose the model and the SKU parameters for one call.
 *
 * Nothing here is hardcoded: an explicit argument wins, then the configured
 * default, and otherwise the live catalog supplies both the model and a real
 * SKU. That is what keeps the defaults from drifting away from what the account
 * can actually sell — a pinned model id or a guessed size would start failing
 * silently the moment the catalog changed.
 *
 * The catalog is consulted even for an explicit model id, because a guessed
 * size/resolution/quality triple rarely lands on a real SKU. A catalog that
 * cannot be read is not fatal: the call proceeds on the last-resort parameters
 * and the API stays the judge.
 *
 * @param options - the client, the call arguments, the resolved spec and the mode.
 * @returns the model id, the parameters to quote with, and whether the catalog chose.
 */
async function resolveModelAndParams(options) {
  const { client, args, spec, mode = 'text-to-image' } = options
  const overrides = args.params ?? {}
  const explicit = readString(args.model) ?? readString(spec.defaultModel)

  let models
  try {
    models = await client.catalog()
  } catch (error) {
    if (explicit === undefined) throw error
    return { model: explicit, params: { ...DEFAULT_PARAMS, ...overrides }, catalogPicked: false }
  }
  const listed = Array.isArray(models) ? models : []

  const chosen = explicit === undefined
    ? listed.find((model) => Array.isArray(model.modes) && model.modes.includes(mode))
      ?? listed.find((model) => Array.isArray(model.modes) && model.modes.includes('text-to-image'))
      ?? listed[0]
    : listed.find((model) => model.id === explicit) ?? { id: explicit }

  if (chosen === undefined) {
    throw new Error('实时目录没有可用的图片模型，无法确定默认模型；请在调用时显式传 model')
  }

  const sku = pickSku(chosen.skus, mode)
  return {
    model: chosen.id,
    params: {
      size: sku?.size ?? DEFAULT_PARAMS.size,
      resolution: sku?.resolution ?? DEFAULT_PARAMS.resolution,
      quality: sku?.quality ?? DEFAULT_PARAMS.quality,
      count: DEFAULT_PARAMS.count,
      ...overrides,
    },
    catalogPicked: explicit === undefined,
  }
}

/**
 * Resolve the deployment's Harness home the same way the CLI does.
 * @returns the absolute `$DSH_HOME` path.
 */
function resolveDshHome() {
  return readString(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
}

/**
 * Normalize raw loader config into the resolved spec used by every call.
 * Unknown keys are ignored and invalid values fall back rather than throwing,
 * so a typo in a patch layer degrades one knob instead of breaking the boot.
 * @param raw - the loader-supplied plugin config.
 * @returns the resolved spec.
 */
function resolveSpec(raw) {
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const outputDir = readString(config.outputDir) ?? join(resolveDshHome(), 'generated-images', 'jws-image')
  return {
    baseURL: (readString(config.baseURL) ?? DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    defaultModel: readString(config.defaultModel),
    maxAmount: readPositiveNumber(config.maxAmount, DEFAULT_MAX_AMOUNT),
    outputDir: isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir),
    credentialsDir: readString(config.credentialsFile)
      ? resolveConfigDirFromFile(config.credentialsFile)
      : join(resolveDshHome(), '.config', 'jws-image'),
    cacheFile: join(resolveDshHome(), 'jws-image-contract-cache.json'),
    apiCheckTtlMs: readPositiveNumber(config.apiCheckTtlMs, DEFAULT_API_CHECK_TTL_MS),
  }
}

/**
 * Derive the config directory from a configured credentials file path.
 *
 * The `credentials.js` reader always looks for `config.json` inside a
 * directory, so a configured file path is reduced to its directory; a path
 * without a `.json` extension is taken to be that directory already.
 *
 * @param configured - the patch-supplied `credentialsFile` value.
 * @returns the absolute directory holding the config file.
 */
function resolveConfigDirFromFile(configured) {
  const absolute = isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  return extname(absolute) === '.json' ? dirname(absolute) : absolute
}

/**
 * Read the cached contract summary. A missing or corrupt cache is simply a
 * cache miss: it must never stop a generation.
 * @param file - the cache file path.
 * @returns the parsed cache, or `undefined`.
 */
async function readApiCache(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the contract summary. Best-effort: a read-only home directory must
 * not turn a successful generation into a failure.
 * @param file - the cache file path.
 * @param value - the cache payload.
 */
async function writeApiCache(file, value) {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value))
  } catch {
    // Caching is an optimization; losing it costs one extra HEAD-like fetch.
  }
}

/**
 * Write bytes through a `.tmp` file and rename, so a partial download can never
 * be mistaken for a finished image (Global Constraints).
 * @param path - the final absolute path.
 * @param bytes - the file contents.
 */
async function writeFileAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  await writeFile(staging, bytes)
  try {
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read the reference images the model named, as bytes plus a declared type.
 *
 * An unreadable reference throws: silently generating without the reference
 * would charge the user for the wrong picture.
 *
 * @param paths - the absolute paths named by the tool call.
 * @returns the file payloads in argument order.
 */
async function readReferenceFiles(paths) {
  const files = []
  for (const path of paths) {
    const bytes = await readFile(path)
    const extension = extname(path).toLowerCase()
    const mimeType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp' ? 'image/webp' : 'image/png'
    files.push({ bytes: new Uint8Array(bytes), mimeType })
  }
  return files
}

/**
 * Store one generated image through the attachment service.
 *
 * The service is optional: when it is absent, or rejects the image, the call
 * degrades to returning the on-disk path alone rather than throwing away a
 * picture the user has already paid for.
 *
 * @param attachments - the resolved `attachments` service, or `undefined`.
 * @param image - the downloaded image.
 * @param index - zero-based output index, for the display name.
 * @returns the attachment reference fields, or `undefined`.
 */
async function attachImage(attachments, image, index) {
  if (attachments === undefined || typeof attachments.saveImage !== 'function') return undefined
  const mediaType = ACCEPTED_IMAGE_TYPES.includes(image.mediaType) ? image.mediaType : 'image/png'
  const accepted = attachments.imageLimits?.mediaTypes
  if (Array.isArray(accepted) && !accepted.includes(mediaType)) return undefined
  const fileName = `jws-image-${index + 1}${EXTENSION_BY_MEDIA_TYPE[mediaType]}`
  try {
    const ref = await attachments.saveImage({ data: image.bytes, mediaType, name: fileName })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      name: fileName,
    }
  } catch {
    return undefined
  }
}

/**
 * Check API contract freshness, honouring a TTL cache.
 *
 * An unreachable endpoint must never block a generation: it degrades to
 * `unknown`, which the tool result reports without changing behaviour.
 *
 * @param options - the fetch hook, pinned snapshot, cache, clock and TTL.
 * @returns the comparison result.
 */
async function checkApiStatus(options) {
  const { fetchSpec, snapshot, cache, now, ttlMs, force } = options
  if (!force && cache !== undefined && cache.checkedAt !== undefined && now - cache.checkedAt < ttlMs) {
    return { ...compareContract(snapshot, cache.summary), cached: true }
  }
  try {
    const live = summarizeSpec(await fetchSpec())
    return { ...compareContract(snapshot, live), cached: false, summary: live }
  } catch {
    return { status: 'unknown', changes: [], cached: false }
  }
}

/**
 * Load the pinned contract snapshot.
 *
 * The snapshot is read from the plugin's own package, never from the network,
 * so an unreadable snapshot degrades the status line to `unknown` instead of
 * taking the tool down.
 *
 * @param spec - the resolved deployment spec.
 * @returns the snapshot, or `undefined`.
 */
async function readSnapshot() {
  try {
    return JSON.parse(await readFile(new URL('../contract/snapshot.json', import.meta.url), 'utf8'))
  } catch {
    return undefined
  }
}

/** Re-brand one output image record into the content block an image needs. */
function imageBlockFor(image) {
  return {
    type: 'image',
    attachment: {
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width ?? 0,
      height: image.height ?? 0,
      ...(image.name === undefined ? {} : { name: image.name }),
    },
  }
}

/** Render one cost, tolerating an absent amount. */
function formatCost(value, currency) {
  if (value === undefined) return '费用未返回'
  return `${value} ${currency ?? '?'}`
}

/**
 * Explain a budget check whose currencies do not match.
 *
 * The live API prices in USD while the configured budget is written in CNY, and
 * no exchange rate is available offline — inventing one would quietly change how
 * much money the breaker allows. So the amounts are compared as-is and the
 * mismatch is stated instead of hidden.
 *
 * @param currency - the currency the API actually quoted in.
 * @param budgetCurrency - the currency the budget was written in.
 * @returns a warning line, or `undefined` when the currencies agree.
 */
function renderBudgetNote(currency, budgetCurrency) {
  if (currency === undefined || currency === budgetCurrency) return undefined
  return `注意：预算上限按 ${budgetCurrency} 书写，而本次报价以 ${currency} 计价，两者未换算即直接比较；`
    + `若要严格按 ${budgetCurrency} 熔断，请把 maxAmount 换成 ${currency} 数值后再调用。`
}

/**
 * Render the model-facing envelope that accompanies the attached images.
 *
 * The text always ends with the API contract line, so every result tells the
 * model whether the contract it just used is still current.
 *
 * @param _args - the validated tool arguments (unused).
 * @param value - the validated canonical output value.
 * @returns a text block, then one image block per attached image.
 */
function renderResult(_args, value) {
  const lines = []
  if (value.status === 'ok') {
    lines.push(`已生成 ${value.images.length} 张图片，实际费用 ${formatCost(value.amount, value.currency)}，任务 ${value.taskId}。`)
    for (const [index, image] of value.images.entries()) {
      lines.push(`${index + 1}. ${image.path}（${image.mediaType}，${image.bytes} 字节）`)
    }
  } else if (value.status === 'no-key') {
    lines.push('未配置 JWS 密钥，未生成任何图片。请让用户在生图窗口里设置密钥（jws_live_ 开头）。')
  } else if (value.status === 'over-budget') {
    lines.push(`报价 ${formatCost(value.amount, value.currency)} 超过本次预算 ${value.maxAmount} ${value.budgetCurrency ?? 'CNY'}，已熔断，未提交生成。`)
    if (value.budgetNote !== undefined) lines.push(value.budgetNote)
    lines.push('如需生成，请让用户确认后提高预算上限，或换用更便宜的模型/参数。')
  } else if (value.status === 'quote-only') {
    lines.push(`报价：${formatCost(value.amount, value.currency)}（报价单 ${value.quoteId}）。未生成图片。`)
    if (value.budgetNote !== undefined) lines.push(value.budgetNote)
  } else {
    lines.push(value.message ?? '未生成任何图片。')
  }
  if (value.apiLine !== undefined) lines.push(value.apiLine)
  const blocks = [{ type: 'text', text: lines.join('\n') }]
  for (const image of value.images ?? []) {
    if (image.attachmentId !== undefined) blocks.push(imageBlockFor(image))
  }
  return blocks
}

/**
 * Register `jws_generate_image` on the tool registry.
 * @param ctx - the plugin context carrying `ctx.tools`.
 * @param rawConfig - the loader-supplied plugin config.
 */
function apply(ctx, rawConfig) {
  ctx.logger?.info('jws-image probe: %s', formatProbe(probeCapabilities(ctx)))
  const spec = resolveSpec(rawConfig)
  ctx.tools.register(defineTool({
    name: 'jws_generate_image',
    description: 'Generate images through the JWS image API (image.aijws.com). '
      + 'Quotes the price first, refuses to exceed the configured budget, then submits, '
      + 'polls and downloads. The result reports the actual cost and the API contract freshness. '
      + 'Every result ends with an "API: ..." line: if it warns that the JWS API changed, '
      + 'relay that warning and the listed changes to the user and ask whether to update the '
      + 'pinned API snapshot before generating again — never silently work around a contract change. '
      + 'Generation is slow; do not retry a call that is still running.',
    parameters: {
      prompt: { type: 'string', description: 'The image prompt.' },
      model: { type: 'string', description: 'Model id from the live catalog (image:...). Defaults to the configured model, and then to the first text-to-image model the catalog offers.' },
      params: { type: 'object', additionalProperties: true, description: 'SKU parameters: size, resolution, quality, count. Defaults come from a real SKU of the chosen model.' },
      references: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of reference images.' },
      quoteOnly: { type: 'boolean', description: 'Only price the request; do not generate.' },
      maxAmount: { type: 'number', description: 'Per-call budget override. Note the API quotes in USD while the configured budget is written in CNY; the two are compared without conversion.' },
      checkApi: { type: 'boolean', description: 'Force an immediate API contract check.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          message: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
          maxAmount: { type: 'number' },
          budgetCurrency: { type: 'string' },
          budgetNote: { type: 'string' },
          quoteId: { type: 'string' },
          taskId: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          apiLine: { type: 'string' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                attachmentId: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderResult,
    },
    async execute(args) {
      const apiKey = await readApiKey({ env: process.env, configDir: spec.credentialsDir })
      if (apiKey === undefined) {
        return {
          status: 'no-key',
          message: '未配置 JWS 密钥，未生成任何图片。请让用户在生图窗口里设置密钥（jws_live_ 开头）。',
          images: [],
        }
      }

      const client = createJwsClient({ baseURL: spec.baseURL, apiKey })

      const snapshot = await readSnapshot()
      const apiResult = snapshot === undefined
        ? { status: 'unknown', changes: [] }
        : await checkApiStatus({
          fetchSpec: async () => (await fetch(`${spec.baseURL}/openapi.json`, { redirect: 'error' })).json(),
          snapshot,
          cache: await readApiCache(spec.cacheFile),
          now: Date.now(),
          ttlMs: spec.apiCheckTtlMs,
          force: args.checkApi === true,
        })
      if (apiResult.summary !== undefined) {
        await writeApiCache(spec.cacheFile, { checkedAt: Date.now(), summary: apiResult.summary })
      }
      const apiLine = renderApiStatus(apiResult)

      const references = Array.isArray(args.references) ? args.references.filter((entry) => readString(entry) !== undefined) : []
      const maxAmount = readPositiveNumber(args.maxAmount, spec.maxAmount)
      const attachments = ctx.get('attachments')
      // `runGeneration` downloads and attaches outputs strictly in order, so a
      // running counter recovers each image's index for its display name.
      let attachIndex = 0

      const chosen = await resolveModelAndParams({
        client,
        args,
        spec,
        mode: references.length === 0 ? 'text-to-image' : 'image-to-image',
      })
      if (chosen.catalogPicked) {
        ctx.logger?.info('jws-image: no model given; using %s from the live catalog', chosen.model)
      }

      const result = await runGeneration({
        client,
        args: {
          ...args,
          model: chosen.model,
          params: chosen.params,
          references,
          referenceFiles: references.length === 0 ? [] : await readReferenceFiles(references),
        },
        maxAmount,
        outputDir: spec.outputDir,
        writeFile: writeFileAtomic,
        attach: async (image) => attachImage(attachments, image, attachIndex++),
      })

      if (result.overBudget === true) {
        const note = renderBudgetNote(result.currency, BUDGET_CURRENCY)
        return {
          status: 'over-budget',
          message: `报价 ${formatCost(result.amount, result.currency)} 超过本次预算 ${result.maxAmount} ${BUDGET_CURRENCY}，已熔断，未提交生成。`,
          amount: result.amount,
          currency: result.currency,
          maxAmount: result.maxAmount,
          budgetCurrency: BUDGET_CURRENCY,
          ...(note === undefined ? {} : { budgetNote: note }),
          quoteId: result.quoteId,
          images: [],
          apiLine,
        }
      }
      if (result.quoteOnly === true) {
        const note = renderBudgetNote(result.currency, BUDGET_CURRENCY)
        return {
          status: 'quote-only',
          message: `报价：${formatCost(result.amount, result.currency)}（报价单 ${result.quoteId}）。未生成图片。`,
          amount: result.amount,
          currency: result.currency,
          maxAmount,
          budgetCurrency: BUDGET_CURRENCY,
          ...(note === undefined ? {} : { budgetNote: note }),
          quoteId: result.quoteId,
          images: [],
          apiLine,
        }
      }

      const images = result.images.map((image, index) => ({
        path: image.path,
        mediaType: image.mediaType,
        bytes: image.bytes,
        ...(image.attachment === undefined ? {} : image.attachment),
      }))
      return {
        status: 'ok',
        message: `已生成 ${images.length} 张图片，实际费用 ${formatCost(result.amount, result.currency)}，任务 ${result.taskId}。`,
        amount: result.amount,
        currency: result.currency,
        taskId: result.taskId,
        files: result.files,
        images,
        apiLine,
      }
    },
  }))
}

export { apply, checkApiStatus, inject, name, renderResult, resolveModelAndParams }