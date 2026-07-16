import type { RuntimeCore } from './runtime-core.ts'
import type { ProviderAdapter } from '../providers/adapters/adapter-base.ts'
import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import {
  buildRuntimeRecoveryPlan,
  type RuntimeRecoveryPlan,
} from './runtime-recovery.ts'
import { isAbortError } from './runtime-cancellation.ts'

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

  try {
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
        const runtime = await createRuntime(readyAdapter)
        adapterInFlight = null
        return runtime
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }

        if (isProviderAdapterError(error) && error.adapter !== null) {
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
            await adapterInFlight.close().catch(() => {})
            adapterInFlight = null
          }
          retryAttempts += 1
          if (retryAttempts < maxRetryAttempts) {
            continue
          }

          return null
        }

        if (adapterInFlight !== null) {
          await adapterInFlight.close().catch(() => {})
          adapterInFlight = null
        }
        throw error
      }
    }
  } finally {
    const adapterToClose = pendingAdapter
    if (adapterToClose !== null) {
      await adapterToClose.close().catch(() => {})
    }
  }
}
