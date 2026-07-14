type RetryOptions = {
  retryIf?: (error: unknown, attempt: number) => Promise<boolean>
  onRetry?: (error: unknown, attempt: number) => Promise<void>
  onError?: (error: unknown, attempt: number) => Promise<void>
  maxAttempts?: number
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  {
    retryIf = async () => false,
    onRetry = async () => {},
    onError = async (e, _) => {
      throw e
    },
    maxAttempts = 3,
  }: RetryOptions = {}
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      const nextAttempt = attempt + 1
      const shouldRetry =
        nextAttempt < Math.max(1, Math.trunc(maxAttempts)) &&
        (await retryIf(error, attempt))
      if (!shouldRetry) {
        await onError(error, attempt)
      }
      await onRetry(error, attempt)
    } finally {
      attempt++
    }
  }
}
