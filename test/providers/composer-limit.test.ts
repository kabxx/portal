import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkComposerLimit,
  createComposerLimitToolDelivery,
  measureComposerText,
  resolveComposerLimitResult,
  resolveProviderComposerLimit,
  VERIFIED_COMPOSER_LIMIT_FALLBACKS,
  type ComposerLimit,
} from '../../src/providers/composer-limit.ts'
import type { ProviderPage } from '../../src/providers/adapters/adapter-base.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'

test('composer measurement uses the declared unit', () => {
  assert.equal(measureComposerText('A😀', 'utf16_code_units'), 3)
  assert.equal(measureComposerText('A😀', 'unicode_code_points'), 2)
  assert.equal(measureComposerText('A😀', 'utf8_bytes'), 5)
})

test('composer limits distinguish unknown, within, and over-limit text', () => {
  const unknown: ComposerLimit = {
    kind: 'unknown',
    provider: 'chatgpt',
    source: 'unknown',
  }
  assert.deepEqual(checkComposerLimit('large input', unknown), {
    status: 'unknown',
    limit: unknown,
  })

  const known: ComposerLimit = {
    kind: 'known',
    provider: 'gemini',
    limit: 4,
    unit: 'utf16_code_units',
    source: 'dom',
    confidence: 'exact',
  }
  assert.equal(checkComposerLimit('test', known).status, 'within_limit')
  assert.equal(checkComposerLimit('tests', known).status, 'over_limit')
})

test('composer limit resolution keeps the stricter compatible constraint', () => {
  const fallback = {
    limit: 100,
    unit: 'utf16_code_units' as const,
    confidence: 'safe_cap' as const,
    verifiedAt: '2026-07-20',
    verificationScope: 'synthetic boundary test',
  }
  assert.deepEqual(
    resolveComposerLimitResult(
      'qwen',
      { limit: 20, unit: 'utf16_code_units' },
      fallback
    ),
    {
      kind: 'known',
      provider: 'qwen',
      limit: 20,
      unit: 'utf16_code_units',
      source: 'dom',
      confidence: 'exact',
    }
  )
  assert.deepEqual(resolveComposerLimitResult('qwen', null, fallback), {
    kind: 'known',
    provider: 'qwen',
    limit: 100,
    unit: 'utf16_code_units',
    source: 'verified_fallback',
    confidence: 'safe_cap',
  })
  assert.deepEqual(
    resolveComposerLimitResult(
      'qwen',
      { limit: 200, unit: 'utf16_code_units' },
      { ...fallback, unit: 'utf16_code_units' }
    ),
    {
      kind: 'known',
      provider: 'qwen',
      limit: 100,
      unit: 'utf16_code_units',
      source: 'verified_fallback',
      confidence: 'safe_cap',
    }
  )
  assert.deepEqual(
    resolveComposerLimitResult(
      'qwen',
      { limit: 20, unit: 'unicode_code_points' },
      fallback
    ),
    {
      kind: 'known',
      provider: 'qwen',
      limit: 100,
      unit: 'utf16_code_units',
      source: 'verified_fallback',
      confidence: 'safe_cap',
    }
  )
  assert.deepEqual(resolveComposerLimitResult('qwen', null, undefined), {
    kind: 'unknown',
    provider: 'qwen',
    source: 'unknown',
  })
})

test('provider DOM limit lookup can be cancelled while evaluation stalls', async () => {
  const controller = new AbortController()
  const evaluation = Promise.withResolvers<unknown>()
  const page: ProviderPage = {
    close: async () => {},
    pause: async () => {},
    on: () => {},
    off: () => {},
    isClosed: () => false,
    evaluate: async () => await evaluation.promise,
  }

  const pending = resolveProviderComposerLimit(page, 'chatgpt', {
    signal: controller.signal,
  })
  controller.abort(new PortalAbortError('cancel composer limit lookup'))

  await assert.rejects(pending, PortalAbortError)
  evaluation.resolve(null)
})

test('verified fallbacks enforce their measured UTF-16 boundaries', () => {
  const cases = [
    ['chatgpt', 65_534, 'exact', '2026-07-20'],
    ['gemini', 32_000, 'exact', '2026-07-20'],
    ['qwen', 131_072, 'exact', '2026-07-20'],
    ['deepseek', 163_840, 'safe_cap', '2026-07-22'],
    ['doubao', 2_000_000, 'safe_cap', '2026-07-20'],
    ['grok', 100_000, 'safe_cap', '2026-07-22'],
    ['glm', 100_000, 'safe_cap', '2026-07-22'],
    ['kimi', 2_000_000, 'safe_cap', '2026-07-20'],
  ] as const

  for (const [provider, expectedLimit, confidence, verifiedAt] of cases) {
    const fallback = VERIFIED_COMPOSER_LIMIT_FALLBACKS[provider]
    assert.ok(fallback)
    assert.equal(fallback.limit, expectedLimit)
    assert.equal(fallback.unit, 'utf16_code_units')
    assert.equal(fallback.confidence, confidence)
    assert.equal(fallback.verifiedAt, verifiedAt)

    const limit = resolveComposerLimitResult(provider, null, fallback)
    assert.equal(
      checkComposerLimit('x'.repeat(expectedLimit), limit).status,
      'within_limit'
    )
    assert.equal(
      checkComposerLimit('x'.repeat(expectedLimit + 1), limit).status,
      'over_limit'
    )
  }
})

test('safe caps are identified separately from exact provider boundaries', () => {
  const fallback = VERIFIED_COMPOSER_LIMIT_FALLBACKS.deepseek
  assert.ok(fallback)
  assert.equal(fallback.confidence, 'safe_cap')
  assert.match(fallback.verificationScope, /163,840/)
})

test('composer overages produce model-facing delivery diagnostics', () => {
  const limit = {
    kind: 'known',
    provider: 'deepseek',
    limit: 163_840,
    unit: 'utf16_code_units',
    source: 'verified_fallback',
    confidence: 'safe_cap',
  } as const
  const check = checkComposerLimit('x'.repeat(200_000), limit)
  assert.equal(check.status, 'over_limit')
  if (check.status !== 'over_limit') return

  assert.deepEqual(createComposerLimitToolDelivery(check), {
    status: 'not_delivered',
    code: 'COMPOSER_LIMIT_EXCEEDED',
    message:
      'The original tool result was not delivered because it exceeds the deepseek Portal safety cap.',
    measured: 200_000,
    limit: 163_840,
    unit: 'utf16_code_units',
    source: 'verified_fallback',
    confidence: 'safe_cap',
  })
})
