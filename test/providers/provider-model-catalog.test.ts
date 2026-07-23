import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isResolvedProviderModelSupported,
  listProviderModelOptions,
  listProviderModels,
  ProviderModelSelectionError,
  resolveProviderModel,
} from '../../src/providers/provider-model-catalog.ts'
import { PROVIDER_DEFINITIONS } from '../../src/providers/provider-definition-pack.ts'
import { PROVIDER_IDS } from '../../src/providers/provider-id.ts'

test('provider model catalog resolves names to semantic selections', () => {
  for (const provider of PROVIDER_IDS) {
    const definitions = PROVIDER_DEFINITIONS[provider].models
    assert.deepEqual(
      listProviderModels(provider),
      definitions.map((model) => model.key)
    )
    for (const definition of definitions) {
      assert.deepEqual(resolveProviderModel(provider, definition.key), {
        key: definition.key,
        option: null,
      })
    }
  }
  assert.deepEqual(resolveProviderModel('gemini', '3.1-PRO', 'EXTENDED'), {
    key: '3.1-pro',
    option: 'extended',
  })
  assert.equal(resolveProviderModel('grok', null), null)
})

test('provider model catalog exposes model-specific options', () => {
  for (const provider of PROVIDER_IDS) {
    for (const model of PROVIDER_DEFINITIONS[provider].models) {
      assert.deepEqual(
        listProviderModelOptions(provider, model.key),
        model.options.map((option) => option.key)
      )
    }
  }
  assert.deepEqual(listProviderModelOptions('deepseek', 'expert'), [])
})

test('provider model catalog validates semantic selections without owning UI order', () => {
  assert.equal(
    isResolvedProviderModelSupported('gemini', {
      key: '3.1-pro',
      option: 'extended',
    }),
    true
  )
  assert.equal(
    isResolvedProviderModelSupported('gemini', {
      key: '3.1-pro',
      option: 'unsupported',
    }),
    false
  )
  assert.equal(
    isResolvedProviderModelSupported('grok', {
      key: 'missing',
      option: null,
    }),
    false
  )
})

test('provider model catalog rejects numeric, unknown, and misplaced options', () => {
  for (const provider of PROVIDER_IDS) {
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
