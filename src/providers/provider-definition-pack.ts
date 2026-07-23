import type { ProviderId } from './provider-id.ts'
import {
  PROVIDER_DEFINITIONS,
  type ProviderCapabilityDefinition,
  type ProviderDefinition,
} from './definitions/index.ts'

export { PROVIDER_DEFINITIONS }
export type {
  ProviderCapabilityDefinition,
  ProviderCapabilityDefinitionFor,
  ProviderDefinition,
  ProviderDefinitionInput,
  ProviderDefinitionPack,
  ProviderModelDefinition,
  ProviderModelOptionDefinition,
} from './definitions/index.ts'
export {
  defineProvider,
  defineProviderPack,
  ProviderDefinitionError,
} from './definitions/index.ts'

export function getProviderDefinition<P extends ProviderId>(
  provider: P
): ProviderDefinition<P> {
  return PROVIDER_DEFINITIONS[provider]
}

export function listProviderCapabilities(
  provider: ProviderId
): readonly ProviderCapabilityDefinition[] {
  return getProviderDefinition(provider).capabilities
}

export function getProviderCapability(
  provider: ProviderId,
  key: string
): ProviderCapabilityDefinition | null {
  const normalized = normalizeKey(key)
  return (
    listProviderCapabilities(provider).find(
      (capability) => capability.key === normalized
    ) ?? null
  )
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}
