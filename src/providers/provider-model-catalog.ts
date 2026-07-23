import type { ProviderId } from './provider-id.ts'
import {
  getProviderDefinition,
  type ProviderModelDefinition,
} from './provider-definition-pack.ts'

export interface ResolvedProviderModel {
  readonly key: string
  readonly option: string | null
}

export class ProviderModelSelectionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderModelSelectionError'
  }
}

export function listProviderModels(provider: ProviderId): readonly string[] {
  return getProviderDefinition(provider).models.map((model) => model.key)
}

export function listProviderModelOptions(
  provider: ProviderId,
  model: string
): readonly string[] {
  const definition = getModelDefinition(provider, model)
  return definition === null
    ? []
    : definition.options.map((option) => option.key)
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
    }
  }

  const optionKey = normalizeKey(option)
  const optionDefinition = definition.options.find(
    (candidate) => candidate.key === optionKey
  )
  if (optionDefinition === undefined) {
    const available = definition.options.map((candidate) => candidate.key)
    throw new ProviderModelSelectionError(
      available.length === 0
        ? `${provider} model "${key}" does not support model options.`
        : `${provider} model "${key}" does not support option "${option}". Available options: ${available.join(', ')}.`
    )
  }

  return {
    key,
    option: optionKey,
  }
}

export function isResolvedProviderModelSupported(
  provider: ProviderId,
  model: ResolvedProviderModel
): boolean {
  const definition = getModelDefinition(provider, model.key)
  return (
    definition !== null &&
    (model.option === null ||
      definition.options.some((option) => option.key === model.option))
  )
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

function getModelDefinition(
  provider: ProviderId,
  model: string
): ProviderModelDefinition | null {
  const normalized = normalizeKey(model)
  return (
    getProviderDefinition(provider).models.find(
      (definition) => definition.key === normalized
    ) ?? null
  )
}
