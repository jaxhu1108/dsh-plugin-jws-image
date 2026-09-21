/**
 * API contract freshness.
 *
 * The skill's bundled openapi.json already drifted once (525 KB vs the live
 * 161 KB), so the plugin pins the slice of the contract it actually depends on
 * and compares against the live document. It never rewrites requests to chase
 * a change: guessing wrong spends money invisibly.
 *
 * @module dsh-plugin-jws-image/contract
 */

import { createHash } from 'node:crypto'

/**
 * Reduce a full OpenAPI document to the dependency surface.
 * @param doc - the parsed OpenAPI document.
 * @returns the snapshot to pin or compare.
 */
function summarizeSpec(doc) {
  const endpoints = []
  const requiredFields = {}
  const responseFields = {}
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
      const key = `${method.toUpperCase()} ${path}`
      endpoints.push(key)
      const required = operation?.requestBody?.content?.['application/json']?.schema?.required
      if (Array.isArray(required)) requiredFields[key] = [...required].sort()
      const properties = operation?.responses?.['200']?.content?.['application/json']?.schema?.properties
      if (properties !== undefined) responseFields[key] = Object.keys(properties).sort()
    }
  }
  return {
    infoVersion: doc.info?.version ?? 'unknown',
    docSha256: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
    endpoints: endpoints.sort(),
    requiredFields,
    responseFields,
  }
}

/**
 * Compare a pinned snapshot against the live summary.
 * @param snapshot - the pinned snapshot.
 * @param live - the freshly summarized live document.
 * @returns the status plus a human-readable change list.
 */
function compareContract(snapshot, live) {
  const changes = []
  let breaking = false

  if (snapshot.infoVersion !== live.infoVersion) {
    changes.push(`版本 ${snapshot.infoVersion} → ${live.infoVersion}`)
  }
  for (const endpoint of snapshot.endpoints) {
    if (!live.endpoints.includes(endpoint)) {
      changes.push(`移除 ${endpoint}`)
      breaking = true
    }
  }
  for (const endpoint of live.endpoints) {
    if (!snapshot.endpoints.includes(endpoint)) changes.push(`新增 ${endpoint}`)
  }
  for (const [endpoint, fields] of Object.entries(snapshot.requiredFields)) {
    const now = live.requiredFields[endpoint]
    if (now === undefined) continue
    for (const field of now) {
      if (!fields.includes(field)) {
        changes.push(`${endpoint} 新增必填字段 ${field}`)
        breaking = true
      }
    }
  }
  for (const [endpoint, fields] of Object.entries(snapshot.responseFields)) {
    const now = live.responseFields[endpoint]
    if (now === undefined) continue
    for (const field of fields) {
      if (!now.includes(field)) {
        changes.push(`${endpoint} 移除响应字段 ${field}`)
        breaking = true
      }
    }
  }

  if (changes.length === 0 && snapshot.docSha256 === live.docSha256) {
    return { status: 'up-to-date', local: snapshot.infoVersion, live: live.infoVersion, changes }
  }
  return {
    status: breaking ? 'breaking' : 'changed',
    local: snapshot.infoVersion,
    live: live.infoVersion,
    changes,
  }
}

/**
 * Render the status as the one line the tool result carries.
 * @param result - the value returned by {@link compareContract}.
 * @returns a single line, no newline.
 */
function renderApiStatus(result) {
  if (result.status === 'up-to-date') return `API: 已是最新（${result.local}）`
  if (result.status === 'unknown') return 'API: 无法核对（离线）'
  const head = result.status === 'breaking'
    ? `⚠️ JWS API 有破坏性变更（本地 ${result.local} → 线上 ${result.live}）`
    : `⚠️ JWS API 有更新（本地 ${result.local} → 线上 ${result.live}）`
  const detail = result.changes.length > 0 ? `变更：${result.changes.join('；')}。` : ''
  return `${head}。${detail}请询问用户是否更新 API 快照。`
}

export { compareContract, renderApiStatus, summarizeSpec }