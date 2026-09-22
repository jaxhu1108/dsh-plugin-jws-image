/**
 * The generation flow shared by the tool and the browser route.
 *
 * @module dsh-plugin-jws-image/generate
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * Turn a task id into one safe path segment.
 *
 * Task ids look like `image:e0f0ee88-...`, and a colon is not a legal filename
 * character on Windows, so the id cannot be used verbatim.
 *
 * @param taskId - the API task id.
 * @returns a segment safe to use as a directory name.
 */
function taskSegment(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'task'
}

/**
 * Run one generation, refusing anything the budget does not cover.
 *
 * @param options - client, arguments, budget, output directory and the attach hook.
 * @returns a summary of what happened, including the real cost.
 */
async function runGeneration(options) {
  const { client, args, maxAmount, outputDir, attach, writeFile } = options
  const references = Array.isArray(args.references) ? args.references : []
  const params = {
    mode: references.length > 0 ? 'image-to-image' : 'text-to-image',
    referenceCount: references.length,
    ...args.params,
  }
  const quoteInput = { type: 'image', model: args.model, params }

  const quote = await client.quote(quoteInput)
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    throw new Error('报价已过期，尚未提交生成，请重新报价')
  }
  if (args.quoteOnly === true) {
    return { quoteOnly: true, amount: quote.amount, currency: quote.currency, quoteId: quote.quoteId }
  }
  if (quote.amount > maxAmount) {
    return { overBudget: true, amount: quote.amount, currency: quote.currency, maxAmount, quoteId: quote.quoteId }
  }

  const requestId = randomUUID()
  let inputs = {}
  if (references.length > 0) {
    inputs = await client.uploadReferences({ files: args.referenceFiles ?? [], requestId })
  }
  const taskId = await client.createGeneration({
    requestId,
    body: { ...params, ...inputs, model: args.model, prompt: args.prompt, maxAmount: quote.amount },
  })
  const task = await client.waitForSettlement(taskId, { intervalMs: 2000 })

  const files = []
  const images = []
  // One directory per task. A flat output directory would have every generation
  // overwrite `image-1.png`, which silently destroys earlier results and leaves
  // every history entry pointing at the newest image.
  const taskDir = join(outputDir, taskSegment(taskId))
  for (let index = 0; index < task.outputCount; index += 1) {
    const { bytes, mediaType } = await client.downloadContent(taskId, index)
    const extension = mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/webp' ? '.webp' : '.png'
    const path = join(taskDir, `image-${index + 1}${extension}`)
    if (writeFile !== undefined) {
      await writeFile(`${path}.tmp`, bytes)
      await writeFile(path, bytes)
    }
    files.push(path)
    const ref = attach === undefined ? undefined : await attach({ bytes, mediaType, path })
    images.push({ path, mediaType, bytes: bytes.length, attachment: ref })
  }

  return {
    taskId,
    files,
    images,
    amount: task.amount ?? quote.amount,
    currency: task.currency ?? quote.currency,
  }
}

export { runGeneration, taskSegment }