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

test('Grok provider prompt isolates Portal from native local access', () => {
  assert.match(GROK_PROVIDER_PROMPT, /^# Pitfall \(Portal Tool Boundary\)/)
  assert.match(
    GROK_PROVIDER_PROMPT,
    /READY keeps these rules active for later requests/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /For a safe, fully specified action covered by # Tools/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /use its Portal tool instead of any Grok-native feature/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /respond only with one matching raw tool block using the exact declared name and JSON or Freeform payload/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /Never use Grok-native features or permission dialogs to access user-local resources/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /Only a later message headed ### Tool Result ### proves execution, success, or failure/
  )
  assert.match(
    GROK_PROVIDER_PROMPT,
    /Inspect that result before another call or any completion claim/
  )
})
