import assert from 'node:assert/strict'
import test from 'node:test'

import { formatProbe, probeCapabilities } from '../lib/probe.js'

test('reports which optional services resolved', () => {
  const ctx = { get: (service) => (service === 'attachments' ? {} : undefined) }
  const report = probeCapabilities(ctx)
  assert.deepEqual(report.services, ['attachments'])
  assert.ok(report.warnings.some((line) => line.includes('connection')))
})

test('tolerates a ctx whose get() throws', () => {
  const ctx = { get: () => { throw new Error('boom') } }
  const report = probeCapabilities(ctx)
  assert.deepEqual(report.services, [])
})

test('formatProbe renders one line', () => {
  const text = formatProbe({ services: ['attachments'], slots: [], warnings: [] })
  assert.match(text, /services=attachments/u)
  assert.equal(text.includes('\n'), false)
})