import type { ChildProcess } from 'node:child_process'

export interface BrowserProcess {
  process: ChildProcess
  browserPid: number
  close(deadline?: number): Promise<void>
}

export class BrowserProcessTreeCleanupError extends Error {
  public readonly code = 'BROWSER_PROCESS_TREE_CLEANUP_FAILED'

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserProcessTreeCleanupError'
  }
}

export function toBrowserProcessTreeCleanupError(
  error: unknown
): BrowserProcessTreeCleanupError {
  if (error instanceof BrowserProcessTreeCleanupError) {
    return error
  }
  return new BrowserProcessTreeCleanupError(
    'Browser process tree cleanup could not be verified.',
    error instanceof Error ? { cause: error } : undefined
  )
}
