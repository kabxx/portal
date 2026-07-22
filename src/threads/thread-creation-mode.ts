export const THREAD_CREATION_MODES = ['agent', 'chat'] as const

export type ThreadCreationMode = (typeof THREAD_CREATION_MODES)[number]

export function isThreadCreationMode(
  value: unknown
): value is ThreadCreationMode {
  return value === 'agent' || value === 'chat'
}
