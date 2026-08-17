import type { ExtensionRegistrationApi } from '../extensions/extension-contracts.ts'
import {
  commandContributions,
  commandHandlerBindings,
} from '../cli-commands/core/command-plan.ts'
import {
  commandMcpService,
  commandOutputService,
} from '../cli-commands/core/command-services.ts'
import type {
  CommandContribution,
  CommandExecutionContext,
  CommandHelpRow,
  CommandResult,
  PreparedCommandInvocation,
} from '../cli-commands/core/command-contracts.ts'
import { isAbortError } from '../runtime/runtime-cancellation.ts'

const CONTINUE: CommandResult = Object.freeze({ disposition: 'continue' })

const MCP_HELP: readonly CommandHelpRow[] = Object.freeze([
  help('start', 'Start the Portal MCP Server.'),
  help('status', 'Show Portal MCP Server status.'),
  help('stop', 'Stop the Portal MCP Server.'),
  help('token', 'Show the Portal MCP token state.'),
])

const MCP_COMMAND: CommandContribution = Object.freeze({
  id: 'commands.mcp',
  primaryName: '/mcp',
  aliases: Object.freeze([]),
  usage: '/mcp <start|status|stop|token>',
  description: 'Manage the Portal MCP Server.',
  routes: Object.freeze([
    route('root', [], MCP_HELP),
    route('start', ['start'], [MCP_HELP[0]!]),
    route('status', ['status'], [MCP_HELP[1]!]),
    route('stop', ['stop'], [MCP_HELP[2]!]),
    route('token', ['token'], [MCP_HELP[3]!]),
  ]),
})

export function registerMcpCommand(api: ExtensionRegistrationApi): void {
  api.contribute(commandContributions, {
    id: MCP_COMMAND.id,
    value: MCP_COMMAND,
    requiredServices: [commandOutputService, commandMcpService],
    requiredCapabilities: ['portal.command.mcp.manage'],
    after: ['commands.thread'],
  })
  api.bind(commandHandlerBindings, {
    id: `${MCP_COMMAND.id}.handler`,
    targetId: MCP_COMMAND.id,
    binding: mcpHandler,
  })
}

async function mcpHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await context.services.get(commandOutputService)
  const mcp = await context.services.get(commandMcpService)
  const action = invocation.routeId
  try {
    if (action === 'start') {
      await mcp.start(context.signal)
      output.write({
        level: 'success',
        title: '/mcp start',
        body: 'MCP Server started.',
      })
      return CONTINUE
    }
    if (action === 'stop') {
      await mcp.stop(context.signal)
      output.write({
        level: 'success',
        title: '/mcp stop',
        body: 'MCP Server stopped.',
      })
      return CONTINUE
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    output.write({
      level: 'error',
      title: `/mcp ${action}`,
      body: error instanceof Error ? error.message : String(error),
    })
    return CONTINUE
  }
  const status = mcp.status()
  if (action === 'token') {
    output.write({
      level: 'info',
      title: '/mcp token',
      body: status.auth
        ? 'Authentication configured.'
        : 'Authentication disabled.',
    })
    return CONTINUE
  }
  if (action === 'status') {
    const authentication = status.auth
      ? status.running
        ? 'enabled'
        : 'configured'
      : 'disabled'
    output.write({
      level: 'info',
      title: '/mcp status',
      body: [
        `Running: ${status.running ? 'yes' : 'no'}`,
        `Address: ${status.address ?? '-'}`,
        `Authentication: ${authentication}`,
      ],
    })
    return CONTINUE
  }
  output.write({
    level: 'info',
    title: '/mcp',
    body: [
      'Subcommands:',
      ...MCP_HELP.map(({ usage, description }) => `  ${usage}  ${description}`),
    ],
  })
  return CONTINUE
}

function route(
  id: string,
  path: readonly string[],
  helpRows: readonly CommandHelpRow[]
) {
  return Object.freeze({
    id,
    path,
    availability: 'always' as const,
    positionals: Object.freeze([]),
    options: Object.freeze([]),
    constraints: Object.freeze([]),
    help: helpRows,
  })
}

function help(usage: string, description: string): CommandHelpRow {
  return Object.freeze({ usage, description })
}
