export interface AbortOptions {
  signal?: AbortSignal | undefined
}

export class PortalAbortError extends Error {
  public constructor(message = 'Operation aborted.') {
    super(message)
    this.name = 'AbortError'
  }
}

export function isAbortError(error: unknown): error is Error {
  return (
    error instanceof PortalAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    throw reason instanceof PortalAbortError
      ? reason
      : new PortalAbortError(
          reason instanceof Error ? reason.message : undefined
        )
  }
}

export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) {
    return promise
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export { PortalAbortError as PortalCancellationError }
export const isPortalCancellationError = isAbortError
