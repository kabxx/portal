import type { ServiceContainer } from '../extensions/service-container.ts'
import type { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type {
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import {
  surfaceActivationBindings,
  surfaceContributions,
  surfaceFeatureActivationBindings,
  surfaceFeatureContributions,
  type ActiveSurfaceFeature,
  type SurfaceActivator,
  type SurfaceContribution,
  type SurfaceFeatureActivator,
  type SurfaceFeatureContribution,
  type SurfaceFeatureSet,
  type SurfaceInstance,
  type SurfaceKernelBinding,
  type SurfaceSessionIntent,
} from './surface-extension.ts'

export class SurfaceHostError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'SurfaceHostError'
  }
}

export interface ActiveSurface {
  readonly id: string
  readonly owner: string
  readonly done: Promise<void>
  readonly api: unknown
  close(reason?: unknown): Promise<void>
}

interface ActiveSurfaceRecord {
  surface: ActiveSurface | null
  closePromise: Promise<void> | null
}

export class SurfaceHost {
  readonly #contributions: readonly ResolvedContribution<SurfaceContribution>[]
  readonly #bindingsByTarget: ReadonlyMap<
    string,
    ResolvedExecutableBinding<SurfaceActivator>
  >
  readonly #featureContributions: readonly ResolvedContribution<SurfaceFeatureContribution>[]
  readonly #featureBindingsByTarget: ReadonlyMap<
    string,
    ResolvedExecutableBinding<SurfaceFeatureActivator>
  >
  readonly #parent: ExtensionResourceScope
  readonly #services: ServiceContainer
  readonly #active = new Map<string, ActiveSurfaceRecord>()
  readonly #pending = new Map<string, Promise<ActiveSurface>>()
  #kernel: SurfaceKernelBinding | null = null

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ExtensionResourceScope
    readonly services: ServiceContainer
  }) {
    this.#contributions = options.graph.contributions(surfaceContributions)
    this.#bindingsByTarget = new Map(
      options.graph
        .executableBindings(surfaceActivationBindings)
        .map((binding) => [binding.targetId, binding])
    )
    this.#featureContributions = options.graph.contributions(
      surfaceFeatureContributions
    )
    this.#featureBindingsByTarget = new Map(
      options.graph
        .executableBindings(surfaceFeatureActivationBindings)
        .map((binding) => [binding.targetId, binding])
    )
    this.#parent = options.parent
    this.#services = options.services
  }

  public list(): readonly SurfaceContribution[] {
    return Object.freeze(this.#contributions.map(({ value }) => value))
  }

  public sessionIntent(surfaceId: string): SurfaceSessionIntent | null {
    return (
      this.#contributions.find(({ value }) => value.id === surfaceId)?.value
        .sessionIntent ?? null
    )
  }

  public bindKernel(kernel: SurfaceKernelBinding): () => void {
    if (this.#kernel !== null) {
      throw new SurfaceHostError('Surface Kernel binding is already active.')
    }
    this.#kernel = kernel
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#kernel === kernel) this.#kernel = null
    }
  }

  public async activate(
    surfaceId: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<ActiveSurface> {
    const pending = this.#pending.get(surfaceId)
    if (pending !== undefined) return await pending
    const activation = this.#activateOnce(surfaceId, input, signal)
    this.#pending.set(surfaceId, activation)
    void activation.then(
      () => this.#pending.delete(surfaceId),
      () => this.#pending.delete(surfaceId)
    )
    return await activation
  }

  async #activateOnce(
    surfaceId: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<ActiveSurface> {
    const existing = this.#active.get(surfaceId)
    if (existing?.surface !== null && existing?.surface !== undefined) {
      return existing.surface
    }
    const kernel = this.#kernel
    if (kernel === null) {
      throw new SurfaceHostError('Surface Kernel binding is not active.')
    }
    const contribution = this.#contributions.find(
      ({ value }) => value.id === surfaceId
    )
    if (contribution === undefined) {
      throw new SurfaceHostError(`Unknown or disabled Surface: ${surfaceId}`)
    }
    const binding = this.#bindingsByTarget.get(contribution.id)
    if (binding === undefined) {
      throw new SurfaceHostError(
        `Surface ${surfaceId} has no executable activator binding.`
      )
    }
    const scope = this.#parent.createChild('surface', surfaceId)
    const activationSignal =
      signal === undefined
        ? scope.resourceScope.signal
        : AbortSignal.any([scope.resourceScope.signal, signal])
    const services = this.#services.createAccessor({
      scope,
      allowedServices: contribution.requiredServices,
      signal: activationSignal,
      deadline: Number.POSITIVE_INFINITY,
    })
    let instance: SurfaceInstance
    try {
      const features = await this.#activateFeatures(
        contribution.value.id,
        scope,
        activationSignal,
        kernel
      )
      const activation = Promise.resolve(
        binding.binding(input, {
          surfaceId,
          signal: activationSignal,
          scope: scope.createRegistration({ signal: activationSignal }),
          services,
          port: kernel.port,
          events: kernel.events,
          commands: kernel.commands,
          host: kernel.snapshot,
          features,
          requestStop: async (reason) =>
            await kernel.requestStop(surfaceId, reason),
        })
      )
      let instanceAdopted = false
      scope.resourceScope.defer(
        'surface activation settlement',
        async ({ reason }) => {
          if (instanceAdopted) return
          const lateInstance = await activation
          assertSurfaceInstance(lateInstance, surfaceId)
          await lateInstance.close(reason)
        }
      )
      instance = await raceWithAbort(
        activation,
        activationSignal,
        `Surface ${surfaceId} activation was canceled.`
      )
      assertSurfaceInstance(instance, surfaceId)
      instanceAdopted = true
    } catch (error) {
      try {
        await scope.resourceScope.dispose({ reason: error })
      } catch (cleanupError) {
        throw new SurfaceHostError(
          `Surface ${surfaceId} activation and rollback failed.`,
          {
            cause: new AggregateError([error, cleanupError]),
          }
        )
      }
      throw error
    }

    const record: ActiveSurfaceRecord = {
      closePromise: null,
      surface: null,
    }
    const close = (
      reason: unknown = new Error(`Surface ${surfaceId} closed.`)
    ) => {
      if (record.closePromise === null) {
        const attempt = closeSurface(surfaceId, instance, scope, reason)
        record.closePromise = attempt
        void attempt.then(
          () => {
            if (this.#active.get(surfaceId) === record)
              this.#active.delete(surfaceId)
          },
          () => {
            if (record.closePromise === attempt) record.closePromise = null
          }
        )
      }
      return record.closePromise
    }
    const instanceDone = Promise.resolve(instance.done).then(
      async () => await close('surface-complete'),
      async (error: unknown) => {
        try {
          await close(error)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `Surface ${surfaceId} failed and cleanup also failed.`,
            { cause: cleanupError }
          )
        }
        throw error
      }
    )
    let closeOnAbort: (() => void) | null = null
    let resolveAbortClose: (() => void) | null = null
    let rejectAbortClose: ((reason?: unknown) => void) | null = null
    let done: Promise<void> = instanceDone
    if (signal !== undefined) {
      const deferredClose = new Promise<void>((resolve, reject) => {
        resolveAbortClose = resolve
        rejectAbortClose = reject
      })
      closeOnAbort = () => {
        void close(signal.reason).then(
          () => resolveAbortClose?.(),
          (reason: unknown) => rejectAbortClose?.(reason)
        )
      }
      done = Promise.race([instanceDone, deferredClose])
    }
    const surface: ActiveSurface = Object.freeze({
      id: surfaceId,
      owner: contribution.owner,
      done,
      api: instance.api,
      close,
    })
    record.surface = surface
    this.#active.set(surfaceId, record)
    if (signal !== undefined && closeOnAbort !== null) {
      if (signal.aborted) closeOnAbort()
      else {
        signal.addEventListener('abort', closeOnAbort, { once: true })
        void instanceDone.then(
          () => signal.removeEventListener('abort', closeOnAbort),
          () => signal.removeEventListener('abort', closeOnAbort)
        )
      }
    }
    void done.catch(() => undefined)
    return surface
  }

  async #activateFeatures(
    surfaceId: string,
    scope: ExtensionResourceScope,
    signal: AbortSignal,
    kernel: SurfaceKernelBinding
  ): Promise<SurfaceFeatureSet> {
    const active: ActiveSurfaceFeature[] = []
    for (const contribution of this.#featureContributions) {
      if (contribution.value.targetSurfaceId !== surfaceId) continue
      const binding = this.#featureBindingsByTarget.get(contribution.id)
      if (binding === undefined) {
        throw new SurfaceHostError(
          `Surface feature ${contribution.value.id} has no executable activator binding.`
        )
      }
      const featureScope = scope.createChild(
        'surface',
        `${surfaceId}:feature:${contribution.value.id}`
      )
      const services = this.#services.createAccessor({
        scope: featureScope,
        allowedServices: contribution.requiredServices,
        signal,
        deadline: Number.POSITIVE_INFINITY,
      })
      const api = await raceWithAbort(
        Promise.resolve(
          binding.binding({
            featureId: contribution.value.id,
            surfaceId,
            signal,
            scope: featureScope.createRegistration({ signal }),
            services,
            port: kernel.port,
            events: kernel.events,
            commands: kernel.commands,
            host: kernel.snapshot,
            requestStop: async (reason) =>
              await kernel.requestStop(surfaceId, reason),
          })
        ),
        signal,
        `Surface feature ${contribution.value.id} activation was canceled.`
      )
      active.push(
        Object.freeze({
          id: contribution.value.id,
          owner: contribution.owner,
          api,
        })
      )
    }
    const snapshot = Object.freeze([...active])
    return Object.freeze({
      list: () => snapshot,
      get: (featureId: string) =>
        snapshot.find(({ id }) => id === featureId) ?? null,
    })
  }

  public async closeAll(
    reason: unknown = new Error('Surface Host is closing.')
  ): Promise<void> {
    const pending = await Promise.allSettled([...this.#pending.values()])
    const active = [...this.#active.values()].flatMap(({ surface }) =>
      surface === null ? [] : [surface]
    )
    const outcomes = await Promise.allSettled(
      active.map(async (surface) => await surface.close(reason))
    )
    const errors: unknown[] = pending.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : []
    )
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') errors.push(outcome.reason)
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more Surfaces failed to close.')
    }
  }
}

async function closeSurface(
  surfaceId: string,
  instance: SurfaceInstance,
  scope: ExtensionResourceScope,
  reason: unknown
): Promise<void> {
  const errors: unknown[] = []
  try {
    await instance.close(reason)
  } catch (error) {
    errors.push(error)
  }
  try {
    await scope.resourceScope.dispose({ reason })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Surface ${surfaceId} failed to close.`)
  }
}

function assertSurfaceInstance(
  value: SurfaceInstance,
  surfaceId: string
): asserts value is SurfaceInstance {
  if (!isSurfaceInstance(value)) {
    throw new SurfaceHostError(
      `Surface ${surfaceId} activator returned an invalid instance.`
    )
  }
}

function isSurfaceInstance(value: unknown): value is SurfaceInstance {
  return (
    value !== null &&
    typeof value === 'object' &&
    'done' in value &&
    value.done !== null &&
    typeof value.done === 'object' &&
    'then' in value.done &&
    typeof value.done.then === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
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
  return new SurfaceHostError(message, { cause: reason })
}
