import { sleepAsync } from './sleep.ts'

type RepeatOptions = {
  repeatIf?: (attempt: number) => Promise<boolean>
  onRepeat?: (attempt: number) => Promise<void>
}

export async function repeatAsync<T>(
  fn: () => Promise<T>,
  {
    repeatIf = async (attempt: number) => attempt < 3,
    onRepeat = async () => {
      await sleepAsync(100)
    },
  }: RepeatOptions = {}
): Promise<readonly T[]> {
  let attempt = 0
  const results: T[] = []
  while (await repeatIf(attempt)) {
    results.push(await fn())
    attempt += 1
    await onRepeat(attempt)
  }
  return results
}
