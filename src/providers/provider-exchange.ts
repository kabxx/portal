import { z } from 'zod'

import type {
  Capability,
  ContributionSpec,
  ExecutableBindingSpec,
  ServiceAccessor,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'
import type { AttachmentRef } from '../attachments/attachment-contracts.ts'
import type { ResolvedProviderModel } from './provider-model-catalog.ts'
import type { RuntimeSetupMode } from '../runtime/setup-handshake.ts'
import type { ConversationHistoryResult } from './conversation-history.ts'
import { promptSkillService } from '../skills/skill-services.ts'

export const PROVIDER_ATTACHMENT_CAPABILITY = 'portal.provider.attachments'

export interface ProviderToolCall {
  readonly toolCallId: string
  readonly name: string
  readonly input: Record<string, unknown> | string
}

export interface ProviderMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolCallId?: string
  readonly toolCalls?: readonly ProviderToolCall[]
  readonly toolName?: string
  readonly toolResult?: {
    readonly status: 'success' | 'error' | 'unknown'
    readonly output: Record<string, unknown>
    readonly displayText?: string
  }
}

export interface ProviderOutboundLeg {
  readonly exchangeId: string
  readonly conversationId: string
  readonly messages: readonly ProviderMessage[]
  readonly attachments: readonly AttachmentRef[]
}

export type ProviderEvent =
  | { readonly type: 'text.delta'; readonly text: string }
  | {
      readonly type: 'tool.request'
      readonly toolCallId: string
      readonly name: string
      readonly input: Record<string, unknown> | string
    }
  | {
      readonly type: 'attention.request'
      readonly requestId: string
      readonly kind: 'login' | 'human-input' | 'account'
      readonly prompt: string
    }
  | { readonly type: 'status'; readonly message: string }

export type ProviderCompletion =
  | {
      readonly status: 'completed'
      readonly text: string
      readonly delivery: 'not-sent' | 'sent' | 'unknown'
    }
  | {
      readonly status: 'failed' | 'canceled'
      readonly message: string
      readonly delivery: 'not-sent' | 'sent' | 'unknown'
    }

export interface ProviderExchangeHandle {
  readonly events: AsyncIterable<ProviderEvent>
  readonly completion: Promise<ProviderCompletion>
  cancel(reason?: unknown): void | Promise<void>
}

export interface ProviderEndpointContext {
  readonly exchangeId: string
  readonly signal: AbortSignal
  readonly scope: { readonly name: string; readonly signal: AbortSignal }
  readonly readAttachment: (ref: AttachmentRef) => Promise<Uint8Array>
}

export interface ProviderCapabilityCatalog {
  readonly capabilities: readonly {
    readonly name: string
    readonly state: string
  }[]
  readonly usage: string
}

export interface ProviderCapabilityResult {
  readonly status:
    'ok' | 'invalid-args' | 'unknown-capability' | 'unsupported-provider'
  readonly message: string
}

export interface ProviderSessionControl {
  preflightInput(
    input: string,
    signal?: AbortSignal
  ): Promise<{
    readonly status: 'unknown' | 'within_limit' | 'over_limit'
  }>
  restore(signal?: AbortSignal): Promise<void>
  loadHistory(signal?: AbortSignal): Promise<ConversationHistoryResult>
  onUnexpectedClose(listener: () => void): () => void
  listCapabilities(signal: AbortSignal): Promise<ProviderCapabilityCatalog>
  executeCapability(
    name: string,
    args: readonly string[],
    signal: AbortSignal
  ): Promise<ProviderCapabilityResult>
}

export interface ProviderEndpoint {
  (
    input: ProviderOutboundLeg,
    context: ProviderEndpointContext
  ): ProviderExchangeHandle | Promise<ProviderExchangeHandle>
  close?(reason?: unknown): void | Promise<void>
  readonly conversationId?: string | null
  readonly conversationUrl?: string
  readonly session?: ProviderSessionControl
}

export type ProviderEndpointFactory = (context: {
  readonly providerId: string
  readonly scope: { readonly name: string; readonly signal: AbortSignal }
  readonly signal: AbortSignal
  readonly readAttachment: (ref: AttachmentRef) => Promise<Uint8Array>
  readonly services: ServiceAccessor
  readonly conversationUrl: string | null
  readonly model: ResolvedProviderModel | null
  readonly setupMode: RuntimeSetupMode
  readonly workingDirectory: string
  readonly spawnDepth: number
  readonly sessionKey: string | null
  readonly emit: (event: ProviderEvent) => void | Promise<void>
}) => ProviderEndpoint | Promise<ProviderEndpoint>

export interface ProviderContribution {
  readonly id: string
  readonly descriptor: {
    readonly label: string
    readonly aliases: readonly string[]
    readonly models: readonly {
      readonly key: string
      readonly options: readonly string[]
    }[]
    readonly capabilities: readonly Capability[]
  }
  readonly endpointBindingId: string
  readonly conversationUrlBindingId: string
}

export type ProviderConversationUrlResolver = (value: string) => string | null

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)
const providerContributionSchema = z
  .object({
    id: stableId,
    descriptor: z
      .object({
        label: z.string().trim().min(1),
        aliases: z.array(stableId),
        models: z.array(
          z
            .object({
              key: stableId,
              options: z.array(stableId),
            })
            .strict()
        ),
        capabilities: z.array(stableId),
      })
      .strict(),
    endpointBindingId: stableId,
    conversationUrlBindingId: stableId,
  })
  .strict()

export const providerContributions =
  createContributionRef<ProviderContribution>({
    id: 'providers.collect',
    version: 1,
  })

export const providerEndpointBindings =
  createExecutableBindingRef<ProviderEndpointFactory>({
    id: 'providers.endpoint-factories',
    version: 1,
    kind: 'provider-endpoint',
  })

export function createProviderContributionSpec(
  additionalAllowedServices: readonly import('../extensions/extension-contracts.ts').ServiceRef<unknown>[] = []
): ContributionSpec<ProviderContribution> {
  return Object.freeze({
    ref: providerContributions,
    schema: Object.freeze({
      parse(value: unknown): ProviderContribution {
        const parsed = providerContributionSchema.parse(value)
        if (
          new Set(parsed.descriptor.capabilities).size !==
          parsed.descriptor.capabilities.length
        ) {
          throw new TypeError(
            'Provider capabilities must not contain duplicates.'
          )
        }
        if (
          new Set(parsed.descriptor.aliases).size !==
            parsed.descriptor.aliases.length ||
          new Set(parsed.descriptor.models.map(({ key }) => key)).size !==
            parsed.descriptor.models.length ||
          parsed.descriptor.models.some(
            ({ options }) => new Set(options).size !== options.length
          )
        ) {
          throw new TypeError(
            'Provider aliases, models, and model options must not contain duplicates.'
          )
        }
        return Object.freeze({
          id: parsed.id,
          descriptor: Object.freeze({
            label: parsed.descriptor.label,
            aliases: Object.freeze([...parsed.descriptor.aliases]),
            models: Object.freeze(
              parsed.descriptor.models.map(({ key, options }) =>
                Object.freeze({ key, options: Object.freeze([...options]) })
              )
            ),
            capabilities: Object.freeze([...parsed.descriptor.capabilities]),
          }),
          endpointBindingId: parsed.endpointBindingId,
          conversationUrlBindingId: parsed.conversationUrlBindingId,
        })
      },
    }),
    identityOf: (value: ProviderContribution) => value.id,
    conflictKeyOf: (value: ProviderContribution) => value.id,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([
      promptSkillService,
      ...additionalAllowedServices,
    ]),
    allowedCapabilities: Object.freeze([]),
  })
}

export const providerContributionSpec = createProviderContributionSpec()

export const providerEndpointBindingSpec: ExecutableBindingSpec<ProviderEndpointFactory> =
  Object.freeze({
    ref: providerEndpointBindings,
    targetContribution: providerContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: ProviderEndpointFactory) {
      if (typeof binding !== 'function') {
        throw new TypeError('Provider endpoint binding must be a function.')
      }
      return binding
    },
  })

export const providerConversationUrlBindings =
  createExecutableBindingRef<ProviderConversationUrlResolver>({
    id: 'providers.conversation-url-resolvers',
    version: 1,
    kind: 'provider-conversation-url-resolver',
  })

export const providerConversationUrlBindingSpec: ExecutableBindingSpec<ProviderConversationUrlResolver> =
  Object.freeze({
    ref: providerConversationUrlBindings,
    targetContribution: providerContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: ProviderConversationUrlResolver) {
      if (typeof binding !== 'function') {
        throw new TypeError(
          'Provider conversation URL resolver must be a function.'
        )
      }
      return binding
    },
  })

export function defineProviderHost(
  registry: ExtensionRegistry,
  options: {
    readonly allowedServices?: readonly import('../extensions/extension-contracts.ts').ServiceRef<unknown>[]
  } = {}
): void {
  registry.defineService(promptSkillService)
  for (const service of options.allowedServices ?? []) {
    registry.defineService(service)
  }
  registry.defineContribution(
    createProviderContributionSpec(options.allowedServices ?? [])
  )
  registry.defineExecutableBinding(providerEndpointBindingSpec)
  registry.defineExecutableBinding(providerConversationUrlBindingSpec)
}
