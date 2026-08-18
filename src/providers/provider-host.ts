import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
  ServiceAccessor,
  ServiceRef,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type { ServiceContainer } from '../extensions/service-container.ts'
import type {
  AttachmentReader,
  AttachmentRef,
} from '../attachments/attachment-contracts.ts'
import {
  providerContributions,
  providerConversationUrlBindings,
  providerEndpointBindings,
  type ProviderContribution,
  type ProviderEndpoint,
  type ProviderEndpointFactory,
  type ProviderExchangeHandle,
  type ProviderOutboundLeg,
  type ProviderCapabilityCatalog,
  type ProviderCapabilityResult,
  type ProviderCompletion,
  type ProviderConversationUrlResolver,
} from './provider-exchange.ts'
import type { ConversationHistoryResult } from './conversation-history.ts'
import type { ResolvedProviderModel } from './provider-model-catalog.ts'
import type { ProviderEvent } from './provider-exchange.ts'
import type { AgentMode, AgentStartup } from '../agents/agent-extension.ts'
import type { AgentHost } from '../agents/agent-host.ts'

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
  readonly conversationId: string | null
  readonly conversationUrl: string | null
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
  exchange(
    input: ProviderOutboundLeg,
    signal?: AbortSignal
  ): Promise<ProviderExchangeHandle>
  close(reason?: unknown): Promise<void>
}

export interface ProviderBindingOpenOptions {
  readonly agentMode: AgentMode | null
  readonly agentStartup: AgentStartup
  readonly workingDirectory?: string
  readonly conversationUrl?: string | null
  readonly model?: ResolvedProviderModel | null
  readonly spawnDepth?: number
  readonly sessionKey?: string | null
  readonly onEvent?: (event: ProviderEvent) => void | Promise<void>
}

export class ProviderHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ResourceScope
  readonly #services: ServiceContainer | null
  readonly #serviceScope: ExtensionResourceScope | null
  readonly #agents: AgentHost | null
  readonly #lateFactorySettlements = new Set<Promise<void>>()
  #attachmentReader: AttachmentReader

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ResourceScope
    readonly agents?: AgentHost
    readonly attachmentReader?: AttachmentReader
    readonly services?: ServiceContainer
    readonly serviceScope?: ExtensionResourceScope
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
    this.#agents = options.agents ?? null
    this.#services = options.services ?? null
    this.#serviceScope = options.serviceScope ?? null
    this.#attachmentReader =
      options.attachmentReader ?? unavailableAttachmentReader
    this.#parent.defer(
      'provider endpoint factory late settlements',
      async ({ reason }) => {
        const outcomes = await Promise.allSettled([
          ...this.#lateFactorySettlements,
        ])
        this.#lateFactorySettlements.clear()
        const errors = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason as unknown] : []
        )
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            `Provider endpoint late cleanup failed during shutdown (${String(reason)}).`
          )
        }
      }
    )
  }

  public setAttachmentReader(reader: AttachmentReader | null): void {
    this.#attachmentReader = reader ?? unavailableAttachmentReader
  }

  public list(): readonly ProviderContribution[] {
    return Object.freeze(
      this.#graph.contributions(providerContributions).map(({ value }) => value)
    )
  }

  public resolveProviderId(value: string): string | null {
    const normalized = value.trim().toLowerCase()
    if (normalized === '') return null
    const matches = this.list().filter(
      ({ id, descriptor }) =>
        id === normalized || descriptor.aliases.includes(normalized)
    )
    if (matches.length > 1) {
      throw new ProviderHostError(`Provider alias is ambiguous: ${normalized}.`)
    }
    return matches[0]?.id ?? null
  }

  public ownerOf(providerId: string): string {
    return this.#findContribution(providerId).owner
  }

  public resolveConversationUrl(value: string): {
    readonly provider: string
    readonly conversationUrl: string
  } | null {
    const matches = this.#graph
      .contributions(providerContributions)
      .flatMap((contribution) => {
        const binding = this.#findConversationUrlBinding(contribution.value.id)
        const conversationUrl = binding.binding(value)
        return conversationUrl === null
          ? []
          : [
              Object.freeze({
                provider: contribution.value.id,
                conversationUrl,
              }),
            ]
      })
    if (matches.length > 1) {
      throw new ProviderHostError(
        `Conversation URL is claimed by multiple Providers: ${value}`
      )
    }
    return matches[0] ?? null
  }

  public resolveModel(
    providerId: string,
    model: string | null,
    option: string | null = null
  ): ResolvedProviderModel | null {
    const contribution = this.#findContribution(providerId).value
    if (model === null) {
      if (option !== null) {
        throw new ProviderHostError(
          `${providerId} model option "${option}" requires a model.`
        )
      }
      return null
    }
    const key = model.trim().toLowerCase()
    const definition = contribution.descriptor.models.find(
      (candidate) => candidate.key === key
    )
    if (definition === undefined) {
      throw new ProviderHostError(
        `${providerId} does not support model "${model}". Available models: ${contribution.descriptor.models.map(({ key: available }) => available).join(', ')}.`
      )
    }
    if (option === null) return Object.freeze({ key, option: null })
    const optionKey = option.trim().toLowerCase()
    if (!definition.options.includes(optionKey)) {
      throw new ProviderHostError(
        definition.options.length === 0
          ? `${providerId} model "${key}" does not support model options.`
          : `${providerId} model "${key}" does not support option "${option}". Available options: ${definition.options.join(', ')}.`
      )
    }
    return Object.freeze({ key, option: optionKey })
  }

  public async openBinding(
    providerId: string,
    ownerId: string,
    selectionRevision: string,
    options: ProviderBindingOpenOptions
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
    const extensionScope = new ExtensionResourceScope(
      'provider-session',
      providerId,
      scope,
      this.#serviceScope
    )
    const services = this.#createServiceAccessor(contribution, extensionScope)
    try {
      const { agentMode, agentStartup } = options
      if (
        (agentStartup === 'resume' && agentMode !== null) ||
        (agentStartup !== 'resume' && agentMode === null)
      ) {
        throw new ProviderHostError(
          `Provider ${providerId} received an invalid Agent startup selection.`
        )
      }
      const agents = this.#agents
      let openAgentSession: Parameters<ProviderEndpointFactory>[0]['openAgentSession']
      if (agentStartup !== 'resume') {
        if (agents === null || agentMode === null) {
          throw new ProviderHostError(
            `Provider ${providerId} has no Agent Host for ${agentStartup} startup.`
          )
        }
        agents.resolveMode(agentMode)
        openAgentSession = async ({ tools, textToolProtocol }) =>
          await agents.open(
            {
              mode: agentMode,
              startup: agentStartup,
              tools,
              textToolProtocol,
              workingDirectory: options.workingDirectory ?? process.cwd(),
            },
            extensionScope,
            scope.signal
          )
      } else {
        openAgentSession = async () => null
      }
      const endpointPromise = Promise.resolve().then(
        async () =>
          await binding.binding({
            providerId,
            agentMode,
            agentStartup,
            scope,
            signal: scope.signal,
            readAttachment: async (ref) =>
              await this.#attachmentReader.read(ref),
            conversationUrl: options.conversationUrl ?? null,
            model: options.model ?? null,
            workingDirectory: options.workingDirectory ?? process.cwd(),
            spawnDepth: options.spawnDepth ?? 0,
            sessionKey: options.sessionKey ?? null,
            emit: options.onEvent ?? (() => undefined),
            services,
            openAgentSession,
          })
      )
      let endpointAdopted = false
      const lateCleanup = endpointPromise.then(
        async (lateEndpoint) => {
          if (endpointAdopted || !scope.signal.aborted) return
          if (typeof lateEndpoint === 'function') {
            await lateEndpoint.close?.(scope.signal.reason)
          }
        },
        () => undefined
      )
      const lateSettlement = lateCleanup.then(
        () => {
          this.#lateFactorySettlements.delete(lateSettlement)
        },
        (error: unknown) => {
          throw error
        }
      )
      this.#lateFactorySettlements.add(lateSettlement)
      void lateSettlement.catch(() => undefined)
      const endpoint = await raceBindingWithAbort(endpointPromise, scope.signal)
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
      endpointAdopted = true
      return providerBinding
    } catch (error) {
      try {
        await scope.dispose({ reason: error })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Provider ${providerId} binding creation and cleanup both failed.`,
          { cause: cleanupError }
        )
      }
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

  #createServiceAccessor(
    contribution: ResolvedContribution<ProviderContribution>,
    scope: ExtensionResourceScope
  ): ServiceAccessor {
    if (contribution.requiredServices.length === 0) {
      return unavailableServiceAccessor
    }
    if (this.#services === null || this.#serviceScope === null) {
      throw new ProviderHostError(
        `Provider ${contribution.value.id} requires services, but ProviderHost has no service runtime.`
      )
    }
    return this.#services.createAccessor({
      scope,
      allowedServices: contribution.requiredServices,
      signal: scope.resourceScope.signal,
      deadline: Number.POSITIVE_INFINITY,
    })
  }

  #findConversationUrlBinding(
    contributionId: string
  ): ResolvedExecutableBinding<ProviderConversationUrlResolver> {
    const contribution = this.#findContribution(contributionId)
    const binding = this.#graph
      .executableBindings(providerConversationUrlBindings)
      .find((item) => item.targetId === contributionId)
    if (binding === undefined) {
      throw new ProviderHostError(
        `Provider ${contributionId} has no conversation URL resolver.`
      )
    }
    if (binding.id !== contribution.value.conversationUrlBindingId) {
      throw new ProviderHostError(
        `Provider ${contributionId} conversation URL binding ID does not match its contribution.`
      )
    }
    if (binding.owner !== contribution.owner) {
      throw new ProviderHostError(
        `Provider ${contributionId} conversation URL resolver has a different owner.`
      )
    }
    return binding
  }
}

async function raceBindingWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    throw toProviderError(signal.reason, 'Provider binding creation canceled.')
  }
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        toProviderError(signal.reason, 'Provider binding creation canceled.')
      )
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
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

  public get conversationId(): string | null {
    return this.#endpoint.conversationId ?? null
  }

  public get conversationUrl(): string | null {
    return this.#endpoint.conversationUrl ?? null
  }

  public async preflightInput(
    input: string,
    signal?: AbortSignal
  ): Promise<{
    readonly status: 'unknown' | 'within_limit' | 'over_limit'
  }> {
    return await this.requireSession().preflightInput(input, signal)
  }

  public async restore(signal?: AbortSignal): Promise<void> {
    await this.requireSession().restore(signal)
  }

  public async loadHistory(
    signal?: AbortSignal
  ): Promise<ConversationHistoryResult> {
    return await this.requireSession().loadHistory(signal)
  }

  public onUnexpectedClose(listener: () => void): () => void {
    return this.requireSession().onUnexpectedClose(listener)
  }

  public async listCapabilities(
    signal: AbortSignal
  ): Promise<ProviderCapabilityCatalog> {
    return await this.requireSession().listCapabilities(signal)
  }

  public async executeCapability(
    name: string,
    args: readonly string[],
    signal: AbortSignal
  ): Promise<ProviderCapabilityResult> {
    return await this.requireSession().executeCapability(name, args, signal)
  }

  private requireSession() {
    const session = this.#endpoint.session
    if (session === undefined) {
      throw new ProviderHostError(
        `Provider ${this.providerId} does not expose the requested session capability.`
      )
    }
    return session
  }

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
    const externalCancellation = this.bindExternalCancellation(
      exchangeScope,
      signal
    )
    let attachmentsReleased = false
    const releaseAttachments = async (): Promise<void> => {
      if (attachmentsReleased) return
      attachmentsReleased = true
      await Promise.all(
        input.attachments.map(
          async (ref) => await this.#attachmentReader.release?.(ref)
        )
      )
    }
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
      let endpointAdopted = false
      const lateCleanup = endpointPromise.then(
        async (lateEndpoint) => {
          if (endpointAdopted || !exchangeScope.signal.aborted) return
          assertExchangeHandle(lateEndpoint, this.providerId)
          void Promise.resolve(lateEndpoint.completion).catch(() => undefined)
          await lateEndpoint.cancel(exchangeScope.signal.reason)
        },
        () => undefined
      )
      void lateCleanup.catch(() => undefined)
      this.scope.defer(
        `late exchange cleanup:${input.exchangeId}`,
        async () => await lateCleanup
      )
      handle = await raceWithAbort(
        endpointPromise,
        exchangeScope.signal,
        `Provider ${this.providerId} exchange creation canceled.`
      )
      assertExchangeHandle(handle, this.providerId)
      endpointAdopted = true
      exchangeScope.defer('provider exchange cancel', async ({ reason }) => {
        await handle.cancel(reason)
      })
    } catch (error) {
      externalCancellation.remove()
      const cleanupErrors: unknown[] = []
      try {
        await exchangeScope.dispose({ reason: error })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      try {
        await releaseAttachments()
      } catch (releaseError) {
        cleanupErrors.push(releaseError)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Provider ${this.providerId} exchange creation and cleanup both failed.`,
          { cause: error }
        )
      }
      throw error
    }

    const bufferedEvents = bufferEvents(handle.events)
    const normalCompletion = Promise.all([
      handle.completion,
      settleStream(bufferedEvents.done, exchangeScope.signal),
    ]).then(
      async ([value]) => {
        await exchangeScope.dispose({ reason: 'provider-completion' })
        return value
      },
      async (error: unknown) => {
        try {
          await exchangeScope.dispose({ reason: error })
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Provider ${this.providerId} exchange and cleanup both failed.`,
            { cause: cleanupError }
          )
        }
        throw error
      }
    )
    void normalCompletion.catch(() => undefined)
    const completion = Promise.race([
      normalCompletion,
      externalCancellation.completion,
    ]).finally(async () => {
      externalCancellation.remove()
      await releaseAttachments()
    })
    void completion.catch(() => undefined)
    return Object.freeze({
      events: bufferedEvents.events,
      completion,
      cancel: async (reason?: unknown) => {
        await exchangeScope.dispose({ reason })
      },
    })
  }

  private bindExternalCancellation(
    exchangeScope: ResourceScope,
    signal: AbortSignal | undefined
  ): {
    readonly completion: Promise<ProviderCompletion>
    readonly remove: () => void
  } {
    if (signal === undefined) {
      return {
        completion: new Promise<ProviderCompletion>(() => undefined),
        remove: () => {},
      }
    }
    let resolveCanceled: (completion: ProviderCompletion) => void = () => {}
    let rejectCanceled: (reason?: unknown) => void = () => {}
    const canceled = new Promise<ProviderCompletion>((resolve, reject) => {
      resolveCanceled = resolve
      rejectCanceled = reject
    })
    void canceled.catch(() => undefined)
    let cancellation: Promise<void> | null = null
    const cancel = () => {
      cancellation ??= exchangeScope.dispose({ reason: signal.reason })
      void cancellation.then(
        () =>
          resolveCanceled({
            status: 'canceled',
            message: getProviderCancellationMessage(signal.reason),
            delivery: 'unknown',
          }),
        rejectCanceled
      )
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return {
      completion: canceled,
      remove: () => signal.removeEventListener('abort', cancel),
    }
  }

  public async close(reason?: unknown): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.scope.dispose({ reason })
  }
}

async function settleStream(
  stream: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  let remove = () => {}
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    await Promise.race([stream, aborted])
  } finally {
    remove()
  }
}

function bufferEvents(source: AsyncIterable<ProviderEvent>): {
  readonly events: AsyncIterable<ProviderEvent>
  readonly done: Promise<void>
} {
  const queue: ProviderEvent[] = []
  const waiters: {
    readonly resolve: (value: IteratorResult<ProviderEvent>) => void
    readonly reject: (error: unknown) => void
  }[] = []
  let terminal: { readonly error?: Error } | null = null
  const push = (event: ProviderEvent) => {
    const waiter = waiters.shift()
    if (waiter === undefined) queue.push(event)
    else waiter.resolve({ value: event, done: false })
  }
  const finish = (error?: unknown) => {
    terminal =
      error === undefined
        ? {}
        : { error: toProviderError(error, 'Provider event stream failed.') }
    for (const waiter of waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true })
      else waiter.reject(error)
    }
  }
  const done = (async () => {
    try {
      for await (const event of source) push(event)
      finish()
    } catch (error) {
      finish(error)
      throw error
    }
  })()
  void done.catch(() => undefined)
  const events: AsyncIterable<ProviderEvent> = Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
      return {
        next(): Promise<IteratorResult<ProviderEvent>> {
          const event = queue.shift()
          if (event !== undefined)
            return Promise.resolve({ value: event, done: false })
          if (terminal !== null) {
            return terminal.error === undefined
              ? Promise.resolve({ value: undefined, done: true })
              : Promise.reject(terminal.error)
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject })
          })
        },
      }
    },
  })
  return Object.freeze({ events, done })
}

const unavailableAttachmentReader: AttachmentReader = Object.freeze({
  async read(ref: AttachmentRef): Promise<Uint8Array> {
    throw new ProviderHostError(
      `Attachment ${ref.id} cannot be read because no attachment service is configured.`
    )
  },
})

const unavailableServiceAccessor: ServiceAccessor = Object.freeze({
  async get<Service>(ref: ServiceRef<Service>): Promise<Service> {
    throw new ProviderHostError(
      `Provider did not declare required Service ${ref.id}.`
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

function getProviderCancellationMessage(reason: unknown): string {
  return reason instanceof Error && reason.message !== ''
    ? reason.message
    : 'Provider exchange canceled.'
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
