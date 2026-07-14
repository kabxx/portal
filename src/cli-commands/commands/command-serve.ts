import type {
  CliCommand,
  CliCommandContext,
  CommandResult,
} from '../core/command-types.ts'

export const ServeCommand: CliCommand = {
  name: '/serve',
  usage: '/serve <start|status|stop|token>',
  description: 'Manage the local HTTP API server.',
  subcommands: ['start', 'status', 'stop', 'token'],
  async execute(context: CliCommandContext, args: readonly string[]) {
    if (context.api === undefined) {
      context.ui.renderError('/serve', 'HTTP API is unavailable.')
      return { continue: true }
    }
    const action = args[0] ?? ''
    if (action === 'start') {
      try {
        await context.api.start()
        context.ui.renderSuccess('/serve start', 'HTTP API server started.')
      } catch (error) {
        context.ui.renderError('/serve start', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'stop') {
      try {
        await context.api.stop()
        context.ui.renderSuccess('/serve stop', 'HTTP API server stopped.')
      } catch (error) {
        context.ui.renderError('/serve stop', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'token') {
      const token = context.api.token()
      context.ui.renderInfo(
        '/serve token',
        token === null ? 'Authentication disabled.' : token
      )
      return { continue: true }
    }
    if (action === 'status') {
      const status = context.api.status()
      context.ui.renderInfo('/serve status', [
        `Running: ${status.running ? 'yes' : 'no'}`,
        `Address: ${status.address ?? '-'}`,
        `Authentication: ${status.auth ? 'enabled' : 'disabled'}`,
      ])
      return { continue: true }
    }
    context.ui.renderInfo('/serve', [
      'Subcommands:',
      '  start   Start the HTTP API server.',
      '  status  Show server status.',
      '  stop    Stop the HTTP API server.',
      '  token   Show the configured token state.',
    ])
    return { continue: true }
  },
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
