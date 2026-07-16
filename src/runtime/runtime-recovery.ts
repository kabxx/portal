import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'

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
}

export function buildRuntimeRecoveryPlan(
  error: unknown,
  context: RuntimeRecoveryContext
): RuntimeRecoveryPlan {
  if (!isProviderAdapterError(error)) {
    return {
      title: 'runtime',
      lines: [
        `Thread ${context.threadId ?? '(pending)'} hit an unexpected error.`,
        'The thread is still kept locally.',
        'Review the error output, then retry the same request if the page state still looks usable.',
      ],
      canRetry: false,
      requiresLogin: false,
    }
  }

  if (error.kind === 'auth') {
    return {
      title: 'login required',
      lines: [
        `${context.provider} is not logged in for the current browser profile.`,
        `Browser profile: ${context.browserProfileDir}`,
        'Complete login in the browser window, then retry the same thread request.',
      ],
      canRetry: true,
      requiresLogin: true,
    }
  }

  if (
    error.retryable ||
    error.recovery === 'restore' ||
    error.recovery === 'reload'
  ) {
    return {
      title: 'temporary runtime issue',
      lines: [
        `The current ${context.provider} thread hit a temporary page or network problem.`,
        'The thread remains active.',
        'Retrying the same request is usually safe after the page recovers.',
      ],
      canRetry: true,
      requiresLogin: false,
    }
  }

  return {
    title: 'thread error',
    lines: [
      `The current ${context.provider} request did not complete.`,
      'The thread remains active.',
      'Fix the browser page state or change the request, then retry manually.',
    ],
    canRetry: false,
    requiresLogin: false,
  }
}

export async function tryRestoreRuntimeForRecovery(
  error: unknown,
  restore: () => Promise<void>
): Promise<void> {
  if (!isProviderAdapterError(error)) {
    return
  }

  if (
    error.kind === 'auth' ||
    error.recovery === 'restore' ||
    error.recovery === 'reload'
  ) {
    await restore()
  }
}
