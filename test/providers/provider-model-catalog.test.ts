import test from 'node:test'
import assert from 'node:assert/strict'

import {
  listProviderModelOptions,
  listProviderModels,
  ProviderModelSelectionError,
  resolveProviderModel,
} from '../../src/providers/provider-model-catalog.ts'
import type { ProviderId } from '../../src/providers/provider-id.ts'

const PROVIDERS: readonly ProviderId[] = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
]

test('provider model catalog resolves names to internal menu positions', () => {
  const expected = {
    chatgpt: ['chatgpt'],
    gemini: ['3.5-flash-lite', '3.6-flash', '3.1-pro'],
    deepseek: ['quick', 'expert', 'vision'],
    doubao: ['quick', 'expert', 'office-turbo', 'office-pro'],
    grok: ['fast', 'auto', 'expert', 'heavy'],
    glm: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-5v-turbo', 'glm-4.7'],
    qwen: ['qwen3.7-plus', 'qwen3.8-max-preview', 'qwen3.7-max'],
    kimi: ['k2.6', 'k3', 'k3-cluster'],
  } as const satisfies Readonly<Record<ProviderId, readonly string[]>>

  for (const provider of PROVIDERS) {
    const models = expected[provider]
    assert.deepEqual(listProviderModels(provider), models)
    models.forEach((model, index) => {
      assert.deepEqual(resolveProviderModel(provider, model), {
        key: model,
        option: null,
        adapterValue: String(index + 1),
      })
    })
  }
  assert.deepEqual(resolveProviderModel('gemini', '3.1-PRO', 'EXTENDED'), {
    key: '3.1-pro',
    option: 'extended',
    adapterValue: '3+extended',
  })
  assert.equal(resolveProviderModel('grok', null), null)
})

test('provider model catalog exposes model-specific options', () => {
  for (const model of listProviderModels('gemini')) {
    assert.deepEqual(listProviderModelOptions('gemini', model), ['extended'])
  }
  assert.deepEqual(listProviderModelOptions('deepseek', 'expert'), [])
})

test('provider model catalog rejects numeric, unknown, and misplaced options', () => {
  for (const provider of PROVIDERS) {
    assert.throws(
      () => resolveProviderModel(provider, '1'),
      ProviderModelSelectionError
    )
  }
  assert.throws(
    () => resolveProviderModel('chatgpt', '1+2'),
    ProviderModelSelectionError
  )
  assert.throws(
    () => resolveProviderModel('gemini', '1+extended'),
    ProviderModelSelectionError
  )
  assert.throws(
    () => resolveProviderModel('deepseek', null, 'thinking'),
    /requires a model/
  )
  assert.throws(
    () => resolveProviderModel('deepseek', 'expert', 'thinking'),
    /does not support model options/
  )
  assert.throws(
    () => resolveProviderModel('gemini', '3.1-pro', 'thinking'),
    /Available options: extended/
  )
})
