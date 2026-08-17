import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import { getProviderDefinition } from './provider-definition-pack.ts'
import { resolveProviderConversationUrl } from './provider-conversation-url.ts'
import type { FirstPartyProviderId as ProviderId } from './first-party-provider-id.ts'
import {
  PROVIDER_ATTACHMENT_CAPABILITY,
  providerContributions,
  providerConversationUrlBindings,
  providerEndpointBindings,
  type ProviderEndpointFactory,
} from './provider-exchange.ts'
import { portalBrowserSessionService } from '../platform/browser-session-service.ts'
import { toolRuntimeService } from '../tools/tool-runtime-service.ts'
import { createWebProviderEndpointFactory } from './web-provider-endpoint.ts'

export const FIRST_PARTY_PROVIDER_PACKAGE_PREFIX = 'portal.provider.'

export function createFirstPartyProviderRegistration(
  providerId: ProviderId,
  endpointFactory: ProviderEndpointFactory = createWebProviderEndpointFactory(
    providerId
  )
): PortalExtensionRegistration {
  const packageId = `${FIRST_PARTY_PROVIDER_PACKAGE_PREFIX}${providerId}`
  const bindingId = `${packageId}.endpoint`
  const conversationUrlBindingId = `${packageId}.conversation-url`
  const definition = getProviderDefinition(providerId)
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: packageId,
    version: '1.0.0',
    dependencies: Object.freeze([]),
    capabilities: Object.freeze([PROVIDER_ATTACHMENT_CAPABILITY]),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.contribute(providerContributions, {
        id: providerId,
        value: {
          id: providerId,
          descriptor: {
            label: providerLabel(providerId),
            aliases: [],
            models: definition.models.map(({ key, options }) => ({
              key,
              options: options.map(({ key: optionKey }) => optionKey),
            })),
            capabilities: [PROVIDER_ATTACHMENT_CAPABILITY],
          },
          endpointBindingId: bindingId,
          conversationUrlBindingId,
        },
        requiredServices: Object.freeze([
          portalBrowserSessionService,
          toolRuntimeService,
        ]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(providerEndpointBindings, {
        id: bindingId,
        targetId: providerId,
        binding: endpointFactory,
      })
      api.bind(providerConversationUrlBindings, {
        id: conversationUrlBindingId,
        targetId: providerId,
        binding: (value) => resolveProviderConversationUrl(providerId, value),
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

function providerLabel(providerId: ProviderId): string {
  return providerId === 'chatgpt'
    ? 'ChatGPT'
    : providerId === 'deepseek'
      ? 'DeepSeek'
      : providerId === 'glm'
        ? 'GLM'
        : providerId.charAt(0).toUpperCase() + providerId.slice(1)
}
