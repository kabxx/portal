import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defineProvider,
  defineProviderPack,
  getProviderCapability,
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
  PROVIDER_DEFINITIONS,
  PROVIDER_LOCATOR_SLOTS,
  type ProviderDefinitionInput,
} from '../../src/providers/provider-definition-pack.ts'
import {
  PROVIDER_IDS,
  type ProviderId,
} from '../../src/providers/provider-id.ts'

test('provider manifests form one complete frozen snapshot', () => {
  assert.deepEqual(Object.keys(PROVIDER_DEFINITIONS), PROVIDER_IDS)
  assert.equal(Object.isFrozen(PROVIDER_DEFINITIONS), true)

  for (const provider of PROVIDER_IDS) {
    const definition = PROVIDER_DEFINITIONS[provider]
    assert.equal(definition.provider, provider)
    assert.equal(definition.schemaVersion, 1)
    assert.equal(Object.isFrozen(definition), true)
    assert.equal(Object.isFrozen(definition.models), true)
    assert.equal(Object.isFrozen(definition.capabilities), true)
    assert.equal(Object.isFrozen(definition.locators), true)
    assert.deepEqual(
      Object.keys(definition.locators).sort(),
      [...PROVIDER_LOCATOR_SLOTS[provider]].sort()
    )
    for (const candidates of Object.values(definition.locators)) {
      assert.equal(Object.isFrozen(candidates), true)
    }
  }

  assert.deepEqual(getProviderCapability('deepseek', 'THINKING'), {
    key: 'thinking',
    description: 'Deep thinking mode.',
    kind: 'toggle',
    target: { kind: 'adapter_capability', value: 'thinking' },
  })
})

test('provider manifests normalize models without freezing their source', () => {
  const input = cloneDefinitionInput('doubao')
  const definition = defineProvider({
    ...input,
    models: [...input.models].reverse(),
  })

  assert.deepEqual(
    definition.models.map((model) => model.position),
    [1, 2, 3, 4]
  )
  assert.equal(
    joinCssLocatorCandidates(definition.locators.modelTrigger, ':visible'),
    definition.locators.modelTrigger
      .map((candidate) => `${candidate}:visible`)
      .join(', ')
  )
  assert.equal(
    mapCssLocatorCandidates(
      ['.primary', '.fallback'],
      (candidate) => `#owner ${candidate}:visible[data-kind="model"]`
    ),
    '#owner .primary:visible[data-kind="model"], #owner .fallback:visible[data-kind="model"]'
  )
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(input.models[0]), false)
})

test('provider manifests reject duplicate keys, positions, and targets', () => {
  const grok = cloneDefinitionInput('grok')
  const duplicatePosition = {
    ...grok,
    models: grok.models.map((model, index) => ({
      ...model,
      position: index === 1 ? grok.models[0]!.position : model.position,
    })),
  }
  assert.throws(
    () => defineProvider(duplicatePosition),
    /grok\.models\.position contains duplicate value "1"/
  )

  const positionGap = {
    ...grok,
    models: grok.models.map((model, index) => ({
      ...model,
      position:
        index === grok.models.length - 1 ? model.position + 1 : model.position,
    })),
  }
  assert.throws(
    () => defineProvider(positionGap),
    /grok\.models\.position must be consecutive from 1/
  )

  const deepseek = cloneDefinitionInput('deepseek')
  const duplicateCapability = {
    ...deepseek,
    capabilities: deepseek.capabilities.map((capability, index) => ({
      ...capability,
      key: index === 1 ? deepseek.capabilities[0]!.key : capability.key,
    })),
  }
  assert.throws(
    () => defineProvider(duplicateCapability),
    /deepseek\.capabilities\.key contains duplicate value "thinking"/
  )
})

test('provider manifests reject adapter-incompatible model and capability targets', () => {
  const unsupportedOption = cloneDefinitionInput('grok')
  Reflect.set(unsupportedOption.models[0]!, 'options', [
    { key: 'extended', target: { kind: 'suffix', value: 'extended' } },
  ])
  assert.throws(
    () => defineProvider(unsupportedOption),
    /grok\.models\.fast\.options\.extended is not supported/
  )

  const unsupportedToggle = cloneDefinitionInput('deepseek')
  Reflect.set(
    unsupportedToggle.capabilities[1]!.target,
    'value',
    'advanced_search'
  )
  assert.throws(
    () => defineProvider(unsupportedToggle),
    /deepseek\.capabilities\.search target "advanced_search" is not supported/
  )

  const reservedAction = cloneDefinitionInput('chatgpt')
  Reflect.set(reservedAction.capabilities[0]!, 'key', 'none')
  assert.throws(
    () => defineProvider(reservedAction),
    /chatgpt\.capabilities action key "none" is reserved/
  )

  const invalidGlmTarget = cloneDefinitionInput('glm')
  Reflect.set(invalidGlmTarget.capabilities[0]!.target, 'value', 'future_mode')
  assert.throws(
    () => defineProvider(invalidGlmTarget),
    /glm\.capabilities\.thinking target "future_mode" is not supported/
  )

  const invalidQwenScope = cloneDefinitionInput('qwen')
  Reflect.set(invalidQwenScope.capabilities[0]!.target, 'scope', 'side')
  assert.throws(
    () => defineProvider(invalidQwenScope),
    /qwen\.capabilities\.deep_research\.target\.scope must be root or nested/
  )

  const invalidDescription = cloneDefinitionInput('chatgpt')
  Reflect.set(invalidDescription.capabilities[0]!, 'description', 42)
  assert.throws(
    () => defineProvider(invalidDescription),
    /chatgpt\.capabilities\.image_create\.description must contain 1-200 characters/
  )
})

test('provider manifests reject missing, extra, and unsafe locator slots', () => {
  const missing = cloneDefinitionInput('qwen')
  Reflect.deleteProperty(missing.locators, 'modelTrigger')
  assert.throws(
    () => defineProvider(missing),
    /qwen\.locators must contain exactly/
  )

  const extra = cloneDefinitionInput('kimi')
  Reflect.set(extra.locators, 'unknown', ['#unknown'])
  assert.throws(
    () => defineProvider(extra),
    /kimi\.locators must contain exactly/
  )

  for (const invalidCandidate of [
    '',
    'xpath=//button',
    '//button',
    'text=Settings',
    'role=button',
    'css=#model',
    'internal:role=button',
    '_react=Component',
    '.inside, .outside',
    '#model >> button',
    '#model:visible',
    'button:has-text("Model")',
    'button[aria-label]',
    'button[aria-label="Model"]',
    'button[aria\\-label="Model"]',
    'button[aria-labelledby="model-label"]',
    'button[aria-description="Model picker"]',
    'button[aria-describedby="model-help"]',
    'button[aria-details="model-details"]',
    'button[aria-errormessage="model-error"]',
    'button[aria-placeholder="Choose a model"]',
    'button[aria-roledescription="Model picker"]',
    'button[aria-valuetext="Selected model"]',
    'button[title="Model"]',
    'input[placeholder="Choose a model"]',
    'img[alt="Model"]',
    'option[label="Model"]',
    'input[value="Model"]',
  ]) {
    const invalid = cloneDefinitionInput('grok')
    Reflect.set(invalid.locators, 'modelTrigger', [invalidCandidate])
    assert.throws(
      () => defineProvider(invalid),
      /grok\.locators\.modelTrigger contains an invalid CSS candidate/
    )
  }
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
  switch (provider) {
    case 'chatgpt':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.chatgpt.models,
        capabilities: PROVIDER_DEFINITIONS.chatgpt.capabilities,
        locators: PROVIDER_DEFINITIONS.chatgpt.locators,
      })
    case 'gemini':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.gemini.models,
        capabilities: PROVIDER_DEFINITIONS.gemini.capabilities,
        locators: PROVIDER_DEFINITIONS.gemini.locators,
      })
    case 'deepseek':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.deepseek.models,
        capabilities: PROVIDER_DEFINITIONS.deepseek.capabilities,
        locators: PROVIDER_DEFINITIONS.deepseek.locators,
      })
    case 'doubao':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.doubao.models,
        capabilities: PROVIDER_DEFINITIONS.doubao.capabilities,
        locators: PROVIDER_DEFINITIONS.doubao.locators,
      })
    case 'grok':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.grok.models,
        capabilities: PROVIDER_DEFINITIONS.grok.capabilities,
        locators: PROVIDER_DEFINITIONS.grok.locators,
      })
    case 'glm':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.glm.models,
        capabilities: PROVIDER_DEFINITIONS.glm.capabilities,
        locators: PROVIDER_DEFINITIONS.glm.locators,
      })
    case 'qwen':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.qwen.models,
        capabilities: PROVIDER_DEFINITIONS.qwen.capabilities,
        locators: PROVIDER_DEFINITIONS.qwen.locators,
      })
    case 'kimi':
      return structuredClone({
        provider,
        models: PROVIDER_DEFINITIONS.kimi.models,
        capabilities: PROVIDER_DEFINITIONS.kimi.capabilities,
        locators: PROVIDER_DEFINITIONS.kimi.locators,
      })
  }
}

function assertProviderDefinitionNarrowing(
  definition: import('../../src/providers/provider-definition-pack.ts').ProviderDefinition
): void {
  // @ts-expect-error Provider-specific locator slots require provider narrowing.
  void definition.locators.capabilityGroup
  if (definition.provider === 'chatgpt') {
    void definition.locators.capabilityGroup
    // @ts-expect-error ChatGPT does not expose Kimi locator slots.
    void definition.locators.searchPopover
  }
}

void assertProviderDefinitionNarrowing
