import type { CliCommand, CliCommandContext } from '../core/command-types.ts'
import { isUnauthenticatedNonLoopbackListener } from '../core/listener-security.ts'

export const McpServerCommand: CliCommand = {
  name: '/mcp-server',
  usage: '/mcp-server <start|status|stop|token>',
  description: 'Manage the Portal MCP Server.',
  subcommands: ['start', 'status', 'stop', 'token'],
  async execute(context: CliCommandContext, args: readonly string[]) {
    if (context.mcpServer === undefined) {
      context.ui.renderError('/mcp-server', 'MCP Server is unavailable.')
      return { continue: true }
    }
    const action = args[0] ?? ''
    if (action === 'start') {
      try {
        await context.mcpServer.start()
        context.ui.renderSuccess('/mcp-server start', 'MCP Server started.')
        if (isUnauthenticatedNonLoopbackListener(context.mcpServer.status())) {
          context.ui.renderWarning(
            '/mcp-server start',
            'Authentication is disabled on a non-loopback listener.'
          )
        }
      } catch (error) {
        context.ui.renderError('/mcp-server start', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'stop') {
      try {
        await context.mcpServer.stop()
        context.ui.renderSuccess('/mcp-server stop', 'MCP Server stopped.')
      } catch (error) {
        context.ui.renderError('/mcp-server stop', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'token') {
      const token = context.mcpServer.token()
      context.ui.renderInfo(
        '/mcp-server token',
        token === null || token === '' ? 'Authentication disabled.' : token
      )
      return { continue: true }
    }
    if (action === 'status') {
      const status = context.mcpServer.status()
      context.ui.renderInfo('/mcp-server status', [
        `Running: ${status.running ? 'yes' : 'no'}`,
        `Address: ${status.address ?? '-'}`,
        `Authentication: ${status.auth ? 'enabled' : 'disabled'}`,
      ])
      return { continue: true }
    }
    context.ui.renderInfo('/mcp-server', [
      'Subcommands:',
      '  start   Start the Portal MCP Server.',
      '  status  Show server status.',
      '  stop    Stop the Portal MCP Server.',
      '  token   Show the configured token state.',
    ])
    return { continue: true }
  },
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
