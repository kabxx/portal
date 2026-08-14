import type { CliCommand, CliCommandContext } from '../core/command-types.ts'
import { commandGuideSubcommands } from '../core/command-types.ts'

const MCP_GUIDES = [
  {
    path: ['start'],
    usage: 'start',
    description: 'Start the Portal MCP Server.',
  },
  {
    path: ['status'],
    usage: 'status',
    description: 'Show Portal MCP Server status.',
  },
  {
    path: ['stop'],
    usage: 'stop',
    description: 'Stop the Portal MCP Server.',
  },
  {
    path: ['token'],
    usage: 'token',
    description: 'Show the Portal MCP token state.',
  },
] as const

export const McpCommand: CliCommand = {
  name: '/mcp',
  usage: '/mcp <start|status|stop|token>',
  description: 'Manage the Portal MCP Server.',
  subcommands: commandGuideSubcommands(MCP_GUIDES),
  guides: MCP_GUIDES,
  async execute(context: CliCommandContext, args: readonly string[]) {
    const controller = context.mcpServer
    if (controller === undefined) {
      context.ui.renderError('/mcp', 'MCP Server is unavailable.')
      return { continue: true }
    }

    const action = args[0] ?? ''
    if (action === 'start') {
      try {
        await controller.start()
        context.ui.renderSuccess('/mcp start', 'MCP Server started.')
      } catch (error) {
        context.ui.renderError('/mcp start', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'stop') {
      try {
        await controller.stop()
        context.ui.renderSuccess('/mcp stop', 'MCP Server stopped.')
      } catch (error) {
        context.ui.renderError('/mcp stop', getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'token') {
      const status = controller.status()
      context.ui.renderInfo(
        '/mcp token',
        status.auth ? 'Authentication configured.' : 'Authentication disabled.'
      )
      return { continue: true }
    }
    if (action === 'status') {
      const status = controller.status()
      const authentication = status.auth
        ? status.running
          ? 'enabled'
          : 'configured'
        : 'disabled'
      context.ui.renderInfo('/mcp status', [
        `Running: ${status.running ? 'yes' : 'no'}`,
        `Address: ${status.address ?? '-'}`,
        `Authentication: ${authentication}`,
      ])
      return { continue: true }
    }

    renderMcpHelp(context)
    return { continue: true }
  },
}

function renderMcpHelp(context: CliCommandContext): void {
  context.ui.renderInfo('/mcp', [
    'Subcommands:',
    '  start   Start the Portal MCP Server.',
    '  status  Show server status.',
    '  stop    Stop the Portal MCP Server.',
    '  token   Show the configured token state.',
  ])
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
