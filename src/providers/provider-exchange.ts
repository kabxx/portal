import { z } from 'zod'

import type {
  Capability,
  ContributionSpec,
  ExecutableBindingSpec,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'
import type { AttachmentRef } from '../attachments/attachment-contracts.ts'

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

export interface ProviderEndpoint {
  (
    input: ProviderOutboundLeg,
    context: ProviderEndpointContext
  ): ProviderExchangeHandle | Promise<ProviderExchangeHandle>
  close?(reason?: unknown): void | Promise<void>
}

export type ProviderEndpointFactory = (context: {
  readonly providerId: string
  readonly scope: { readonly name: string; readonly signal: AbortSignal }
  readonly signal: AbortSignal
  readonly readAttachment: (ref: AttachmentRef) => Promise<Uint8Array>
}) => ProviderEndpoint | Promise<ProviderEndpoint>

export interface ProviderContribution {
  readonly id: string
  readonly descriptor: {
    readonly label: string
    readonly capabilities: readonly Capability[]
  }
  readonly endpointBindingId: string
}

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)
const providerContributionSchema = z
  .object({
    id: stableId,
    descriptor: z
      .object({
        label: z.string().trim().min(1),
        capabilities: z.array(stableId),
      })
      .strict(),
    endpointBindingId: stableId,
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

export const providerContributionSpec: ContributionSpec<ProviderContribution> =
  Object.freeze({
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
        return Object.freeze({
          id: parsed.id,
          descriptor: Object.freeze({
            label: parsed.descriptor.label,
            capabilities: Object.freeze([...parsed.descriptor.capabilities]),
          }),
          endpointBindingId: parsed.endpointBindingId,
        })
      },
    }),
    identityOf: (value: ProviderContribution) => value.id,
    conflictKeyOf: (value: ProviderContribution) => value.id,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([]),
    allowedCapabilities: Object.freeze([]),
  })

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

export function defineProviderHost(registry: ExtensionRegistry): void {
  registry.defineContribution(providerContributionSpec)
  registry.defineExecutableBinding(providerEndpointBindingSpec)
}
