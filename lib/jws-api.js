/**
 * JWS image API client (native surface).
 *
 * Only the native endpoints are used: the OpenAI-compatible surface has no
 * `maxAmount` admission, which would defeat the budget circuit breaker.
 *
 * @module dsh-plugin-jws-image/jws-api
 */

import { createHash } from 'node:crypto'

/** Request timeout in milliseconds. */
const TIMEOUT_MS = 120_000

/**
 * Build a client bound to one key and base URL.
 * @param options - base URL, key and an injectable fetch.
 * @returns the client.
 */
function createJwsClient(options) {
  const { baseURL, apiKey, fetchImpl = fetch } = options
  const base = baseURL.replace(/\/+$/u, '')

  /**
   * One request, with the response envelope unwrapped.
   * @param path - path below the base URL.
   * @param init - fetch options.
   * @returns the `data` field.
   */
  async function request(path, init = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      const raw = typeof payload?.error?.message === 'string' ? payload.error.message : '接口暂不可用'
      throw new Error(`JWS HTTP ${response.status}: ${raw.replaceAll(apiKey, '[已隐藏]')}`)
    }
    const payload = await response.json()
    return payload.data
  }

  /** POST JSON. */
  const post = (path, body) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  return {
    catalog: () => request('/v1/catalog/models?type=image'),
    model: (id) => request(`/v1/catalog/models/${encodeURIComponent(id)}`),
    quote: (input) => post('/v1/quotes', input),
    request,

    /**
     * Declare and upload reference images in one input session.
     *
     * The session id and the generation request must share one Idempotency-Key:
     * the server binds materials to the account by that request id, so reusing
     * it on a retry is what makes a lost response recoverable.
     *
     * @param options - the reference files and the shared request id.
     * @returns the session id and the uploaded item ids.
     */
    async uploadReferences({ files, requestId }) {
      const items = files.map((file, index) => ({
        sourceId: `reference-${index + 1}`,
        mimeType: file.mimeType,
        size: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      }))
      const session = await request('/v1/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
        body: JSON.stringify({ purpose: 'image-generation', items }),
      })
      for (const [index, file] of files.entries()) {
        await request(`/v1/inputs/${encodeURIComponent(session.id)}/items/${encodeURIComponent(session.items[index].itemId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': file.mimeType },
          body: file.bytes,
        })
      }
      return {
        inputSessionId: session.id,
        imageInputIds: session.items.map((item) => item.itemId),
      }
    },

    /**
     * Submit a generation task.
     * @param options - the shared request id and the flattened task body.
     * @returns the task id.
     */
    async createGeneration({ requestId, body }) {
      const task = await request('/v1/image/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
        body: JSON.stringify(body),
      })
      return task.id
    },

    /** Read one task. */
    poll: (taskId) => request(`/v1/tasks/${encodeURIComponent(taskId)}`),

    /**
     * Poll until the task is genuinely finished.
     *
     * A succeeded task with a pending settlement is NOT finished: token-priced
     * work has not been charged yet, so stopping there would report a cost that
     * is still moving.
     *
     * @param taskId - the task to watch.
     * @param options - poll interval and overall timeout.
     * @returns the settled task.
     */
    async waitForSettlement(taskId, options) {
      const { intervalMs = 2000, timeoutMs = 15 * 60 * 1000 } = options ?? {}
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const task = await request(`/v1/tasks/${encodeURIComponent(taskId)}`)
        const bad = ['failed', 'canceled', 'cancelled', 'unknown'].includes(task.status)
          || ['insufficient', 'failed', 'review'].includes(task.settlementStatus)
        if (bad) {
          throw new Error(`任务 ${taskId}: ${task.status} / ${task.settlementStatus ?? task.billingStatus}；请保留任务文件核对，不要重新生成`)
        }
        const settled = task.status === 'succeeded'
          && !['pending', 'settling'].includes(task.settlementStatus)
        if (settled) return task
        if (Date.now() >= deadline) {
          throw new Error(`任务 ${taskId} 超过等待时限，当前 ${task.status} / ${task.settlementStatus ?? '-'}`)
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    },

    /**
     * Download one output image.
     * @param taskId - the owning task.
     * @param index - zero-based output index.
     * @returns the bytes and the media type.
     */
    async downloadContent(taskId, index) {
      const response = await fetchImpl(`${base}/v1/tasks/${encodeURIComponent(taskId)}/content?index=${index}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok) throw new Error(`JWS HTTP ${response.status}: 图片下载失败`)
      const mediaType = response.headers.get('content-type')?.split(';')[0].trim() ?? 'image/png'
      return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType }
    },
  }
}

export { createJwsClient }