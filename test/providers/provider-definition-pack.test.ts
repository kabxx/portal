import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defineProvider,
  defineProviderPack,
  getProviderCapability,
  PROVIDER_DEFINITIONS,
  type ProviderDefinitionInput,
} from '../../src/providers/provider-definition-pack.ts'
import {
  PROVIDER_IDS,
  type ProviderId,
} from '../../src/providers/provider-id.ts'

test('provider definitions form one complete frozen domain snapshot', () => {
  assert.deepEqual(Object.keys(PROVIDER_DEFINITIONS), PROVIDER_IDS)
  assert.equal(Object.isFrozen(PROVIDER_DEFINITIONS), true)

  for (const provider of PROVIDER_IDS) {
    const definition = PROVIDER_DEFINITIONS[provider]
    assert.equal(definition.provider, provider)
    assert.equal('schemaVersion' in definition, false)
    assert.equal('locators' in definition, false)
    assert.equal(Object.isFrozen(definition), true)
    assert.equal(Object.isFrozen(definition.models), true)
    assert.equal(Object.isFrozen(definition.capabilities), true)
    for (const model of definition.models) {
      assert.equal(Object.isFrozen(model), true)
      assert.equal(Object.isFrozen(model.options), true)
    }
    for (const capability of definition.capabilities) {
      assert.equal(Object.isFrozen(capability), true)
    }
  }

  assert.deepEqual(getProviderCapability('deepseek', 'THINKING'), {
    key: 'thinking',
    description: 'Deep thinking mode.',
    kind: 'toggle',
  })
})

test('provider definitions preserve declared model order and do not freeze input', () => {
  const input = cloneDefinitionInput('doubao')
  const definition = defineProvider({
    ...input,
    models: [...input.models].reverse(),
  })

  assert.deepEqual(
    definition.models.map((model) => model.key),
    ['office-pro', 'office-turbo', 'expert', 'quick']
  )
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.models), false)
  assert.equal(Object.isFrozen(input.models[0]), false)
})

test('provider definitions reject duplicate keys and unknown UI fields', () => {
  const grok = cloneDefinitionInput('grok')
  const duplicateModel = {
    ...grok,
    models: grok.models.map((model, index) => ({
      ...model,
      key: index === 1 ? grok.models[0]!.key : model.key,
    })),
  }
  assert.throws(
    () => defineProvider(duplicateModel),
    /grok\.models\.key contains duplicate value "fast"/
  )

  const unknownModelField = cloneDefinitionInput('grok')
  Reflect.set(unknownModelField.models[0]!, 'position', 1)
  assert.throws(
    () => defineProvider(unknownModelField),
    /grok\.models\.fast contains unknown fields: position/
  )

  const unknownDefinitionField = {
    ...cloneDefinitionInput('grok'),
    locators: {},
  }
  assert.throws(
    () => defineProvider(unknownDefinitionField),
    /provider definition contains unknown fields: locators/
  )
})

test('provider definitions reject unsupported capability kinds and invalid descriptions', () => {
  const unsupportedKind = cloneDefinitionInput('deepseek')
  Reflect.set(unsupportedKind.capabilities[0]!, 'kind', 'action')
  assert.throws(
    () => defineProvider(unsupportedKind),
    /deepseek\.capabilities\.thinking uses an unsupported kind/
  )

  const reservedAction = cloneDefinitionInput('chatgpt')
  Reflect.set(reservedAction.capabilities[0]!, 'key', 'none')
  assert.throws(
    () => defineProvider(reservedAction),
    /chatgpt\.capabilities action key "none" is reserved/
  )

  const invalidDescription = cloneDefinitionInput('chatgpt')
  Reflect.set(invalidDescription.capabilities[0]!, 'description', 42)
  assert.throws(
    () => defineProvider(invalidDescription),
    /chatgpt\.capabilities\.image_create\.description must contain 1-200 characters/
  )
})

test('provider pack rejects incomplete and mismatched maps at runtime', () => {
  const incomplete = { ...PROVIDER_DEFINITIONS }
  Reflect.deleteProperty(incomplete, 'kimi')
  assert.throws(() => defineProviderPack(incomplete), /must contain exactly/)

  const mismatched = { ...PROVIDER_DEFINITIONS }
  Reflect.set(mismatched, 'grok', PROVIDER_DEFINITIONS.kimi)
  assert.throws(
    () => defineProviderPack(mismatched),
    /key grok does not match its provider field/
  )
})

function cloneDefinitionInput<P extends ProviderId>(
  provider: P
): ProviderDefinitionInput<P>
function cloneDefinitionInput(provider: ProviderId): ProviderDefinitionInput {
  return structuredClone(PROVIDER_DEFINITIONS[provider])
}
