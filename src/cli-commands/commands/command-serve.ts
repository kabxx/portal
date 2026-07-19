import type {
  CliCommand,
  CliCommandContext,
  ListenerCommandController,
} from '../core/command-types.ts'
import { commandGuideSubcommands } from '../core/command-types.ts'
import { isUnauthenticatedNonLoopbackListener } from '../core/listener-security.ts'

type ListenerTarget = 'api' | 'mcp'

const LISTENERS: Record<
  ListenerTarget,
  {
    label: string
    unavailable: string
    controller: (
      context: CliCommandContext
    ) => ListenerCommandController | undefined
  }
> = {
  api: {
    label: 'HTTP API server',
    unavailable: 'HTTP API is unavailable.',
    controller: (context) => context.api,
  },
  mcp: {
    label: 'MCP Server',
    unavailable: 'MCP Server is unavailable.',
    controller: (context) => context.mcpServer,
  },
}

const SERVE_GUIDES = [
  {
    path: ['api', 'start'],
    usage: 'api start',
    description: 'Start the HTTP API server.',
  },
  {
    path: ['api', 'status'],
    usage: 'api status',
    description: 'Show HTTP API server status.',
  },
  {
    path: ['api', 'stop'],
    usage: 'api stop',
    description: 'Stop the HTTP API server.',
  },
  {
    path: ['api', 'token'],
    usage: 'api token',
    description: 'Show the HTTP API token state.',
  },
  {
    path: ['mcp', 'start'],
    usage: 'mcp start',
    description: 'Start the Portal MCP Server.',
  },
  {
    path: ['mcp', 'status'],
    usage: 'mcp status',
    description: 'Show Portal MCP Server status.',
  },
  {
    path: ['mcp', 'stop'],
    usage: 'mcp stop',
    description: 'Stop the Portal MCP Server.',
  },
  {
    path: ['mcp', 'token'],
    usage: 'mcp token',
    description: 'Show the Portal MCP token state.',
  },
] as const

export const ServeCommand: CliCommand = {
  name: '/serve',
  usage: '/serve <api|mcp> <start|status|stop|token>',
  description: 'Manage Portal network listeners.',
  subcommands: commandGuideSubcommands(SERVE_GUIDES),
  guides: SERVE_GUIDES,
  async execute(context: CliCommandContext, args: readonly string[]) {
    const target = parseListenerTarget(args[0])
    if (target === null) {
      renderServeHelp(context)
      return { continue: true }
    }
    const definition = LISTENERS[target]
    const controller = definition.controller(context)
    const title = `/serve ${target}`
    if (controller === undefined) {
      context.ui.renderError(title, definition.unavailable)
      return { continue: true }
    }
    const action = args[1] ?? ''
    if (action === 'start') {
      try {
        await controller.start()
        context.ui.renderSuccess(
          `${title} start`,
          `${definition.label} started.`
        )
        if (isUnauthenticatedNonLoopbackListener(controller.status())) {
          context.ui.renderWarning(
            `${title} start`,
            'Authentication is disabled on a non-loopback listener.'
          )
        }
      } catch (error) {
        context.ui.renderError(`${title} start`, getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'stop') {
      try {
        await controller.stop()
        context.ui.renderSuccess(
          `${title} stop`,
          `${definition.label} stopped.`
        )
      } catch (error) {
        context.ui.renderError(`${title} stop`, getErrorMessage(error))
      }
      return { continue: true }
    }
    if (action === 'token') {
      const token = controller.token()
      context.ui.renderInfo(
        `${title} token`,
        token === null || token === '' ? 'Authentication disabled.' : token
      )
      return { continue: true }
    }
    if (action === 'status') {
      const status = controller.status()
      context.ui.renderInfo(`${title} status`, [
        `Running: ${status.running ? 'yes' : 'no'}`,
        `Address: ${status.address ?? '-'}`,
        `Authentication: ${status.auth ? 'enabled' : 'disabled'}`,
      ])
      return { continue: true }
    }
    context.ui.renderInfo(title, [
      'Subcommands:',
      `  start   Start the ${definition.label}.`,
      '  status  Show server status.',
      `  stop    Stop the ${definition.label}.`,
      '  token   Show the configured token state.',
    ])
    return { continue: true }
  },
}

function parseListenerTarget(value: string | undefined): ListenerTarget | null {
  return value === 'api' || value === 'mcp' ? value : null
}

function renderServeHelp(context: CliCommandContext): void {
  context.ui.renderInfo('/serve', [
    'Listeners:',
    '  api  Local HTTP API server.',
    '  mcp  Portal MCP Server.',
    '',
    'Usage: /serve <api|mcp> <start|status|stop|token>',
  ])
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
