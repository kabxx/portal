import { createFirstPartyProviderRegistration } from '../../src/providers/first-party-provider-plugin.ts'
import { FIRST_PARTY_PROVIDER_IDS } from '../../src/providers/first-party-provider-id.ts'
import type {
  ProviderCompletion,
  ProviderEndpoint,
  ProviderEndpointFactory,
  ProviderEvent,
} from '../../src/providers/provider-exchange.ts'
import type { ThreadRuntime } from '../../src/threads/thread-runtime.ts'
import type { PortalExtensionRegistration } from '../../src/extensions/portal-hooks.ts'

export function createTestProviderExtensions(
  openRuntime: (
    providerId: string,
    context: Parameters<ProviderEndpointFactory>[0]
  ) => ThreadRuntime | Promise<ThreadRuntime>
): readonly PortalExtensionRegistration[] {
  return Object.freeze(
    FIRST_PARTY_PROVIDER_IDS.map((providerId) =>
      createFirstPartyProviderRegistration(
        providerId,
        createTestProviderEndpointFactory(providerId, openRuntime)
      )
    )
  )
}

function createTestProviderEndpointFactory(
  providerId: string,
  openRuntime: (
    providerId: string,
    context: Parameters<ProviderEndpointFactory>[0]
  ) => ThreadRuntime | Promise<ThreadRuntime>
): ProviderEndpointFactory {
  return async (context) => {
    const runtime = await openRuntime(providerId, context)
    const invoke: ProviderEndpoint = async (input, exchangeContext) => {
      const message = input.messages.at(-1)
      if (message === undefined) throw new Error('Provider leg has no message.')
      const submission = runtime.submitUserInput(message.content, {
        signal: exchangeContext.signal,
      })
      void submission.catch(() => undefined)
      const events: AsyncIterable<ProviderEvent> = Object.freeze({
        async *[Symbol.asyncIterator]() {
          const text = await submission
          if (text !== '') yield { type: 'text.delta' as const, text }
        },
      })
      const completion = submission.then<
        ProviderCompletion,
        ProviderCompletion
      >(
        (text) => ({ status: 'completed', text, delivery: 'sent' }),
        (error: unknown) =>
          exchangeContext.signal.aborted
            ? {
                status: 'canceled',
                message: String(exchangeContext.signal.reason ?? error),
                delivery: 'unknown',
              }
            : {
                status: 'failed',
                message: error instanceof Error ? error.message : String(error),
                delivery: 'unknown',
              }
      )
      return Object.freeze({
        events,
        completion,
        cancel: async () => await runtime.stopGeneration(),
      })
    }
    const endpoint: ProviderEndpoint = Object.assign(invoke, {
      session: {
        preflightInput: async (input: string, signal?: AbortSignal) =>
          await runtime.preflightInitialInput(input, signal),
        restore: async (signal?: AbortSignal) =>
          await runtime.restore(signal === undefined ? {} : { signal }),
        loadHistory: async (signal?: AbortSignal) =>
          await runtime.loadHistory(signal === undefined ? {} : { signal }),
        onUnexpectedClose: (listener: () => void) =>
          runtime.onUnexpectedPageClose(listener),
        listCapabilities: async (signal: AbortSignal) =>
          (await runtime.listProviderCapabilities?.(signal)) ?? {
            capabilities: Object.freeze([]),
            usage: '/thread capability <capability>',
          },
        executeCapability: async (
          name: string,
          args: readonly string[],
          signal: AbortSignal
        ) =>
          (await runtime.executeProviderCapability?.(name, args, signal)) ?? {
            status: 'unsupported-provider' as const,
            message: `Provider ${providerId} exposes no manageable capabilities.`,
          },
      },
      close: async () => await runtime.close(),
    })
    Object.defineProperties(endpoint, {
      conversationId: {
        enumerable: true,
        get: () => runtime.conversationId,
      },
      conversationUrl: {
        enumerable: true,
        get: () => runtime.conversationUrl,
      },
    })
    return endpoint
  }
}
