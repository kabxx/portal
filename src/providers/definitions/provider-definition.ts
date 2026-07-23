import { PROVIDER_IDS, type ProviderId } from '../provider-id.ts'

export type ProviderModelOptionDefinition = {
  readonly key: string
}

export type ProviderModelDefinition = {
  readonly key: string
  readonly options: readonly ProviderModelOptionDefinition[]
}

type ActionCapabilityDefinition = {
  readonly key: string
  readonly description: string
  readonly kind: 'action'
}

type ToggleCapabilityDefinition = {
  readonly key: string
  readonly description: string
  readonly kind: 'toggle'
}

export type ProviderCapabilityDefinitionFor<P extends ProviderId> = P extends
  | 'chatgpt'
  | 'qwen'
  ? ActionCapabilityDefinition
  : P extends 'deepseek' | 'glm' | 'kimi'
    ? ToggleCapabilityDefinition
    : never

export type ProviderCapabilityDefinition = {
  [P in ProviderId]: ProviderCapabilityDefinitionFor<P>
}[ProviderId]

type ProviderDefinitionInputShape<P extends ProviderId> = {
  readonly provider: P
  readonly models: readonly (Omit<ProviderModelDefinition, 'options'> & {
    readonly options?: readonly ProviderModelOptionDefinition[]
  })[]
  readonly capabilities: readonly ProviderCapabilityDefinitionFor<P>[]
}

export type ProviderDefinitionInput<P extends ProviderId = ProviderId> =
  P extends ProviderId ? ProviderDefinitionInputShape<P> : never

type ProviderDefinitionShape<P extends ProviderId> = {
  readonly provider: P
  readonly models: readonly ProviderModelDefinition[]
  readonly capabilities: readonly ProviderCapabilityDefinitionFor<P>[]
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
    provider: input.provider,
    models: input.models.map((model) => ({
      key: model.key,
      options: (model.options ?? []).map((option) => ({ key: option.key })),
    })),
    capabilities: input.capabilities.map((capability) => ({ ...capability })),
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

function validateProviderDefinition<P extends ProviderId>(
  input: ProviderDefinitionInputShape<P>
): void {
  assertOnlyObjectKeys(
    input,
    ['provider', 'models', 'capabilities'],
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
  for (const model of input.models) {
    assertOnlyObjectKeys(
      model,
      ['key', 'options'],
      `${input.provider}.models.${model.key}`
    )
    assertPublicKey(model.key, `${input.provider}.models.${model.key}.key`)
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
    for (const option of options) {
      assertOnlyObjectKeys(
        option,
        ['key'],
        `${input.provider}.models.${model.key}.options.${option.key}`
      )
      assertPublicKey(
        option.key,
        `${input.provider}.models.${model.key}.options.${option.key}.key`
      )
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
      ['key', 'description', 'kind'],
      `${input.provider}.capabilities.${capability.key}`
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
    if (capability.kind !== expectedCapabilityKind(input.provider)) {
      throw new ProviderDefinitionError(
        `${input.provider}.capabilities.${capability.key} uses an unsupported kind.`
      )
    }
    if (capability.kind === 'action' && capability.key === 'none') {
      throw new ProviderDefinitionError(
        `${input.provider}.capabilities action key "none" is reserved.`
      )
    }
  }
}

function expectedCapabilityKind(
  provider: ProviderId
): 'action' | 'toggle' | null {
  if (provider === 'chatgpt' || provider === 'qwen') {
    return 'action'
  }
  if (provider === 'deepseek' || provider === 'glm' || provider === 'kimi') {
    return 'toggle'
  }
  return null
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
  return Object.freeze(value)
}
