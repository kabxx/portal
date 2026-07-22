import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { abortableSleep } from './sleep.ts'

type WaitOptions = {
  timeoutMs?: number | null
  continueIf?: (startedAt: number, currentAt: number) => Promise<boolean>
  onPending?: (startedAt: number, currentAt: number) => Promise<void>
  onError?: (error: unknown) => Promise<void>
  onTimeout?: () => Promise<void>
  signal?: AbortSignal | undefined
}

export async function waitAsync(
  predicate: () => Promise<boolean>,
  {
    timeoutMs = 60000,
    signal,
    continueIf = async (s: number, c: number) =>
      timeoutMs === null || s + timeoutMs > c,
    onPending = async (_s: number, _c: number) => {
      await abortableSleep(100, signal)
    },
    onError = async (e: unknown) => {
      throw e
    },
    onTimeout = async () => {
      throw new Error('waitAsync timed out')
    },
  }: WaitOptions = {}
): Promise<void> {
  const startedAt = Date.now()
  while (await continueIf(startedAt, Date.now())) {
    throwIfAborted(signal)
    try {
      if (await predicate()) {
        return
      }
      await onPending(startedAt, Date.now())
      throwIfAborted(signal)
    } catch (error) {
      await onError(error)
    }
  }
  throwIfAborted(signal)
  await onTimeout()
}
