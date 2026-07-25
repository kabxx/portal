import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GROK_PROVIDER_PROMPT,
  PROVIDERS,
  normalizeProviderId,
} from '../../src/app/app-provider-catalog.ts'

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

test('Grok provider prompt defines strict tool-use pitfalls', () => {
  assert.match(GROK_PROVIDER_PROMPT, /^# Pitfall \(Strict Enforcement\)/)
  assert.match(GROK_PROVIDER_PROMPT, /use the provided tool call format/)
  assert.match(GROK_PROVIDER_PROMPT, /NEVER claim tool usage/)
})
