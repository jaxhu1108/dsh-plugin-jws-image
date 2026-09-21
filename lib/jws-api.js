/**
 * JWS image API client (native surface).
 *
 * Only the native endpoints are used: the OpenAI-compatible surface has no
 * `maxAmount` admission, which would defeat the budget circuit breaker.
 *
 * @module dsh-plugin-jws-image/jws-api
 */

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
  }
}

export { createJwsClient }