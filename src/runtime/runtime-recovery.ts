import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import { formatProviderDisplayName } from '../providers/provider-display-name.ts'

export interface RuntimeRecoveryContext {
  provider: string
  browserProfileDir: string
  threadId?: string | null
}

export interface RuntimeRecoveryPlan {
  title: string
  lines: string[]
  canRetry: boolean
  requiresLogin: boolean
  requiresHumanInput: boolean
  showFallbackError: boolean
}

export function buildRuntimeRecoveryPlan(
  error: unknown,
  context: RuntimeRecoveryContext
): RuntimeRecoveryPlan {
  if (!isProviderAdapterError(error)) {
    return {
      title: 'runtime',
      lines: [
        `Thread ${context.threadId ?? '(pending)'} stopped unexpectedly; check the browser before retrying.`,
      ],
      canRetry: false,
      requiresLogin: false,
      requiresHumanInput: false,
      showFallbackError: true,
    }
  }

  if (error.kind === 'auth') {
    return {
      title: 'login required',
      lines: [
        `Sign in to ${formatProviderDisplayName(context.provider)} in the browser; Portal will continue automatically.`,
      ],
      canRetry: true,
      requiresLogin: true,
      requiresHumanInput: false,
      showFallbackError: false,
    }
  }

  if (
    error.retryable ||
    error.recovery === 'restore' ||
    error.recovery === 'reload'
  ) {
    return {
      title: 'temporary runtime issue',
      lines: [error.message],
      canRetry: true,
      requiresLogin: false,
      requiresHumanInput: false,
      showFallbackError: false,
    }
  }

  return {
    title: 'thread error',
    lines: [error.message],
    canRetry: false,
    requiresLogin: false,
    requiresHumanInput: false,
    showFallbackError: true,
  }
}

export async function tryRestoreRuntimeForRecovery(
  error: unknown,
  restore: () => Promise<void>
): Promise<void> {
  if (!isProviderAdapterError(error)) {
    return
  }

  if (error.kind === 'auth') {
    return
  }

  if (error.recovery === 'restore' || error.recovery === 'reload') {
    await restore()
  }
}
