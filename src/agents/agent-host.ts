import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type { ServiceContainer } from '../extensions/service-container.ts'
import {
  agentContributions,
  agentHistoryBindings,
  agentSessionBindings,
  type AgentContribution,
  type AgentMode,
  type AgentHistoryClassifier,
  type AgentSession,
  type AgentSessionFactory,
  type AgentSessionRequest,
} from './agent-extension.ts'
import { PromptHost } from '../prompts/prompt-host.ts'
import type { ConversationHistoryMessage } from '../providers/conversation-history.ts'

export class AgentHostError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'AgentHostError'
  }
}

export class AgentHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ExtensionResourceScope
  readonly #services: ServiceContainer
  readonly #prompts: PromptHost

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ExtensionResourceScope
    readonly services: ServiceContainer
    readonly prompts: PromptHost
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
    this.#services = options.services
    this.#prompts = options.prompts
  }

  public list(): readonly AgentContribution[] {
    const promptIds = new Set(this.#prompts.list().map(({ id }) => id))
    return Object.freeze(
      this.#graph
        .contributions(agentContributions)
        .filter(({ value }) => promptIds.has(value.promptId))
        .map(({ value }) => value)
    )
  }

  public resolveMode(mode: AgentMode): AgentContribution {
    return this.#findContributionForMode(mode).value
  }

  public projectHistory(
    messages: readonly ConversationHistoryMessage[]
  ): readonly ConversationHistoryMessage[] {
    const hidden = new Set<number>()
    for (const contribution of this.#effectiveContributions()) {
      const classifier = this.#findHistoryBinding(contribution)
      for (const index of classifier.binding(messages)) {
        if (Number.isInteger(index) && index >= 0 && index < messages.length) {
          hidden.add(index)
        }
      }
    }
    return Object.freeze(
      messages.filter((_message, index) => !hidden.has(index))
    )
  }

  #findContributionForMode(
    mode: AgentMode
  ): ResolvedContribution<AgentContribution> {
    const promptIds = new Set(this.#prompts.list().map(({ id }) => id))
    const matches = this.#graph
      .contributions(agentContributions)
      .filter(
        ({ value }) =>
          value.descriptor.mode === mode && promptIds.has(value.promptId)
      )
    if (matches.length !== 1) {
      throw new AgentHostError(
        matches.length === 0
          ? `Agent mode is not available: ${mode}.`
          : `Agent mode is ambiguous: ${mode}.`
      )
    }
    const match = matches[0]
    if (match === undefined) {
      throw new AgentHostError(`Agent mode is not available: ${mode}.`)
    }
    return match
  }

  #effectiveContributions(): readonly ResolvedContribution<AgentContribution>[] {
    const promptIds = new Set(this.#prompts.list().map(({ id }) => id))
    return this.#graph
      .contributions(agentContributions)
      .filter(({ value }) => promptIds.has(value.promptId))
  }

  public async open(
    request: AgentSessionRequest,
    parent: ExtensionResourceScope = this.#parent,
    signal?: AbortSignal
  ): Promise<AgentSession> {
    if (request.startup === 'resume') {
      throw new AgentHostError('Resume does not create an Agent session.')
    }
    const contribution = this.#findContributionForMode(request.mode)
    const binding = this.#findBinding(contribution)
    const scope = parent.createChild(
      'runtime',
      `agent:${contribution.value.id}`
    )
    try {
      const activeSignal =
        signal === undefined
          ? scope.resourceScope.signal
          : AbortSignal.any([scope.resourceScope.signal, signal])
      const prompt = await this.#prompts.open(
        contribution.value.promptId,
        request,
        scope,
        activeSignal
      )
      const sessionScope = scope.createChild(
        'runtime',
        `agent-session:${contribution.value.id}`
      )
      const services = this.#services.createAccessor({
        scope: sessionScope,
        allowedServices: contribution.requiredServices,
        signal: activeSignal,
        deadline: Number.POSITIVE_INFINITY,
      })
      const sessionPromise = Promise.resolve().then(
        async () =>
          await binding.binding({
            request,
            prompt,
            signal: activeSignal,
            scope: sessionScope.createRegistration({ signal: activeSignal }),
            services,
          })
      )
      const settlement = createLateAgentSessionTracker(
        sessionPromise,
        this.#parent,
        contribution.value.id,
        activeSignal
      )
      const session = await raceWithAbort(
        sessionPromise,
        activeSignal,
        `Agent ${contribution.value.id} activation was canceled.`
      )
      assertAgentSession(session, contribution.value.id)
      if (!(await settlement.adopt())) {
        throw abortError(
          activeSignal.reason,
          `Agent ${contribution.value.id} activation was canceled.`
        )
      }
      sessionScope.resourceScope.defer(
        'agent session close',
        async ({ reason }) => {
          await session.close?.(reason)
        }
      )
      const initialization =
        session.initialization === null
          ? null
          : Object.freeze({
              prompt: session.initialization.prompt,
              accepts: (response: string): boolean => {
                const accepted = session.initialization?.accepts(response)
                if (typeof accepted !== 'boolean') {
                  throw new AgentHostError(
                    `Agent ${contribution.value.id} initialization predicate did not return a boolean.`
                  )
                }
                return accepted
              },
            })
      return Object.freeze({
        initialization,
        previewInput: async (input: string) =>
          await raceWithAbort(
            requireAgentText(
              session.previewInput(input),
              contribution.value.id,
              'previewInput'
            ),
            activeSignal,
            `Agent ${contribution.value.id} input preview was canceled.`
          ),
        prepareInput: async (input: string) =>
          await raceWithAbort(
            requireAgentText(
              session.prepareInput(input),
              contribution.value.id,
              'prepareInput'
            ),
            activeSignal,
            `Agent ${contribution.value.id} input preparation was canceled.`
          ),
        close: async (reason?: unknown) =>
          await scope.resourceScope.dispose({ reason }),
      })
    } catch (error) {
      try {
        await scope.resourceScope.dispose({ reason: error })
      } catch (cleanupError) {
        throw new AgentHostError(
          `Agent ${contribution.value.id} activation and cleanup both failed.`,
          { cause: new AggregateError([error, cleanupError]) }
        )
      }
      throw error
    }
  }

  #findBinding(
    contribution: ResolvedContribution<AgentContribution>
  ): ResolvedExecutableBinding<AgentSessionFactory> {
    const binding = this.#graph
      .executableBindings(agentSessionBindings)
      .find(({ targetId }) => targetId === contribution.value.id)
    if (binding === undefined) {
      throw new AgentHostError(
        `Agent ${contribution.value.id} has no session binding.`
      )
    }
    if (binding.id !== contribution.value.sessionBindingId) {
      throw new AgentHostError(
        `Agent ${contribution.value.id} session binding ID does not match its contribution.`
      )
    }
    if (binding.owner !== contribution.owner) {
      throw new AgentHostError(
        `Agent ${contribution.value.id} session binding has a different owner.`
      )
    }
    return binding
  }

  #findHistoryBinding(
    contribution: ResolvedContribution<AgentContribution>
  ): ResolvedExecutableBinding<AgentHistoryClassifier> {
    const binding = this.#graph
      .executableBindings(agentHistoryBindings)
      .find(({ targetId }) => targetId === contribution.value.id)
    if (
      binding === undefined ||
      binding.id !== contribution.value.historyBindingId ||
      binding.owner !== contribution.owner
    ) {
      throw new AgentHostError(
        `Agent ${contribution.value.id} has no matching history classifier.`
      )
    }
    return binding
  }
}

function createLateAgentSessionTracker(
  sessionPromise: Promise<AgentSession>,
  trackerScope: ExtensionResourceScope,
  agentId: string,
  signal: AbortSignal
): { adopt(): Promise<boolean> } {
  const activation = createDeferred<'adopted' | 'abandoned'>()
  const lateCleanup = activation.promise.then(async (state) => {
    if (state === 'adopted') return
    const outcome = await sessionPromise.then(
      (session) => ({ status: 'fulfilled' as const, session }),
      () => ({ status: 'rejected' as const })
    )
    if (outcome.status === 'fulfilled' && isAgentSession(outcome.session)) {
      await outcome.session.close?.(
        new AgentHostError(`Agent ${agentId} activation was canceled.`)
      )
    }
  })
  void lateCleanup.catch(() => undefined)
  const registration = trackerScope.resourceScope.defer(
    `Agent ${agentId} late settlement`,
    async () => await lateCleanup
  )
  let settled = false
  const abandon = () => {
    if (settled) return
    settled = true
    activation.resolve('abandoned')
  }
  if (signal.aborted) abandon()
  else signal.addEventListener('abort', abandon, { once: true })
  return {
    adopt: async () => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', abandon)
      activation.resolve('adopted')
      await registration.dispose(`Agent ${agentId} adopted`)
      return true
    },
  }
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>
  resolve(value: Value): void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function assertAgentSession(
  value: unknown,
  agentId: string
): asserts value is AgentSession {
  if (!isAgentSession(value)) {
    throw new AgentHostError(
      `Agent ${agentId} binding did not return a valid session.`
    )
  }
}

function isAgentSession(value: unknown): value is AgentSession {
  return (
    isRecord(value) &&
    typeof value.previewInput === 'function' &&
    typeof value.prepareInput === 'function' &&
    'initialization' in value &&
    (value.initialization === null ||
      isAgentInitialization(value.initialization)) &&
    (!('close' in value) ||
      value.close === undefined ||
      typeof value.close === 'function')
  )
}

function isAgentInitialization(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.prompt === 'string' &&
    typeof value.accepts === 'function'
  )
}

async function requireAgentText(
  value: string | Promise<string>,
  agentId: string,
  operation: string
): Promise<string> {
  const result = await value
  if (typeof result !== 'string') {
    throw new AgentHostError(
      `Agent ${agentId} ${operation} did not return text.`
    )
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  void operation.catch(() => undefined)
  if (signal.aborted) throw abortError(signal.reason, message)
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError(signal.reason, message))
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
  }
}

function abortError(reason: unknown, message: string): Error {
  if (reason instanceof Error) return reason
  return new AgentHostError(message, { cause: reason })
}
