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

export function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(
    typeof error === 'string' && error ? error : fallbackMessage,
    { cause: error }
  )
}

export function getAbortError(signal?: AbortSignal): PortalAbortError {
  const reason: unknown = signal?.reason
  return reason instanceof PortalAbortError
    ? reason
    : new PortalAbortError(reason instanceof Error ? reason.message : undefined)
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw getAbortError(signal)
  }
}

export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) {
    return promise.catch((error: unknown) => {
      throw toError(error, 'Operation failed.')
    })
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(toError(error, 'Operation aborted.'))
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
        reject(toError(error, 'Operation failed.'))
      }
    )
  })
}

export { PortalAbortError as PortalCancellationError }
export const isPortalCancellationError = isAbortError
