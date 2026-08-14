export class ExecUsageError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ExecUsageError'
  }
}

export function resolveExecTask(
  promptArguments: readonly string[],
  stdinText: string,
  stdinIsTty: boolean
): string {
  const dashIndex = promptArguments.indexOf('-')
  if (dashIndex !== -1) {
    if (promptArguments.length !== 1) {
      throw new ExecUsageError(
        'The stdin marker "-" cannot be combined with prompt arguments.'
      )
    }
    if (stdinIsTty) {
      throw new ExecUsageError('The stdin marker "-" requires piped input.')
    }
    return requireTask(stdinText)
  }

  const prompt = promptArguments.join(' ').trim()
  const stdin = stdinIsTty ? '' : stdinText.trim()
  if (prompt && stdin) {
    return `${prompt}\n\n${stdin}`
  }
  return requireTask(prompt || stdin)
}

export function parseExecTimeoutSeconds(
  value: string | undefined
): number | null {
  if (value === undefined) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ExecUsageError('--timeout must be a positive number of seconds.')
  }
  return seconds
}

function requireTask(value: string): string {
  const task = value.trim()
  if (!task) {
    throw new ExecUsageError(
      'A prompt or piped stdin is required. Run portal exec --help for usage.'
    )
  }
  return task
}
