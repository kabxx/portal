import { FIRST_PARTY_PROVIDER_IDS } from '../../src/providers/first-party-provider-id.ts'
import {
  listProviderModelOptions,
  listProviderModels,
  resolveProviderModel,
} from '../../src/providers/provider-model-catalog.ts'
import type { ProviderContribution } from '../../src/providers/provider-exchange.ts'
import type { ProviderHost } from '../../src/providers/provider-host.ts'
import { ProviderHostError } from '../../src/providers/provider-host.ts'

export function createTestProviderHost(): ProviderHost {
  const contributions: readonly ProviderContribution[] = Object.freeze(
    FIRST_PARTY_PROVIDER_IDS.map((id) =>
      Object.freeze({
        id,
        descriptor: Object.freeze({
          label: id,
          aliases: Object.freeze([]),
          models: Object.freeze(
            listProviderModels(id).map((key) =>
              Object.freeze({
                key,
                options: Object.freeze(listProviderModelOptions(id, key)),
              })
            )
          ),
          capabilities: Object.freeze([]),
        }),
        endpointBindingId: `${id}.endpoint`,
        conversationUrlBindingId: `${id}.conversation-url`,
      })
    )
  )
  const host = {
    list: () => contributions,
    resolveProviderId: (value: string) => normalizeProviderId(value),
    resolveModel: (
      provider: string,
      model: string | null,
      option: string | null
    ) => {
      try {
        const providerId = normalizeProviderId(provider)
        if (providerId === null)
          throw new ProviderHostError(`Unknown Provider: ${provider}.`)
        return resolveProviderModel(providerId, model, option)
      } catch (error) {
        throw new ProviderHostError(String(error))
      }
    },
  }
  // Test-only structural stand-in for the graph-backed ProviderHost.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return host as unknown as ProviderHost
}

function normalizeProviderId(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    FIRST_PARTY_PROVIDER_IDS.find((provider) => provider === normalized) ?? null
  )
}
