import type {
  CommandContribution,
  CommandExecutionContext,
  CommandHandler,
  CommandHelpRow,
  CommandResult,
  CommandRouteSpec,
  PreparedCommandInvocation,
} from './core/command-contracts.ts'
import type { ServiceRef } from '../extensions/extension-contracts.ts'
import {
  commandCatalogService,
  commandKeybindingService,
  commandMcpService,
  commandOutputService,
  commandProviderService,
  commandSkillService,
  commandThreadService,
  type CommandOutputMessage,
  type CommandOutputService,
} from './core/command-services.ts'
import type { BuiltinCommandDefinition } from './command-extension.ts'

const CONTINUE: CommandResult = Object.freeze({ disposition: 'continue' })
const REQUEST_STOP: CommandResult = Object.freeze({
  disposition: 'request-stop',
})

const THREAD_HELP: readonly CommandHelpRow[] = Object.freeze([
  help('agent <provider> [model-key] [option-key]', 'Create an agent thread.'),
  help(
    'chat <provider> [model-key] [option-key]',
    'Create a chat thread with only the setup handshake.'
  ),
  help('list', 'List local threads.'),
  help('history [limit]', 'Show thread history.'),
  help('resume <conversation-url|#history-id>', 'Resume a conversation.'),
  help('reload', 'Reload the active provider page.'),
  help('switch <thread-id>', 'Switch to another thread.'),
  help('status', 'Show active thread status.'),
  help('close [thread-id]', 'Close a thread.'),
  help('detach', 'Detach from the active thread.'),
  help('capability [name] [action]', 'Show or change thread capabilities.'),
])

const SKILL_HELP: readonly CommandHelpRow[] = Object.freeze([
  help('add <local-directory>', 'Register a skill from a local directory.'),
  help('add <url>', 'Download and install a skill.'),
  help('add <name> --registry <url>', 'Install a named skill from a registry.'),
  help('list', 'List registered skills.'),
  help('enable <name>', 'Enable a registered skill for new threads.'),
  help('disable <name>', 'Disable a registered skill for new threads.'),
  help('remove <name>', 'Remove a registered skill.'),
])

const MCP_HELP: readonly CommandHelpRow[] = Object.freeze([
  help('start', 'Start the Portal MCP Server.'),
  help('status', 'Show Portal MCP Server status.'),
  help('stop', 'Stop the Portal MCP Server.'),
  help('token', 'Show the Portal MCP token state.'),
])

const commandRoutes = {
  thread: Object.freeze([
    route('root', [], 'always', [], [], THREAD_HELP),
    route(
      'agent',
      ['agent'],
      'always',
      threadCreationPositionals(),
      [],
      [THREAD_HELP[0]!]
    ),
    route(
      'chat',
      ['chat'],
      'always',
      threadCreationPositionals(),
      [],
      [THREAD_HELP[1]!]
    ),
    route('list', ['list'], 'always', [], [], [THREAD_HELP[2]!]),
    route(
      'history',
      ['history'],
      'always',
      [optional('limit')],
      [],
      [THREAD_HELP[3]!]
    ),
    route(
      'resume',
      ['resume'],
      'always',
      [required('target')],
      [],
      [THREAD_HELP[4]!]
    ),
    route('reload', ['reload'], 'thread-idle', [], [], [THREAD_HELP[5]!]),
    route(
      'switch',
      ['switch'],
      'always',
      [required('thread-id')],
      [],
      [THREAD_HELP[6]!]
    ),
    route('status', ['status'], 'always', [], [], [THREAD_HELP[7]!]),
    route(
      'close',
      ['close'],
      'always',
      [optional('thread-id')],
      [],
      [THREAD_HELP[8]!]
    ),
    route('detach', ['detach'], 'always', [], [], [THREAD_HELP[9]!]),
    route(
      'capability',
      ['capability'],
      'thread-idle',
      [optional('name'), optional('action')],
      [],
      [THREAD_HELP[10]!]
    ),
  ]),
  skill: Object.freeze([
    route('root', [], 'always', [], [], SKILL_HELP),
    route(
      'add',
      ['add'],
      'thread-idle',
      [oneOrMore('source')],
      [option('--registry', 'url')],
      SKILL_HELP.slice(0, 3),
      [
        constraint('option-requires-single-positional', '--registry', 'source'),
        constraint(
          'option-forbids-http-url-positional',
          '--registry',
          'source'
        ),
      ]
    ),
    route('list', ['list'], 'always', [], [], [SKILL_HELP[3]!]),
    route(
      'enable',
      ['enable'],
      'thread-idle',
      [required('name')],
      [],
      [SKILL_HELP[4]!]
    ),
    route(
      'disable',
      ['disable'],
      'thread-idle',
      [required('name')],
      [],
      [SKILL_HELP[5]!]
    ),
    route(
      'remove',
      ['remove'],
      'thread-idle',
      [required('name')],
      [],
      [SKILL_HELP[6]!]
    ),
  ]),
  mcp: Object.freeze([
    route('root', [], 'always', [], [], MCP_HELP),
    route('start', ['start'], 'always', [], [], [MCP_HELP[0]!]),
    route('status', ['status'], 'always', [], [], [MCP_HELP[1]!]),
    route('stop', ['stop'], 'always', [], [], [MCP_HELP[2]!]),
    route('token', ['token'], 'always', [], [], [MCP_HELP[3]!]),
  ]),
} as const

const HELP_COMMAND: CommandContribution = command(
  'commands.help',
  '/help',
  'Show command help.',
  '/help',
  [route('root', [], 'always', [], [], [])]
)

const EXIT_COMMAND: CommandContribution = command(
  'commands.exit',
  '/exit',
  'Exit portal.',
  '/exit',
  [route('root', [], 'always', [], [], [])]
)

const PROVIDERS_COMMAND: CommandContribution = command(
  'commands.providers',
  '/providers',
  'List supported providers.',
  '/providers',
  [route('root', [], 'always', [], [], [])]
)

const THREAD_COMMAND: CommandContribution = command(
  'commands.thread',
  '/thread',
  'Manage threads.',
  '/thread <subcommand>',
  commandRoutes.thread
)

const SKILL_COMMAND: CommandContribution = command(
  'commands.skill',
  '/skill',
  'Manage registered skills.',
  '/skill <subcommand>',
  commandRoutes.skill
)

const MCP_COMMAND: CommandContribution = command(
  'commands.mcp',
  '/mcp',
  'Manage the Portal MCP Server.',
  '/mcp <start|status|stop|token>',
  commandRoutes.mcp
)

const KEYBINDING_COMMAND: CommandContribution = command(
  'commands.keybinding',
  '/keybinding',
  'Restore terminal shortcuts to platform defaults.',
  '/keybinding reset',
  [
    route(
      'root',
      [],
      'always',
      [],
      [],
      [help('reset', 'Restore platform-default keybindings.')]
    ),
    route(
      'reset',
      ['reset'],
      'always',
      [],
      [],
      [help('reset', 'Restore platform-default keybindings.')]
    ),
  ]
)

export const skillCommandDefinition: BuiltinCommandDefinition = definition(
  SKILL_COMMAND,
  skillHandler,
  [commandOutputService, commandSkillService],
  ['portal.command.skill.read', 'portal.command.skill.manage']
)

export const portalCommandDefinitions: readonly BuiltinCommandDefinition[] =
  Object.freeze([
    definition(
      HELP_COMMAND,
      helpHandler,
      [commandOutputService, commandCatalogService],
      []
    ),
    definition(
      THREAD_COMMAND,
      threadHandler,
      [commandOutputService, commandThreadService, commandProviderService],
      [
        'portal.command.thread.read',
        'portal.command.thread.manage',
        'portal.command.provider.capability.manage',
      ]
    ),
    definition(
      MCP_COMMAND,
      mcpHandler,
      [commandOutputService, commandMcpService],
      ['portal.command.mcp.manage']
    ),
    definition(
      KEYBINDING_COMMAND,
      keybindingHandler,
      [commandOutputService, commandKeybindingService],
      ['portal.command.keybinding.manage']
    ),
    definition(
      PROVIDERS_COMMAND,
      providersHandler,
      [commandOutputService, commandProviderService],
      []
    ),
    definition(EXIT_COMMAND, exitHandler, [], []),
  ])

export const builtinCommandDefinitions: readonly BuiltinCommandDefinition[] =
  Object.freeze([
    ...portalCommandDefinitions.slice(0, 2),
    skillCommandDefinition,
    ...portalCommandDefinitions.slice(2),
  ])

async function helpHandler(
  _invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const catalog = await getService(context, commandCatalogService)
  const usageWidth = Math.max(
    0,
    ...catalog.list().map((item) => item.usage.length)
  )
  output.write({
    level: 'info',
    title: '/help',
    body: [
      'Commands:',
      ...catalog
        .list()
        .map(
          (item) => `  ${item.usage.padEnd(usageWidth)}  ${item.description}`
        ),
    ],
  })
  return CONTINUE
}

async function providersHandler(
  _invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const providers = await getService(context, commandProviderService)
  output.write({
    level: 'info',
    title: '/providers',
    body: ['Providers:', ...providers.list().map((item) => `  ${item}`)],
  })
  return CONTINUE
}

async function exitHandler(): Promise<CommandResult> {
  return REQUEST_STOP
}

async function threadHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const threads = await getService(context, commandThreadService)
  const providers = await getService(context, commandProviderService)
  const args = invocation.arguments.positionals
  switch (invocation.routeId) {
    case 'root':
      return writeHelp(output, '/thread', THREAD_HELP)
    case 'agent':
    case 'chat': {
      const provider = providers.resolve(scalar(args.provider) ?? '')
      if (provider === null)
        return writeWarning(
          output,
          invocation.routeId,
          `Unknown provider: ${scalar(args.provider) ?? ''}`
        )
      const result = await threads.create({
        provider,
        modelKey: scalar(args['model-key']),
        optionKey: scalar(args['option-key']),
        mode: invocation.routeId,
        signal: context.signal,
      })
      if (!result.ok)
        return writeWarning(
          output,
          `/thread ${invocation.routeId}`,
          result.message
        )
      return CONTINUE
    }
    case 'list': {
      const rows = threads.list()
      if (rows.length === 0)
        return writeWarning(output, '/thread list', 'No local threads.')
      return writeInfo(output, '/thread list', formatThreads(rows))
    }
    case 'history': {
      const result = await threads.history(scalar(args.limit), context.signal)
      if (!result.ok)
        return writeWarning(output, '/thread history', result.message)
      if (result.entries.length === 0)
        return writeWarning(output, '/thread history', 'No thread history.')
      return writeInfo(output, '/thread history', formatHistory(result.entries))
    }
    case 'resume': {
      const result = await threads.resume(
        scalar(args.target) ?? '',
        context.signal
      )
      return result.ok
        ? CONTINUE
        : writeWarning(output, '/thread resume', result.message)
    }
    case 'reload': {
      const result = await threads.reloadActive(context.signal)
      if (result.ok)
        return writeSuccess(output, '/thread reload', 'Provider page reloaded.')
      return writeWarning(
        output,
        '/thread reload',
        result.message,
        'plain',
        result.threadId
      )
    }
    case 'switch': {
      const threadId = scalar(args['thread-id']) ?? ''
      if (!threads.switchTo(threadId))
        return writeWarning(
          output,
          '/thread switch',
          `Unknown thread: ${threadId}`
        )
      output.navigate({ kind: 'show-thread', threadId })
      return CONTINUE
    }
    case 'status': {
      const status = threads.status()
      if (status === null)
        return writeWarning(output, '/thread status', 'No active thread.')
      return writeInfo(output, '/thread status', formatStatus(status))
    }
    case 'close': {
      const result = await threads.close(
        scalar(args['thread-id']),
        context.signal
      )
      if (!result.ok) {
        if (result.removedThreadId !== undefined) {
          output.navigate({
            kind: 'remove-thread',
            threadId: result.removedThreadId,
          })
        }
        return writeWarning(output, '/thread close', result.message)
      }
      output.navigate({ kind: 'remove-thread', threadId: result.threadId })
      if (!result.wasActive)
        writeSuccess(output, '/thread close', `Closed ${result.threadId}.`)
      return CONTINUE
    }
    case 'detach': {
      const threadId = threads.detach()
      if (threadId === null)
        return writeWarning(output, '/thread detach', 'No active thread.')
      output.navigate({ kind: 'show-home' })
      return CONTINUE
    }
    case 'capability': {
      const name = scalar(args.name)
      if (name === null) {
        const result = await threads.listCapabilities(context.signal)
        if (!result.ok)
          return writeWarning(output, '/thread capability', result.message)
        if (result.capabilities.length === 0)
          return writeWarning(
            output,
            '/thread capability',
            `No capabilities available for ${result.provider}.`
          )
        return writeInfo(
          output,
          '/thread capability',
          formatCapabilities(result.provider, result.capabilities, result.usage)
        )
      }
      const result = await threads.executeCapability(
        name,
        scalar(args.action) === null ? [] : [scalar(args.action)!],
        context.signal
      )
      if (result.status === 'ok')
        writeSuccess(output, result.title, result.body, result.format)
      else writeWarning(output, result.title, result.body, result.format)
      return CONTINUE
    }
    default:
      return writeWarning(output, '/thread', 'Unknown thread command route.')
  }
}

async function skillHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const skills = await getService(context, commandSkillService)
  const args = invocation.arguments.positionals
  switch (invocation.routeId) {
    case 'root':
      return writeHelp(output, '/skill', SKILL_HELP, [
        'Manual trigger:',
        '  $<name> [task]  Use an enabled skill for the current turn.',
      ])
    case 'add': {
      const sourceValue = args.source
      const source = Array.isArray(sourceValue) ? sourceValue.join(' ') : ''
      const registryUrl = invocation.arguments.options['--registry'] ?? null
      writeInfo(output, '/skill add', describeSkillInstall(source, registryUrl))
      try {
        const result = await skills.add(source, {
          signal: context.signal,
          ...(registryUrl === null ? {} : { registryUrl }),
        })
        writeSuccess(output, '/skill add', describeAddedSkills(result.skills))
        if (result.warnings.length > 0)
          writeWarning(output, '/skill add', result.warnings)
      } catch (error) {
        rethrowIfAborted(context.signal)
        writeError(output, '/skill add', getErrorMessage(error))
      }
      return CONTINUE
    }
    case 'list': {
      const result = await skills.list(context.signal)
      if (result.skills.length === 0 && result.issues.length === 0)
        return writeWarning(output, '/skill list', 'No skills registered.')
      if (result.skills.length > 0)
        writeInfo(output, '/skill list', [
          'Skills:',
          ...result.skills.map(
            (skill) => `${skill.enabled ? '*' : ' '} ${skill.name}`
          ),
        ])
      if (result.issues.length > 0)
        writeWarning(output, '/skill list', [
          'Invalid skills:',
          ...result.issues.flatMap((issue) => [
            `  ${issue.directory}`,
            `    ${issue.message}`,
          ]),
        ])
      return CONTINUE
    }
    case 'enable':
    case 'disable': {
      const name = scalar(args.name) ?? ''
      try {
        const enabled =
          invocation.routeId === 'enable'
            ? await skills.enable(name, context.signal)
            : await skills.disable(name, context.signal)
        if (!enabled)
          return writeWarning(
            output,
            `/skill ${invocation.routeId}`,
            `Unknown skill: ${name}`
          )
        return writeSuccess(
          output,
          `/skill ${invocation.routeId}`,
          `${invocation.routeId === 'enable' ? 'Enabled' : 'Disabled'} ${name} for new threads.`
        )
      } catch (error) {
        rethrowIfAborted(context.signal)
        return writeError(
          output,
          `/skill ${invocation.routeId}`,
          getErrorMessage(error)
        )
      }
    }
    case 'remove': {
      const name = scalar(args.name) ?? ''
      try {
        const result = await skills.remove(name, context.signal)
        if (!result.removed)
          return writeWarning(output, '/skill remove', `Unknown skill: ${name}`)
        writeSuccess(output, '/skill remove', `Removed ${name}.`)
        if (result.warnings.length > 0)
          writeWarning(output, '/skill remove', result.warnings)
        return CONTINUE
      } catch (error) {
        rethrowIfAborted(context.signal)
        return writeError(output, '/skill remove', getErrorMessage(error))
      }
    }
    default:
      return writeWarning(output, '/skill', 'Unknown skill command route.')
  }
}

async function mcpHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const mcp = await getService(context, commandMcpService)
  const action = invocation.routeId
  try {
    if (action === 'start') {
      await mcp.start(context.signal)
      return writeSuccess(output, '/mcp start', 'MCP Server started.')
    }
    if (action === 'stop') {
      await mcp.stop(context.signal)
      return writeSuccess(output, '/mcp stop', 'MCP Server stopped.')
    }
  } catch (error) {
    rethrowIfAborted(context.signal)
    return writeError(output, `/mcp ${action}`, getErrorMessage(error))
  }
  if (action === 'status' || action === 'token') {
    const status = mcp.status()
    if (action === 'token')
      return writeInfo(
        output,
        '/mcp token',
        status.auth ? 'Authentication configured.' : 'Authentication disabled.'
      )
    const authentication = status.auth
      ? status.running
        ? 'enabled'
        : 'configured'
      : 'disabled'
    return writeInfo(output, '/mcp status', [
      `Running: ${status.running ? 'yes' : 'no'}`,
      `Address: ${status.address ?? '-'}`,
      `Authentication: ${authentication}`,
    ])
  }
  return writeHelp(output, '/mcp', MCP_HELP)
}

async function keybindingHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await getService(context, commandOutputService)
  const keybindings = await getService(context, commandKeybindingService)
  if (invocation.routeId === 'root')
    return writeHelp(output, '/keybinding', [
      help('reset', 'Restore platform-default keybindings.'),
    ])
  try {
    await keybindings.reset(context.signal)
    return writeSuccess(
      output,
      '/keybinding reset',
      'Restored platform-default keybindings.'
    )
  } catch (error) {
    rethrowIfAborted(context.signal)
    return writeError(output, '/keybinding reset', getErrorMessage(error))
  }
}

function definition(
  contribution: CommandContribution,
  handler: CommandHandler,
  requiredServices: BuiltinCommandDefinition['requiredServices'],
  requiredCapabilities: readonly string[]
): BuiltinCommandDefinition {
  return Object.freeze({
    contribution,
    handler,
    requiredServices,
    requiredCapabilities,
  })
}

function command(
  id: string,
  primaryName: string,
  description: string,
  usage: string,
  routes: readonly CommandRouteSpec[]
): CommandContribution {
  return Object.freeze({
    id,
    primaryName,
    aliases: Object.freeze([]),
    usage,
    description,
    routes,
  })
}

function route(
  id: string,
  path: readonly string[],
  availability: 'always' | 'thread-idle',
  positionals: readonly {
    name: string
    cardinality: 'required' | 'optional' | 'one-or-more' | 'zero-or-more'
  }[],
  options: readonly { name: string; valueName: string }[],
  helpRows: readonly CommandHelpRow[],
  constraints: readonly {
    kind:
      'option-requires-single-positional' | 'option-forbids-http-url-positional'
    option: string
    positional: string
  }[] = []
): CommandRouteSpec {
  return {
    id,
    path,
    availability,
    positionals,
    options,
    constraints,
    help: helpRows,
  }
}

function required(name: string) {
  return { name, cardinality: 'required' as const }
}
function optional(name: string) {
  return { name, cardinality: 'optional' as const }
}
function oneOrMore(name: string) {
  return { name, cardinality: 'one-or-more' as const }
}
function option(name: string, valueName: string) {
  return { name, valueName }
}
function constraint(
  kind:
    'option-requires-single-positional' | 'option-forbids-http-url-positional',
  optionName: string,
  positional: string
) {
  return { kind, option: optionName, positional }
}
function help(usage: string, description: string): CommandHelpRow {
  return { usage, description }
}

function threadCreationPositionals(): CommandRouteSpec['positionals'] {
  return [
    {
      ...required('provider'),
      completion: {
        sourceId: 'portal.command.providers',
        dependsOn: [],
      },
    },
    {
      ...optional('model-key'),
      completion: {
        sourceId: 'portal.command.models',
        dependsOn: ['provider'],
      },
    },
    {
      ...optional('option-key'),
      completion: {
        sourceId: 'portal.command.model-options',
        dependsOn: ['provider', 'model-key'],
      },
    },
  ]
}

async function getService<Service>(
  context: CommandExecutionContext,
  ref: ServiceRef<Service>
): Promise<Service> {
  return await context.services.get(ref)
}

function scalar(
  value: string | readonly string[] | null | undefined
): string | null {
  return typeof value === 'string' ? value : null
}

function writeHelp(
  output: CommandOutputService,
  title: string,
  rows: readonly CommandHelpRow[],
  extra: readonly string[] = []
): CommandResult {
  const width = Math.max(0, ...rows.map((row) => row.usage.length))
  output.write({
    level: 'info',
    title,
    body: [
      'Subcommands:',
      ...rows.map((row) => `  ${row.usage.padEnd(width)}  ${row.description}`),
      ...extra,
    ],
  })
  return CONTINUE
}

function writeInfo(
  output: CommandOutputService,
  title: string,
  body: string | readonly string[],
  format: 'plain' | 'markdown' = 'plain'
): CommandResult {
  output.write({ level: 'info', title, body, format })
  return CONTINUE
}
function writeSuccess(
  output: CommandOutputService,
  title: string,
  body: string | readonly string[],
  format: 'plain' | 'markdown' = 'plain'
): CommandResult {
  output.write({ level: 'success', title, body, format })
  return CONTINUE
}
function writeWarning(
  output: CommandOutputService,
  title: string,
  body: string | readonly string[],
  format: 'plain' | 'markdown' = 'plain',
  threadId?: string
): CommandResult {
  const message: CommandOutputMessage = {
    level: 'warning',
    title,
    body,
    format,
    ...(threadId === undefined ? {} : { threadId }),
  }
  output.write(message)
  return CONTINUE
}
function writeError(
  output: CommandOutputService,
  title: string,
  body: string | readonly string[],
  format: 'plain' | 'markdown' = 'plain',
  threadId?: string
): CommandResult {
  const message: CommandOutputMessage = {
    level: 'error',
    title,
    body,
    format,
    ...(threadId === undefined ? {} : { threadId }),
  }
  output.write(message)
  return CONTINUE
}
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rethrowIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const reason: unknown = signal.reason
  throw reason instanceof Error
    ? reason
    : new DOMException('Operation aborted', 'AbortError')
}

function formatThreads(
  threads: readonly {
    id: string
    provider: string
    title: string | null
    turnCount: number
    conversationUrl: string
    active: boolean
  }[]
): string[] {
  return [
    'Threads:',
    ...threads.flatMap((thread, index) => {
      const rows = [
        `${thread.active ? '*' : ' '} ${thread.id}  ${thread.provider}  ${thread.turnCount} ${thread.turnCount === 1 ? 'turn' : 'turns'}`,
        `  title: ${thread.title ?? '(untitled)'}`,
        `  url: ${thread.conversationUrl}`,
      ]
      return index === threads.length - 1 ? rows : [...rows, '']
    }),
  ]
}

function formatHistory(
  entries: readonly {
    id: number
    provider: string
    title: string | null
    createdAt: string
    lastUsedAt: string
    conversationUrl: string
  }[]
): string[] {
  return [
    'History:',
    ...entries.flatMap((entry, index) => {
      const rows = [
        `#${entry.id} ${entry.title ?? '(untitled)'}`,
        `   Provider: ${entry.provider}`,
        `   Created: ${entry.createdAt}`,
        `   Last used: ${entry.lastUsedAt}`,
        `   URL: ${entry.conversationUrl}`,
      ]
      return index === entries.length - 1 ? rows : [...rows, '']
    }),
  ]
}

function formatStatus(thread: {
  id: string
  provider: string
  title: string | null
  turnCount: number
  conversationUrl: string
  active: boolean
}): string[] {
  return [
    'Thread:',
    `  id: ${thread.id}`,
    `  provider: ${thread.provider}`,
    `  title: ${thread.title ?? '(untitled)'}`,
    `  turns: ${thread.turnCount}`,
    `  url: ${thread.conversationUrl}`,
  ]
}

function formatCapabilities(
  provider: string,
  capabilities: readonly { name: string; state: string }[],
  usage: string
): string[] {
  const width = Math.max(...capabilities.map((item) => item.name.length))
  return [
    `Provider: ${provider}`,
    '',
    'Capabilities:',
    ...capabilities.map(
      (item) => `  ${item.name.padEnd(width)}  ${item.state}`
    ),
    '',
    'Usage:',
    `  ${usage}`,
  ]
}

function describeAddedSkills(
  skills: readonly { name: string; directory: string }[]
): string[] {
  return skills.length === 1
    ? [`Added and enabled ${skills[0]!.name}.`, `Path: ${skills[0]!.directory}`]
    : [
        `Added and enabled ${skills.length} skills.`,
        ...skills.map((skill) => `- ${skill.name}: ${skill.directory}`),
      ]
}

function describeSkillInstall(
  source: string,
  registryUrl: string | null
): string[] {
  if (registryUrl !== null)
    return [
      'Installing skill from Hub registry...',
      `Skill: ${source}`,
      `Registry: ${formatRemoteSource(registryUrl)}`,
      'Downloading, extracting, and validating may take time.',
      'Press Ctrl+C to cancel.',
    ]
  if (!/^https?:\/\//i.test(source))
    return [
      'Adding skill from local directory...',
      `Source: ${source}`,
      'Validating and registering may take time.',
      'Press Ctrl+C to cancel.',
    ]
  return [
    'Installing skill from remote source...',
    `Source: ${formatRemoteSource(source)}`,
    'Downloading, extracting, and validating may take time.',
    'Press Ctrl+C to cancel.',
  ]
}

function formatRemoteSource(source: string): string {
  let display = source.replace(/[?#][\s\S]*$/, '')
  try {
    const url = new URL(source)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    display = url.href
  } catch {
    /* non-URL source keeps the sanitized fallback */
  }
  return display.length <= 160 ? display : `${display.slice(0, 157)}...`
}
