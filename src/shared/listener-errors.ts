type ListenerErrorCode = 'EADDRINUSE' | 'EACCES'

export function normalizeListenerStartError(
  error: unknown,
  service: string,
  host: string,
  port: number
): unknown {
  const code = getErrorCode(error)
  if (code !== 'EADDRINUSE' && code !== 'EACCES') {
    return error
  }

  const reason =
    code === 'EADDRINUSE' ? 'address is already in use' : 'permission denied'
  return Object.assign(
    new Error(
      `${service} could not listen on ${formatHostPort(host, port)}: ${reason}.`,
      { cause: error }
    ),
    { code }
  )
}

function getErrorCode(error: unknown): ListenerErrorCode | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return null
  }
  return error.code === 'EADDRINUSE' || error.code === 'EACCES'
    ? error.code
    : null
}

function formatHostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}
