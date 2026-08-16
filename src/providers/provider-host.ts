import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
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
  readonly scope: ResourceScope
  exchange(input: ProviderOutboundLeg): Promise<ProviderExchangeHandle>
  close(reason?: unknown): Promise<void>
}

export class ProviderHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ResourceScope

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ResourceScope
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
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
      })
      if (typeof endpoint !== 'function') {
        throw new ProviderHostError(
          `Provider ${providerId} endpoint factory did not return an endpoint.`
        )
      }
      const providerBinding = new ProviderBindingRuntime(
        providerId,
        scope,
        endpoint
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
    public readonly scope: ResourceScope,
    endpoint: ProviderEndpoint
  ) {
    this.#endpoint = endpoint
  }

  public async exchange(
    input: ProviderOutboundLeg
  ): Promise<ProviderExchangeHandle> {
    if (this.#closed || this.scope.state !== 'open') {
      throw new ProviderHostError(
        `Provider binding ${this.providerId} is closed.`
      )
    }
    const exchangeScope = this.scope.createChild(`exchange:${input.exchangeId}`)
    let handle: ProviderExchangeHandle
    try {
      handle = await this.#endpoint(input, {
        exchangeId: input.exchangeId,
        signal: exchangeScope.signal,
        scope: exchangeScope,
      })
      assertExchangeHandle(handle, this.providerId)
      exchangeScope.defer('provider exchange cancel', async ({ reason }) => {
        await handle.cancel(reason)
      })
    } catch (error) {
      await exchangeScope.dispose({ reason: error }).catch(() => undefined)
      throw error
    }

    const completion = handle.completion.finally(async () => {
      await exchangeScope.dispose({ reason: 'provider-completion' })
    })
    return Object.freeze({
      events: handle.events,
      completion,
      cancel: async (reason?: unknown) => {
        await exchangeScope.dispose({ reason })
      },
    })
  }

  public async close(reason?: unknown): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.scope.dispose({ reason })
  }
}

function assertExchangeHandle(
  value: unknown,
  providerId: string
): asserts value is ProviderExchangeHandle {
  if (
    !isRecord(value) ||
    typeof value.cancel !== 'function' ||
    !isPromiseLike(value.completion) ||
    !isAsyncIterable(value.events)
  ) {
    throw new ProviderHostError(
      `Provider ${providerId} returned an invalid exchange handle.`
    )
  }
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
