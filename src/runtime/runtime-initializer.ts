import type { RuntimeCore } from './runtime-core.ts'
import {
  ProviderAdapter,
  isProviderAdapterError,
} from '../providers/adapters/adapter-base.ts'
import {
  buildRuntimeRecoveryPlan,
  type RuntimeRecoveryPlan,
} from './runtime-recovery.ts'
import { isAbortError, throwIfAborted } from './runtime-cancellation.ts'

export interface RuntimeInitializationOptions {
  provider: string
  browserProfileDir: string
  threadId: string
  createAdapter: () => Promise<ProviderAdapter>
  createRuntime: (adapter: ProviderAdapter) => Promise<RuntimeCore>
  onWarning: (plan: RuntimeRecoveryPlan) => void | Promise<void>
  onLoginWait: (provider: string) => void | Promise<void>
  waitForLogin: () => Promise<void>
  signal?: AbortSignal | undefined
  maxRetryAttempts?: number
}

export class RuntimeInitializationCleanupError extends AggregateError {
  public constructor(primaryError: unknown, cleanupErrors: readonly unknown[]) {
    super(
      [primaryError, ...cleanupErrors],
      'Provider adapter initialization failed to clean up.',
      { cause: cleanupErrors[0] }
    )
    this.name = 'RuntimeInitializationCleanupError'
  }
}

export async function initializeRuntimeWithLoginWait({
  provider,
  browserProfileDir,
  threadId,
  createAdapter,
  createRuntime,
  onWarning,
  onLoginWait,
  waitForLogin,
  signal,
  maxRetryAttempts = 3,
}: RuntimeInitializationOptions): Promise<RuntimeCore | null> {
  let pendingAdapter: ProviderAdapter | null = null
  let adapterInFlight: ProviderAdapter | null = null
  let retryAttempts = 0

  const outcome = await settleRuntimeInitialization(
    (async (): Promise<RuntimeCore | null> => {
      while (true) {
        try {
          const adapter = pendingAdapter
          if (adapter !== null) {
            if (!(await adapter.isLoggedIn())) {
              await onLoginWait(provider)
              await waitForLogin()
              continue
            }
            await adapter.restore({ signal })
          }
          const readyAdapter = adapter ?? (await createAdapter())
          pendingAdapter = null
          adapterInFlight = readyAdapter
          throwIfAborted(signal)
          const runtime = await createRuntime(readyAdapter)
          adapterInFlight = null
          return runtime
        } catch (error) {
          if (isAbortError(error)) {
            throw error
          }

          if (
            isProviderAdapterError(error) &&
            error.adapter instanceof ProviderAdapter
          ) {
            pendingAdapter = error.adapter
            adapterInFlight = null
          }

          const plan = buildRuntimeRecoveryPlan(error, {
            provider,
            browserProfileDir,
            threadId,
          })
          await onWarning(plan)
          if (plan.requiresLogin) {
            await onLoginWait(provider)
            await waitForLogin()
            continue
          }

          if (plan.canRetry) {
            if (adapterInFlight !== null) {
              const adapterToClose = adapterInFlight
              adapterInFlight = null
              await closeAdapterAfterFailure(adapterToClose, error)
            }
            retryAttempts += 1
            if (retryAttempts < maxRetryAttempts) {
              continue
            }

            return null
          }

          if (adapterInFlight !== null) {
            const adapterToClose = adapterInFlight
            adapterInFlight = null
            await closeAdapterAfterFailure(adapterToClose, error)
          }
          throw error
        }
      }
    })()
  )

  const adaptersToClose = collectOwnedAdapters(pendingAdapter, adapterInFlight)
  pendingAdapter = null
  adapterInFlight = null
  const cleanupErrors: unknown[] = []
  for (const adapter of adaptersToClose) {
    try {
      await closeProviderAdapter(adapter)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (outcome.status === 'rejected') {
    if (cleanupErrors.length > 0) {
      throw new RuntimeInitializationCleanupError(outcome.reason, cleanupErrors)
    }
    throw outcome.reason
  }
  if (cleanupErrors.length > 0) {
    throw new RuntimeInitializationCleanupError(null, cleanupErrors)
  }
  return outcome.value
}

type RuntimeInitializationOutcome =
  | { readonly status: 'fulfilled'; readonly value: RuntimeCore | null }
  | { readonly status: 'rejected'; readonly reason: unknown }

async function settleRuntimeInitialization(
  operation: Promise<RuntimeCore | null>
): Promise<RuntimeInitializationOutcome> {
  try {
    return { status: 'fulfilled', value: await operation }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

function collectOwnedAdapters(
  pendingAdapter: ProviderAdapter | null,
  adapterInFlight: ProviderAdapter | null
): Set<ProviderAdapter> {
  const adapters = new Set<ProviderAdapter>()
  if (pendingAdapter !== null) adapters.add(pendingAdapter)
  if (adapterInFlight !== null) adapters.add(adapterInFlight)
  return adapters
}

async function closeProviderAdapter(adapter: ProviderAdapter): Promise<void> {
  await adapter.close()
}

async function closeAdapterAfterFailure(
  adapter: ProviderAdapter,
  failure: unknown
): Promise<void> {
  try {
    await adapter.close()
  } catch (cleanupError) {
    throw new RuntimeInitializationCleanupError(failure, [cleanupError])
  }
}
