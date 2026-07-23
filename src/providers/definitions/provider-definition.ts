import { PROVIDER_IDS, type ProviderId } from '../provider-id.ts'

export const PROVIDER_DEFINITION_VERSION = 1 as const

export type LocatorCandidates = readonly [string, ...string[]]

export const PROVIDER_LOCATOR_SLOTS = {
  chatgpt: [
    'modelTrigger',
    'modelDirectMenu',
    'modelPicker',
    'modelDirectItem',
    'modelModeItem',
    'modelMenuItem',
    'modelItem',
    'capabilityTrigger',
    'capabilityGroup',
  ],
  gemini: [
    'modelTrigger',
    'modelMenu',
    'modelItem',
    'toolsMenuTrigger',
    'capabilityItem',
    'capabilityIcon',
    'moreToolsTrigger',
    'selectedCapability',
  ],
  deepseek: ['modelItem', 'capabilityToggle'],
  doubao: [
    'modelTrigger',
    'modelMenu',
    'capabilityToolbar',
    'selectedCapability',
    'capabilityOverflowPopover',
  ],
  grok: ['modelTrigger', 'modelMenu'],
  glm: [
    'modelTrigger',
    'modelMenu',
    'modelItem',
    'advancedSearchSwitch',
    'thinkingToggle',
    'searchToggle',
  ],
  qwen: [
    'modelTrigger',
    'modelListbox',
    'modelItem',
    'capabilityTrigger',
    'capabilityMenu',
    'capabilityItem',
    'capabilitySubmenu',
    'selectedCapability',
    'selectedCapabilityIcon',
    'selectedCapabilityClose',
    'capabilityItemIcon',
  ],
  kimi: [
    'modelTrigger',
    'modelMenu',
    'modelItem',
    'capabilityTrigger',
    'capabilityPopover',
    'searchItem',
    'searchPopover',
    'searchOption',
    'selectedOptionIcon',
  ],
} as const satisfies Record<ProviderId, readonly string[]>

type LocatorSlot<P extends ProviderId> =
  (typeof PROVIDER_LOCATOR_SLOTS)[P][number]

export type ProviderLocatorDefinitions<P extends ProviderId> =
  P extends ProviderId
    ? Readonly<{
        [S in LocatorSlot<P>]: LocatorCandidates
      }>
    : never

type MenuPositionTarget = {
  readonly kind: 'menu_position'
  readonly position: number
}

type SuffixTarget = {
  readonly kind: 'suffix'
  readonly value: string
}

type ModelOptionTargetFor<P extends ProviderId> = P extends 'chatgpt'
  ? MenuPositionTarget
  : P extends 'gemini'
    ? SuffixTarget
    : never

export type ProviderModelOptionDefinition<P extends ProviderId = ProviderId> = {
  readonly key: string
  readonly target: ModelOptionTargetFor<P>
}

export type ProviderModelDefinition<P extends ProviderId = ProviderId> = {
  readonly key: string
  readonly position: number
  readonly options: readonly ProviderModelOptionDefinition<P>[]
}

type AdapterCapabilityTarget = {
  readonly kind: 'adapter_capability'
  readonly value: 'thinking' | 'search' | 'advanced_search'
}

type MenuIdTarget = {
  readonly kind: 'menu_id'
  readonly value: string
  readonly scope: 'root' | 'nested'
}

type ActionCapability<TTarget extends MenuPositionTarget | MenuIdTarget> = {
  readonly key: string
  readonly description: string
  readonly kind: 'action'
  readonly target: TTarget
}

type ToggleCapability = {
  readonly key: string
  readonly description: string
  readonly kind: 'toggle'
  readonly target: AdapterCapabilityTarget
}

export type ProviderCapabilityDefinitionFor<P extends ProviderId> =
  P extends 'chatgpt'
    ? ActionCapability<MenuPositionTarget>
    : P extends 'qwen'
      ? ActionCapability<MenuIdTarget>
      : P extends 'deepseek' | 'glm' | 'kimi'
        ? ToggleCapability
        : never

export type ProviderCapabilityDefinition = {
  [P in ProviderId]: ProviderCapabilityDefinitionFor<P>
}[ProviderId]

type ProviderDefinitionInputShape<P extends ProviderId> = {
  readonly provider: P
  readonly models: readonly (Omit<ProviderModelDefinition<P>, 'options'> & {
    readonly options?: readonly ProviderModelOptionDefinition<P>[]
  })[]
  readonly capabilities: readonly ProviderCapabilityDefinitionFor<P>[]
  readonly locators: ProviderLocatorDefinitions<P>
}

export type ProviderDefinitionInput<P extends ProviderId = ProviderId> =
  P extends ProviderId ? ProviderDefinitionInputShape<P> : never

type ProviderDefinitionShape<P extends ProviderId> = {
  readonly schemaVersion: typeof PROVIDER_DEFINITION_VERSION
  readonly provider: P
  readonly models: readonly ProviderModelDefinition<P>[]
  readonly capabilities: readonly ProviderCapabilityDefinitionFor<P>[]
  readonly locators: ProviderLocatorDefinitions<P>
}

export type ProviderDefinition<P extends ProviderId = ProviderId> =
  P extends ProviderId ? ProviderDefinitionShape<P> : never

export type ProviderDefinitionPack = Readonly<{
  [P in ProviderId]: ProviderDefinition<P>
}>

export class ProviderDefinitionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderDefinitionError'
  }
}

export function defineProvider<P extends ProviderId>(
  input: ProviderDefinitionInputShape<P>
): ProviderDefinitionShape<P> {
  validateProviderDefinition(input)
  return deepFreeze({
    schemaVersion: PROVIDER_DEFINITION_VERSION,
    provider: input.provider,
    models: [...input.models]
      .sort((left, right) => left.position - right.position)
      .map((model) => ({
        key: model.key,
        position: model.position,
        options: (model.options ?? []).map((option) => ({
          key: option.key,
          target: { ...option.target },
        })),
      })),
    capabilities: input.capabilities.map((capability) => ({
      ...capability,
      target: { ...capability.target },
    })),
    locators: structuredClone(input.locators),
  })
}

export function defineProviderPack(
  definitions: ProviderDefinitionPack
): ProviderDefinitionPack {
  const keys = Object.keys(definitions).sort()
  const expected = [...PROVIDER_IDS].sort()
  if (keys.join('\0') !== expected.join('\0')) {
    throw new ProviderDefinitionError(
      `Provider definition pack must contain exactly: ${PROVIDER_IDS.join(', ')}.`
    )
  }
  for (const provider of PROVIDER_IDS) {
    if (definitions[provider].provider !== provider) {
      throw new ProviderDefinitionError(
        `Provider definition key ${provider} does not match its provider field.`
      )
    }
  }
  return deepFreeze({ ...definitions })
}

export function joinCssLocatorCandidates(
  candidates: LocatorCandidates,
  suffix = ''
): string {
  return mapCssLocatorCandidates(
    candidates,
    (candidate) => `${candidate}${suffix}`
  )
}

export function mapCssLocatorCandidates(
  candidates: LocatorCandidates,
  transform: (candidate: string) => string
): string {
  return candidates.map(transform).join(', ')
}

function validateProviderDefinition<P extends ProviderId>(
  input: ProviderDefinitionInputShape<P>
): void {
  assertOnlyObjectKeys(
    input,
    ['provider', 'models', 'capabilities', 'locators'],
    'provider definition'
  )
  if (!PROVIDER_IDS.includes(input.provider)) {
    throw new ProviderDefinitionError(`Unknown provider: ${input.provider}.`)
  }
  assertRuntimeArray(input.models, `${input.provider}.models`)
  if (input.models.length === 0 || input.models.length > 32) {
    throw new ProviderDefinitionError(
      `${input.provider}.models must contain 1-32 entries.`
    )
  }
  assertUnique(input.models, (model) => model.key, input.provider, 'models.key')
  assertUnique(
    input.models,
    (model) => String(model.position),
    input.provider,
    'models.position'
  )
  const positions = input.models
    .map((model) => model.position)
    .sort((left, right) => left - right)
  if (positions.some((position, index) => position !== index + 1)) {
    throw new ProviderDefinitionError(
      `${input.provider}.models.position must be consecutive from 1.`
    )
  }
  for (const model of input.models) {
    assertOnlyObjectKeys(
      model,
      ['key', 'position', 'options'],
      `${input.provider}.models.${model.key}`
    )
    assertPublicKey(model.key, `${input.provider}.models.${model.key}.key`)
    assertPosition(
      model.position,
      `${input.provider}.models.${model.key}.position`
    )
    const options = model.options ?? []
    assertRuntimeArray(options, `${input.provider}.models.${model.key}.options`)
    if (options.length > 32) {
      throw new ProviderDefinitionError(
        `${input.provider}.models.${model.key}.options must contain at most 32 entries.`
      )
    }
    assertUnique(
      options,
      (option) => option.key,
      input.provider,
      `models.${model.key}.options.key`
    )
    assertUnique(
      options,
      (option) => serializeTarget(option.target),
      input.provider,
      `models.${model.key}.options.target`
    )
    for (const option of options) {
      assertOnlyObjectKeys(
        option,
        ['key', 'target'],
        `${input.provider}.models.${model.key}.options.${option.key}`
      )
      assertOnlyObjectKeys(
        option.target,
        option.target.kind === 'menu_position'
          ? ['kind', 'position']
          : ['kind', 'value'],
        `${input.provider}.models.${model.key}.options.${option.key}.target`
      )
      assertPublicKey(
        option.key,
        `${input.provider}.models.${model.key}.options.key`
      )
      if (option.target.kind === 'menu_position') {
        assertPosition(
          option.target.position,
          `${input.provider}.models.${model.key}.options.${option.key}.target.position`
        )
      } else {
        assertPublicKey(
          option.target.value,
          `${input.provider}.models.${model.key}.options.${option.key}.target.value`
        )
      }
    }
  }
  assertRuntimeArray(input.capabilities, `${input.provider}.capabilities`)
  if (input.capabilities.length > 64) {
    throw new ProviderDefinitionError(
      `${input.provider}.capabilities must contain at most 64 entries.`
    )
  }
  assertUnique(
    input.capabilities,
    (capability) => capability.key,
    input.provider,
    'capabilities.key'
  )
  for (const capability of input.capabilities) {
    assertOnlyObjectKeys(
      capability,
      ['key', 'description', 'kind', 'target'],
      `${input.provider}.capabilities.${capability.key}`
    )
    assertOnlyObjectKeys(
      capability.target,
      capability.target.kind === 'menu_position'
        ? ['kind', 'position']
        : capability.target.kind === 'menu_id'
          ? ['kind', 'value', 'scope']
          : ['kind', 'value'],
      `${input.provider}.capabilities.${capability.key}.target`
    )
    assertPublicKey(
      capability.key,
      `${input.provider}.capabilities.${capability.key}.key`
    )
    if (
      typeof capability.description !== 'string' ||
      capability.description.length === 0 ||
      capability.description.length > 200
    ) {
      throw new ProviderDefinitionError(
        `${input.provider}.capabilities.${capability.key}.description must contain 1-200 characters.`
      )
    }
    if (capability.target.kind === 'menu_position') {
      assertPosition(
        capability.target.position,
        `${input.provider}.capabilities.${capability.key}.target.position`
      )
    } else if (capability.target.kind === 'menu_id') {
      assertPublicKey(
        capability.target.value,
        `${input.provider}.capabilities.${capability.key}.target.value`
      )
      if (
        capability.target.scope !== 'root' &&
        capability.target.scope !== 'nested'
      ) {
        throw new ProviderDefinitionError(
          `${input.provider}.capabilities.${capability.key}.target.scope must be root or nested.`
        )
      }
    }
  }
  assertUnique(
    input.capabilities,
    (capability) => serializeTarget(capability.target),
    input.provider,
    'capabilities.target'
  )
  validateCapabilityContract(input)
  validateLocatorContract(input)
}

function validateCapabilityContract<P extends ProviderId>(
  input: ProviderDefinitionInputShape<P>
): void {
  const expected =
    input.provider === 'chatgpt'
      ? { kind: 'action', target: 'menu_position' }
      : input.provider === 'qwen'
        ? { kind: 'action', target: 'menu_id' }
        : input.provider === 'deepseek' ||
            input.provider === 'glm' ||
            input.provider === 'kimi'
          ? { kind: 'toggle', target: 'adapter_capability' }
          : null

  if (expected === null && input.capabilities.length > 0) {
    throw new ProviderDefinitionError(
      `${input.provider}.capabilities must be empty because its capabilities are discovered at runtime or unsupported.`
    )
  }
  for (const capability of input.capabilities) {
    if (
      capability.kind !== expected?.kind ||
      capability.target.kind !== expected?.target
    ) {
      throw new ProviderDefinitionError(
        `${input.provider}.capabilities.${capability.key} uses an unsupported target.`
      )
    }
    if (capability.kind === 'action' && capability.key === 'none') {
      throw new ProviderDefinitionError(
        `${input.provider}.capabilities action key "none" is reserved.`
      )
    }
    if (capability.kind === 'toggle') {
      const supported =
        input.provider === 'deepseek'
          ? capability.target.value === 'thinking' ||
            capability.target.value === 'search'
          : input.provider === 'glm'
            ? capability.target.value === 'thinking' ||
              capability.target.value === 'search' ||
              capability.target.value === 'advanced_search'
            : input.provider === 'kimi'
              ? capability.target.value === 'search'
              : false
      if (!supported) {
        throw new ProviderDefinitionError(
          `${input.provider}.capabilities.${capability.key} target "${capability.target.value}" is not supported.`
        )
      }
    }
  }
  for (const model of input.models) {
    for (const option of model.options ?? []) {
      const supported =
        (input.provider === 'chatgpt' &&
          option.target.kind === 'menu_position') ||
        (input.provider === 'gemini' &&
          option.target.kind === 'suffix' &&
          option.target.value === 'extended')
      if (!supported) {
        throw new ProviderDefinitionError(
          `${input.provider}.models.${model.key}.options.${option.key} is not supported.`
        )
      }
    }
  }
}

function validateLocatorContract<P extends ProviderId>(
  input: ProviderDefinitionInputShape<P>
): void {
  const expected = PROVIDER_LOCATOR_SLOTS[input.provider]
  const actual = Object.keys(input.locators).sort()
  const expectedSorted = [...expected].sort()
  if (actual.join('\0') !== expectedSorted.join('\0')) {
    throw new ProviderDefinitionError(
      `${input.provider}.locators must contain exactly: ${expected.join(', ')}.`
    )
  }
  const locatorRecord: Readonly<Record<string, unknown>> = input.locators
  for (const [slot, value] of Object.entries(locatorRecord)) {
    const candidates = readLocatorCandidates(
      value,
      `${input.provider}.locators.${slot}`
    )
    if (candidates.length === 0 || candidates.length > 8) {
      throw new ProviderDefinitionError(
        `${input.provider}.locators.${slot} must contain 1-8 candidates.`
      )
    }
    assertUnique(
      candidates,
      (candidate) => candidate,
      input.provider,
      `locators.${slot}`
    )
    for (const candidate of candidates) {
      const trimmed = candidate.trim()
      if (
        trimmed === '' ||
        candidate.length > 512 ||
        /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?=/i.test(trimmed) ||
        /^(?:\/\/|\.\.|\(\s*\/\/)/.test(trimmed) ||
        candidate.includes(',') ||
        candidate.includes('>>') ||
        candidate.includes('\\') ||
        /\[\s*(?:aria-(?:label|labelledby|description|describedby|details|errormessage|placeholder|roledescription|valuetext)|title|alt|label|placeholder|value)\b/i.test(
          candidate
        ) ||
        /:(?:visible|has-text|text|text-is|text-matches|nth-match|light|near|right-of|left-of|above|below)(?:\(|\b)/.test(
          candidate
        )
      ) {
        throw new ProviderDefinitionError(
          `${input.provider}.locators.${slot} contains an invalid CSS candidate.`
        )
      }
    }
  }
}

function assertPublicKey(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value) ||
    /^\d+$/.test(value)
  ) {
    throw new ProviderDefinitionError(`${field} must be a public key.`)
  }
}

function assertOnlyObjectKeys(
  value: unknown,
  allowed: readonly string[],
  field: string
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderDefinitionError(`${field} must be an object.`)
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new ProviderDefinitionError(
      `${field} contains unknown fields: ${unexpected.sort().join(', ')}.`
    )
  }
}

function assertRuntimeArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new ProviderDefinitionError(`${field} must be an array.`)
  }
}

function readLocatorCandidates(
  value: unknown,
  field: string
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ProviderDefinitionError(`${field} must be an array.`)
  }
  const candidates: unknown[] = value
  if (!candidates.every((candidate) => typeof candidate === 'string')) {
    throw new ProviderDefinitionError(`${field} must contain CSS strings.`)
  }
  return candidates
}

function assertPosition(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ProviderDefinitionError(`${field} must be an integer from 1-100.`)
  }
}

function assertUnique<T>(
  values: readonly T[],
  select: (value: T) => string,
  provider: string,
  field: string
): void {
  const seen = new Set<string>()
  for (const value of values) {
    const selected = select(value)
    if (seen.has(selected)) {
      throw new ProviderDefinitionError(
        `${provider}.${field} contains duplicate value "${selected}".`
      )
    }
    seen.add(selected)
  }
}

function serializeTarget(
  target:
    | MenuPositionTarget
    | SuffixTarget
    | AdapterCapabilityTarget
    | MenuIdTarget
): string {
  switch (target.kind) {
    case 'menu_position':
      return `menu_position:${target.position}`
    case 'suffix':
      return `suffix:${target.value}`
    case 'adapter_capability':
      return `adapter_capability:${target.value}`
    case 'menu_id':
      return `menu_id:${target.scope}:${target.value}`
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}
