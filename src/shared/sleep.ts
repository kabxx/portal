import {
  getAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'

export function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function sleepWithAbortAsync(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(getAbortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const abortableSleep = sleepWithAbortAsync
