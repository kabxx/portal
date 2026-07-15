import type { ListenerCommandController } from './command-types.ts'

export function isUnauthenticatedNonLoopbackListener(
  status: ReturnType<ListenerCommandController['status']>
): boolean {
  if (!status.running || status.auth || status.address === null) {
    return false
  }
  try {
    const hostname = new URL(status.address).hostname.replace(/^\[|\]$/g, '')
    return !(
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('::ffff:127.')
    )
  } catch {
    return false
  }
}
