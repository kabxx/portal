import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type { ServiceContainer } from '../extensions/service-container.ts'
import {
  promptContributions,
  promptRendererBindings,
  type PromptContribution,
  type PromptRenderRequest,
  type PromptRendererFactory,
  type PromptSession,
} from './prompt-extension.ts'

export class PromptHostError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'PromptHostError'
  }
}

export class PromptHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ExtensionResourceScope
  readonly #services: ServiceContainer

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ExtensionResourceScope
    readonly services: ServiceContainer
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
    this.#services = options.services
  }

  public list(): readonly PromptContribution[] {
    return Object.freeze(
      this.#graph.contributions(promptContributions).map(({ value }) => value)
    )
  }

  public ownerOf(promptId: string): string {
    return this.#findContribution(promptId).owner
  }

  public async open(
    promptId: string,
    request: PromptRenderRequest,
    parent: ExtensionResourceScope = this.#parent,
    signal?: AbortSignal
  ): Promise<PromptSession> {
    const contribution = this.#findContribution(promptId)
    const binding = this.#findBinding(contribution.value)
    if (binding.owner !== contribution.owner) {
      throw new PromptHostError(
        `Prompt renderer ${binding.id} has a different owner.`
      )
    }
    const scope = parent.createChild('runtime', `prompt:${promptId}`)
    try {
      const activeSignal =
        signal === undefined
          ? scope.resourceScope.signal
          : AbortSignal.any([scope.resourceScope.signal, signal])
      const services = this.#services.createAccessor({
        scope,
        allowedServices: contribution.requiredServices,
        signal: activeSignal,
        deadline: Number.POSITIVE_INFINITY,
      })
      const sessionPromise = Promise.resolve().then(
        async () =>
          await binding.binding({
            request,
            signal: activeSignal,
            scope: scope.createRegistration({ signal: activeSignal }),
            services,
          })
      )
      const settlement = createLateSessionTracker(
        sessionPromise,
        this.#parent,
        `Prompt ${promptId}`,
        activeSignal,
        isPromptSession
      )
      const session = await raceWithAbort(
        sessionPromise,
        activeSignal,
        `Prompt ${promptId} activation was canceled.`
      )
      assertPromptSession(session, promptId)
      if (!(await settlement.adopt())) {
        throw abortError(
          activeSignal.reason,
          `Prompt ${promptId} activation was canceled.`
        )
      }
      scope.resourceScope.defer('prompt session close', async ({ reason }) => {
        await session.close?.(reason)
      })
      let closePromise: Promise<void> | null = null
      const close = async (reason?: unknown): Promise<void> => {
        closePromise ??= scope.resourceScope.dispose({ reason })
        await closePromise
      }
      return Object.freeze({
        render: async (task?: string) => {
          const rendered = await raceWithAbort(
            Promise.resolve().then(async () => await session.render(task)),
            activeSignal,
            `Prompt ${promptId} rendering was canceled.`
          )
          if (typeof rendered !== 'string') {
            throw new PromptHostError(
              `Prompt ${promptId} renderer did not return text.`
            )
          }
          return rendered
        },
        close,
      })
    } catch (error) {
      try {
        await scope.resourceScope.dispose({ reason: error })
      } catch (cleanupError) {
        throw new PromptHostError(
          `Prompt ${promptId} activation and cleanup both failed.`,
          { cause: new AggregateError([error, cleanupError]) }
        )
      }
      throw error
    }
  }

  #findContribution(
    promptId: string
  ): ResolvedContribution<PromptContribution> {
    const contribution = this.#graph
      .contributions(promptContributions)
      .find(({ value }) => value.id === promptId)
    if (contribution === undefined) {
      throw new PromptHostError(`Prompt is not available: ${promptId}.`)
    }
    return contribution
  }

  #findBinding(
    contribution: PromptContribution
  ): ResolvedExecutableBinding<PromptRendererFactory> {
    const binding = this.#graph
      .executableBindings(promptRendererBindings)
      .find(({ targetId }) => targetId === contribution.id)
    if (binding === undefined) {
      throw new PromptHostError(
        `Prompt ${contribution.id} has no renderer binding.`
      )
    }
    if (binding.id !== contribution.rendererBindingId) {
      throw new PromptHostError(
        `Prompt ${contribution.id} renderer binding ID does not match its contribution.`
      )
    }
    return binding
  }
}

function createLateSessionTracker<
  Session extends { close?: (reason?: unknown) => void | Promise<void> },
>(
  sessionPromise: Promise<Session>,
  trackerScope: ExtensionResourceScope,
  label: string,
  signal: AbortSignal,
  isSession: (value: unknown) => value is Session
): { adopt(): Promise<boolean> } {
  const activation = createDeferred<'adopted' | 'abandoned'>()
  const lateCleanup = activation.promise.then(async (state) => {
    if (state === 'adopted') return
    const outcome = await sessionPromise.then(
      (session) => ({ status: 'fulfilled' as const, session }),
      () => ({ status: 'rejected' as const })
    )
    if (outcome.status === 'fulfilled' && isSession(outcome.session)) {
      await outcome.session.close?.(
        new PromptHostError(`${label} activation was canceled.`)
      )
    }
  })
  void lateCleanup.catch(() => undefined)
  const registration = trackerScope.resourceScope.defer(
    `${label} late settlement`,
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
      await registration.dispose(`${label} adopted`)
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

function assertPromptSession(
  value: unknown,
  promptId: string
): asserts value is PromptSession {
  if (!isPromptSession(value)) {
    throw new PromptHostError(
      `Prompt ${promptId} renderer did not return a valid session.`
    )
  }
}

function isPromptSession(value: unknown): value is PromptSession {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'render' in value &&
    typeof value.render === 'function' &&
    (!('close' in value) ||
      value.close === undefined ||
      typeof value.close === 'function')
  )
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
  return new PromptHostError(message, { cause: reason })
}
