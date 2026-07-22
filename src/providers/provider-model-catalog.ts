import type { ProviderId } from './provider-id.ts'

type ModelOptionTarget =
  | { readonly kind: 'menu_position'; readonly position: number }
  | { readonly kind: 'suffix'; readonly value: 'extended' }

interface ProviderModelDefinition {
  readonly position: number
  readonly options?: Readonly<Record<string, ModelOptionTarget>>
}

type ProviderModelCatalog = Readonly<
  Record<ProviderId, Readonly<Record<string, ProviderModelDefinition>>>
>

export interface ResolvedProviderModel {
  readonly key: string
  readonly option: string | null
  readonly adapterValue: string
}

export class ProviderModelSelectionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderModelSelectionError'
  }
}

const MODEL_CATALOG = {
  chatgpt: {
    chatgpt: { position: 1 },
  },
  gemini: {
    '3.5-flash-lite': {
      position: 1,
      options: { extended: { kind: 'suffix', value: 'extended' } },
    },
    '3.6-flash': {
      position: 2,
      options: { extended: { kind: 'suffix', value: 'extended' } },
    },
    '3.1-pro': {
      position: 3,
      options: { extended: { kind: 'suffix', value: 'extended' } },
    },
  },
  deepseek: {
    quick: { position: 1 },
    expert: { position: 2 },
    vision: { position: 3 },
  },
  doubao: {
    quick: { position: 1 },
    expert: { position: 2 },
    'office-turbo': { position: 3 },
    'office-pro': { position: 4 },
  },
  grok: {
    fast: { position: 1 },
    auto: { position: 2 },
    expert: { position: 3 },
    heavy: { position: 4 },
  },
  glm: {
    'glm-5.2': { position: 1 },
    'glm-5.1': { position: 2 },
    'glm-5-turbo': { position: 3 },
    'glm-5v-turbo': { position: 4 },
    'glm-4.7': { position: 5 },
  },
  qwen: {
    'qwen3.7-plus': { position: 1 },
    'qwen3.8-max-preview': { position: 2 },
    'qwen3.7-max': { position: 3 },
  },
  kimi: {
    'k2.6': { position: 1 },
    k3: { position: 2 },
    'k3-cluster': { position: 3 },
  },
} as const satisfies ProviderModelCatalog

export function listProviderModels(provider: ProviderId): readonly string[] {
  return Object.keys(MODEL_CATALOG[provider])
}

export function listProviderModelOptions(
  provider: ProviderId,
  model: string
): readonly string[] {
  const definition = getModelDefinition(provider, model)
  return definition === null ? [] : Object.keys(definition.options ?? {})
}

export function resolveProviderModel(
  provider: ProviderId,
  model: string | null,
  option: string | null = null
): ResolvedProviderModel | null {
  if (model === null) {
    if (option !== null) {
      throw new ProviderModelSelectionError(
        `${provider} model option "${option}" requires a model.`
      )
    }
    return null
  }

  const key = normalizeKey(model)
  const definition = getModelDefinition(provider, key)
  if (definition === null) {
    throw new ProviderModelSelectionError(
      `${provider} does not support model "${model}". Available models: ${listProviderModels(provider).join(', ')}.`
    )
  }

  if (option === null) {
    return {
      key,
      option: null,
      adapterValue: String(definition.position),
    }
  }

  const optionKey = normalizeKey(option)
  const target = definition.options?.[optionKey]
  if (target === undefined) {
    const available = Object.keys(definition.options ?? {})
    throw new ProviderModelSelectionError(
      available.length === 0
        ? `${provider} model "${key}" does not support model options.`
        : `${provider} model "${key}" does not support option "${option}". Available options: ${available.join(', ')}.`
    )
  }

  const suffix =
    target.kind === 'menu_position' ? String(target.position) : target.value
  return {
    key,
    option: optionKey,
    adapterValue: `${definition.position}+${suffix}`,
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

function getModelDefinition(
  provider: ProviderId,
  model: string
): ProviderModelDefinition | null {
  const normalized = normalizeKey(model)
  const definitions: Readonly<Record<string, ProviderModelDefinition>> =
    MODEL_CATALOG[provider]
  return definitions[normalized] ?? null
}
