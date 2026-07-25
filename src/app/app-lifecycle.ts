const SHUTDOWN_CLOSE_TIMEOUT_MS = 3000

export interface StopTarget {
  stopGeneration(): Promise<void>
}

export interface McpForegroundOperation {
  controller: AbortController
  stopTarget: StopTarget | null
  done: Promise<unknown>
  cancellation: Promise<void> | null
}

export class PortalExitError extends Error {
  public constructor() {
    super('Portal is exiting.')
    this.name = 'PortalExitError'
  }
}

export async function closeWithTimeout(
  close: () => Promise<void>,
  timeoutMs = SHUTDOWN_CLOSE_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } catch {
    // Shutdown is best-effort; timeout cleanup still runs below.
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

export function createIdempotentAsyncTask(
  task: () => Promise<void>
): () => Promise<void> {
  let taskPromise: Promise<void> | null = null
  return async () => {
    taskPromise ??= task()
    await taskPromise
  }
}

export async function closeLateBrowserLaunchAfterShutdown(
  browserLaunch: { close(): Promise<void> } | null,
  shutdown: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  await shutdown()
  if (browserLaunch !== null) {
    await closeWithTimeout(async () => await browserLaunch.close(), timeoutMs)
  }
}

export async function stopMcpForegroundOperation(
  operation: McpForegroundOperation,
  timeoutMs: number
): Promise<void> {
  operation.controller.abort()
  operation.cancellation ??= Promise.allSettled([
    Promise.resolve().then(
      async () => await operation.stopTarget?.stopGeneration()
    ),
    operation.done,
  ]).then(() => {})
  await closeWithTimeout(async () => await operation.cancellation!, timeoutMs)
}

export function transitionLoginWaitWarning(
  waitingForLogin: boolean,
  requiresLogin: boolean
): { waitingForLogin: boolean; shouldRender: boolean } {
  return {
    waitingForLogin: requiresLogin,
    shouldRender: !requiresLogin || !waitingForLogin,
  }
}
