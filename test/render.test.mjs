/**
 * Rendering tests for the budget-currency disclosure.
 *
 * The live API quotes USD while the configured budget is written in 元, and no
 * offline exchange rate exists. These tests pin the honest behaviour: the
 * amounts are compared as-is and the mismatch is stated in the result rather
 * than papered over with a made-up conversion.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderResult } from '../lib/index.js'

test('an over-budget result names both currencies and warns about the mismatch', () => {
  const blocks = renderResult({}, {
    status: 'over-budget',
    amount: 3.5,
    currency: 'USD',
    maxAmount: 20,
    budgetCurrency: 'CNY',
    budgetNote: '注意：预算上限按 CNY 书写，而本次报价以 USD 计价。',
    quoteId: 'q1',
    images: [],
  })
  const text = blocks[0].text
  assert.match(text, /USD/u)
  assert.match(text, /20 CNY/u)
  assert.match(text, /注意：/u)
  // No invented exchange rate anywhere in the message.
  assert.doesNotMatch(text, /\d+(\.\d+)?\s*=\s*\d/u)
})

test('a matching currency needs no warning', () => {
  const blocks = renderResult({}, {
    status: 'quote-only',
    amount: 3,
    currency: 'CNY',
    quoteId: 'q1',
    images: [],
  })
  assert.doesNotMatch(blocks[0].text, /注意：/u)
  assert.match(blocks[0].text, /3 CNY/u)
})

test('an absent currency is shown as unknown rather than assumed', () => {
  const blocks = renderResult({}, { status: 'quote-only', amount: 3, quoteId: 'q1', images: [] })
  assert.match(blocks[0].text, /3 \?/u)
})

test('the API contract line is always the last line', () => {
  const blocks = renderResult({}, {
    status: 'quote-only',
    amount: 3,
    currency: 'USD',
    quoteId: 'q1',
    images: [],
    apiLine: 'API: 已是最新（1.0.0）',
  })
  assert.equal(blocks[0].text.split('\n').at(-1), 'API: 已是最新（1.0.0）')
})