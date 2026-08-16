import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import type {
  AttachmentReader,
  AttachmentRef,
} from '../attachments/attachment-contracts.ts'
import {
  providerContributions,
  providerEndpointBindings,
  type ProviderContribution,
  type ProviderEndpoint,
  type ProviderEndpointFactory,
  type ProviderExchangeHandle,
  type ProviderOutboundLeg,
} from './provider-exchange.ts'

export class ProviderHostError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderHostError'
  }
}

export interface ProviderBinding {
  readonly providerId: string
  readonly capabilities: readonly string[]
  readonly scope: ResourceScope
  exchange(
    input: ProviderOutboundLeg,
    signal?: AbortSignal
  ): Promise<ProviderExchangeHandle>
  close(reason?: unknown): Promise<void>
}

export class ProviderHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ResourceScope
  readonly #attachmentReader: AttachmentReader

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ResourceScope
    readonly attachmentReader?: AttachmentReader
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
    this.#attachmentReader =
      options.attachmentReader ?? unavailableAttachmentReader
  }

  public async openBinding(
    providerId: string,
    ownerId: string,
    selectionRevision: string
  ): Promise<ProviderBinding> {
    const contribution = this.#findContribution(providerId)
    if (contribution.owner !== ownerId) {
      throw new ProviderHostError(
        `Provider ${providerId} is owned by ${contribution.owner}, not ${ownerId}.`
      )
    }
    const binding = this.#findBinding(contribution.value.id)
    if (binding.owner !== contribution.owner) {
      throw new ProviderHostError(
        `Provider endpoint ${binding.id} has a different owner.`
      )
    }
    if (binding.id !== contribution.value.endpointBindingId) {
      throw new ProviderHostError(
        `Provider ${providerId} endpoint binding ID does not match its contribution.`
      )
    }
    const scope = this.#parent.createChild(
      `provider-binding:${providerId}:${selectionRevision}`
    )
    try {
      const endpoint = await binding.binding({
        providerId,
        scope,
        signal: scope.signal,
        readAttachment: async (ref) => await this.#attachmentReader.read(ref),
      })
      if (typeof endpoint !== 'function') {
        throw new ProviderHostError(
          `Provider ${providerId} endpoint factory did not return an endpoint.`
        )
      }
      const providerBinding = new ProviderBindingRuntime(
        providerId,
        contribution.value.descriptor.capabilities,
        scope,
        endpoint,
        this.#attachmentReader
      )
      scope.defer('provider endpoint close', async ({ reason }) => {
        await endpoint.close?.(reason)
      })
      return providerBinding
    } catch (error) {
      await scope.dispose({ reason: error }).catch(() => undefined)
      throw error
    }
  }

  #findContribution(
    providerId: string
  ): ResolvedContribution<ProviderContribution> {
    const contribution = this.#graph
      .contributions(providerContributions)
      .find((item) => item.value.id === providerId)
    if (contribution === undefined) {
      throw new ProviderHostError(`Provider is not available: ${providerId}.`)
    }
    return contribution
  }

  #findBinding(
    contributionId: string
  ): ResolvedExecutableBinding<ProviderEndpointFactory> {
    const binding = this.#graph
      .executableBindings(providerEndpointBindings)
      .find((item) => item.targetId === contributionId)
    if (binding === undefined) {
      throw new ProviderHostError(
        `Provider ${contributionId} has no endpoint binding.`
      )
    }
    return binding
  }
}

class ProviderBindingRuntime implements ProviderBinding {
  #closed = false
  readonly #endpoint: ProviderEndpoint

  public constructor(
    public readonly providerId: string,
    public readonly capabilities: readonly string[],
    public readonly scope: ResourceScope,
    endpoint: ProviderEndpoint,
    attachmentReader: AttachmentReader
  ) {
    this.#endpoint = endpoint
    this.#attachmentReader = attachmentReader
  }

  readonly #attachmentReader: AttachmentReader

  public async exchange(
    input: ProviderOutboundLeg,
    signal?: AbortSignal
  ): Promise<ProviderExchangeHandle> {
    if (this.#closed || this.scope.state !== 'open') {
      throw new ProviderHostError(
        `Provider binding ${this.providerId} is closed.`
      )
    }
    const exchangeScope = this.scope.createChild(`exchange:${input.exchangeId}`)
    const removeExternalCancellation = this.bindExternalCancellation(
      exchangeScope,
      signal
    )
    let handle: ProviderExchangeHandle
    try {
      const endpointPromise = Promise.resolve().then(
        async () =>
          await this.#endpoint(input, {
            exchangeId: input.exchangeId,
            signal: exchangeScope.signal,
            scope: exchangeScope,
            readAttachment: async (ref) =>
              await this.#attachmentReader.read(ref),
          })
      )
      void endpointPromise.then(
        (lateEndpoint) => {
          if (
            exchangeScope.signal.aborted &&
            isProviderExchangeHandle(lateEndpoint)
          ) {
            void Promise.resolve(lateEndpoint.completion).catch(() => undefined)
            void Promise.resolve(
              lateEndpoint.cancel(exchangeScope.signal.reason)
            ).catch(() => undefined)
          }
        },
        () => undefined
      )
      handle = await raceWithAbort(
        endpointPromise,
        exchangeScope.signal,
        `Provider ${this.providerId} exchange creation canceled.`
      )
      assertExchangeHandle(handle, this.providerId)
      exchangeScope.defer('provider exchange cancel', async ({ reason }) => {
        await handle.cancel(reason)
      })
    } catch (error) {
      await exchangeScope.dispose({ reason: error }).catch(() => undefined)
      removeExternalCancellation()
      throw error
    }

    const completion = handle.completion
      .then(
        async (value) => {
          await exchangeScope.dispose({ reason: 'provider-completion' })
          return value
        },
        async (error: unknown) => {
          await exchangeScope.dispose({ reason: error }).catch(() => undefined)
          throw error
        }
      )
      .finally(removeExternalCancellation)
    void completion.catch(() => undefined)
    return Object.freeze({
      events: handle.events,
      completion,
      cancel: async (reason?: unknown) => {
        await exchangeScope.dispose({ reason })
      },
    })
  }

  private bindExternalCancellation(
    exchangeScope: ResourceScope,
    signal: AbortSignal | undefined
  ): () => void {
    if (signal === undefined) return () => {}
    const cancel = () => {
      void exchangeScope
        .dispose({ reason: signal.reason })
        .catch(() => undefined)
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }

  public async close(reason?: unknown): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.scope.dispose({ reason })
  }
}

const unavailableAttachmentReader: AttachmentReader = Object.freeze({
  async read(ref: AttachmentRef): Promise<Uint8Array> {
    throw new ProviderHostError(
      `Attachment ${ref.id} cannot be read because no attachment service is configured.`
    )
  },
})

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  if (signal.aborted) throw toProviderError(signal.reason, message)
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(toProviderError(signal.reason, message))
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
  }
}

function toProviderError(reason: unknown, fallback: string): ProviderHostError {
  return new ProviderHostError(
    reason instanceof Error && reason.message !== '' ? reason.message : fallback
  )
}

function assertExchangeHandle(
  value: unknown,
  providerId: string
): asserts value is ProviderExchangeHandle {
  if (!isProviderExchangeHandle(value)) {
    throw new ProviderHostError(
      `Provider ${providerId} returned an invalid exchange handle.`
    )
  }
}

function isProviderExchangeHandle(
  value: unknown
): value is ProviderExchangeHandle {
  return (
    isRecord(value) &&
    typeof value.cancel === 'function' &&
    isPromiseLike(value.completion) &&
    isAsyncIterable(value.events)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  )
}
