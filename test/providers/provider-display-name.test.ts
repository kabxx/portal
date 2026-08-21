import assert from 'node:assert/strict'
import test from 'node:test'

import { FIRST_PARTY_PROVIDER_IDS } from '../../src/providers/first-party-provider-id.ts'
import { formatProviderDisplayName } from '../../src/providers/provider-display-name.ts'

test('all first-party providers have stable display names for user messages', () => {
  assert.deepEqual(
    FIRST_PARTY_PROVIDER_IDS.map((provider) => [
      provider,
      formatProviderDisplayName(provider),
    ]),
    [
      ['chatgpt', 'ChatGPT'],
      ['gemini', 'Gemini'],
      ['deepseek', 'DeepSeek'],
      ['doubao', 'Doubao'],
      ['grok', 'Grok'],
      ['glm', 'GLM'],
      ['qwen', 'Qwen'],
      ['kimi', 'Kimi'],
    ]
  )
})
