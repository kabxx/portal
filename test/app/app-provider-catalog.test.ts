import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROVIDERS,
  normalizeProviderId,
} from '../../src/providers/provider-catalog.ts'

test('provider registry includes every supported provider', () => {
  assert.deepEqual(PROVIDERS, [
    'chatgpt',
    'gemini',
    'deepseek',
    'doubao',
    'grok',
    'glm',
    'qwen',
    'kimi',
  ])
})

test('provider aliases normalize at the application boundary', () => {
  assert.equal(normalizeProviderId(' GPT '), 'chatgpt')
  assert.equal(normalizeProviderId('GROK'), 'grok')
  assert.equal(normalizeProviderId(''), null)
  assert.equal(normalizeProviderId('unknown'), null)
})
