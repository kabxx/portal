import type { McpHttpServerConfig } from '../../mcp/mcp-config.ts'
import type { ThreadMcpSession } from '../../mcp/thread-mcp-session.ts'
import { isAbortError } from '../../runtime/runtime-cancellation.ts'
import type {
  CliCommand,
  CliCommandContext,
  CommandResult,
} from '../core/command-types.ts'
import {
  commandGuideSubcommands,
  getActiveThread,
} from '../core/command-types.ts'

const MCP_SUBCOMMANDS = [
  {
    path: ['add'],
    usage: 'add <name> <url> [--header "Name: value"]...',
    description: 'Add and enable an HTTP MCP server.',
  },
  {
    path: ['add'],
    usage: 'add <name> -- <command> [args...]',
    description: 'Add and enable a stdio MCP server.',
  },
  {
    path: ['list'],
    usage: 'list',
    description: 'List configured servers.',
  },
  {
    path: ['enable'],
    usage: 'enable <name>',
    description: 'Enable a server for new threads.',
  },
  {
    path: ['disable'],
    usage: 'disable <name>',
    description: 'Disable a server for new threads.',
  },
  {
    path: ['remove'],
    usage: 'remove <name>',
    description: 'Remove a configured server.',
  },
  {
    path: ['resource', 'list'],
    usage: 'resource list [server]',
    description: 'List resources in the active thread.',
  },
  {
    path: ['resource', 'attach'],
    usage: 'resource attach <server> <uri>',
    description: 'Attach a resource as its own user turn.',
  },
  {
    path: ['prompt', 'list'],
    usage: 'prompt list [server]',
    description: 'List prompts in the active thread.',
  },
  {
    path: ['prompt', 'attach'],
    usage: 'prompt attach <server> <prompt> [json-arguments]',
    description: 'Attach a prompt as its own user turn.',
  },
] as const

export const McpCommand: CliCommand = {
  name: '/mcp',
  usage: '/mcp <subcommand>',
  description: 'Manage MCP servers, resources, and prompts.',
  subcommands: commandGuideSubcommands(MCP_SUBCOMMANDS),
  guides: MCP_SUBCOMMANDS,
  async execute(context, args) {
    const [subcommand, ...subcommandArgs] = args
    if (subcommand === undefined) {
      renderMcpHelp(context)
      return { continue: true }
    }

    switch (subcommand) {
      case 'add':
        return await addMcpServer(context, subcommandArgs)
      case 'list':
        return await listMcpServers(context)
      case 'enable':
        return await setMcpServerEnabled(context, subcommandArgs, true)
      case 'disable':
        return await setMcpServerEnabled(context, subcommandArgs, false)
      case 'remove':
        return await removeMcpServer(context, subcommandArgs)
      case 'resource':
        return await handleMcpResource(context, subcommandArgs)
      case 'prompt':
        return await handleMcpPrompt(context, subcommandArgs)
      default:
        context.ui.renderWarning('/mcp', [
          `Unknown MCP subcommand: ${subcommand}`,
          'Run /mcp to see available subcommands.',
        ])
        return { continue: true }
    }
  },
}

function renderMcpHelp(context: CliCommandContext): void {
  const usageWidth = Math.max(
    ...MCP_SUBCOMMANDS.map(({ usage }) => usage.length)
  )
  context.ui.renderInfo(
    '/mcp',
    [
      'Subcommands:',
      ...MCP_SUBCOMMANDS.map(
        ({ usage, description }) =>
          `  ${usage.padEnd(usageWidth)}  ${description}`
      ),
    ].join('\n')
  )
}

async function addMcpServer(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const name = args[0] ?? ''
  if (name === '') {
    context.ui.renderWarning(
      '/mcp add',
      'Usage: /mcp add <name> <url> [--header "Name: value"]... or /mcp add <name> -- <command> [args...]'
    )
    return { continue: true }
  }

  try {
    if (args[1] === '--') {
      const command = args[2] ?? ''
      if (command === '') {
        throw new Error('Missing stdio command after --')
      }
      await context.mcpLibrary.add(name, {
        transport: 'stdio',
        command,
        ...(args.length > 3 ? { args: [...args.slice(3)] } : {}),
      })
    } else {
      const url = args[1] ?? ''
      if (url === '') {
        throw new Error('Missing HTTP MCP URL')
      }
      const headers = parseHeaders(args.slice(2))
      const config: McpHttpServerConfig = {
        transport: 'streamable-http',
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }
      await context.mcpLibrary.add(name, config)
    }
    context.ui.renderSuccess('/mcp add', [
      `Added and enabled ${name}.`,
      'This change applies to new threads.',
    ])
  } catch (error) {
    context.ui.renderError('/mcp add', getErrorMessage(error))
  }
  return { continue: true }
}

function parseHeaders(args: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--header') {
      throw new Error(`Unknown HTTP MCP option: ${args[index]}`)
    }
    const header = args[index + 1]
    if (header === undefined) {
      throw new Error('--header requires "Name: value"')
    }
    const separator = header.indexOf(':')
    const name = separator < 0 ? '' : header.slice(0, separator).trim()
    const value = separator < 0 ? '' : header.slice(separator + 1).trim()
    if (name === '' || value === '') {
      throw new Error('--header requires "Name: value"')
    }
    const duplicate = Object.keys(headers).find(
      (existing) => existing.toLowerCase() === name.toLowerCase()
    )
    if (duplicate !== undefined) {
      throw new Error(`Duplicate HTTP header: ${name}`)
    }
    headers[name] = value
    index += 1
  }
  return headers
}

async function listMcpServers(
  context: CliCommandContext
): Promise<CommandResult> {
  const result = await context.mcpLibrary.list()
  if (result.servers.length === 0 && result.issues.length === 0) {
    context.ui.renderWarning('/mcp list', 'No MCP servers configured.')
    return { continue: true }
  }
  if (result.servers.length > 0) {
    context.ui.renderInfo('/mcp list', [
      'MCP servers:',
      ...result.servers.map(
        ({ name, enabled, config }) =>
          `${enabled ? '*' : ' '} ${name}  ${config.transport}`
      ),
    ])
  }
  if (result.issues.length > 0) {
    context.ui.renderWarning('/mcp list', [
      'Invalid MCP configuration:',
      ...result.issues.map(
        ({ server, message }) => `- ${server ?? 'config'}: ${message}`
      ),
    ])
  }
  return { continue: true }
}

async function setMcpServerEnabled(
  context: CliCommandContext,
  args: readonly string[],
  enabled: boolean
): Promise<CommandResult> {
  const name = args[0] ?? ''
  const title = enabled ? '/mcp enable' : '/mcp disable'
  if (name === '') {
    context.ui.renderWarning(title, `Usage: ${title} <name>`)
    return { continue: true }
  }
  try {
    const changed = enabled
      ? await context.mcpLibrary.enable(name)
      : await context.mcpLibrary.disable(name)
    if (!changed) {
      context.ui.renderWarning(title, `Unknown MCP server: ${name}`)
      return { continue: true }
    }
    context.ui.renderSuccess(title, [
      `${enabled ? 'Enabled' : 'Disabled'} ${name} for new threads.`,
      'Existing threads keep their current MCP sessions.',
    ])
  } catch (error) {
    context.ui.renderError(title, getErrorMessage(error))
  }
  return { continue: true }
}

async function removeMcpServer(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const name = args[0] ?? ''
  if (name === '') {
    context.ui.renderWarning('/mcp remove', 'Usage: /mcp remove <name>')
    return { continue: true }
  }
  try {
    if (!(await context.mcpLibrary.remove(name))) {
      context.ui.renderWarning('/mcp remove', `Unknown MCP server: ${name}`)
      return { continue: true }
    }
    context.ui.renderSuccess('/mcp remove', [
      `Removed ${name}.`,
      'Existing threads keep their current MCP sessions.',
    ])
  } catch (error) {
    context.ui.renderError('/mcp remove', getErrorMessage(error))
  }
  return { continue: true }
}

async function handleMcpResource(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const [action, ...actionArgs] = args
  const session = getActiveMcpSession(context, '/mcp resource')
  if (session === null) {
    return { continue: true }
  }
  if (action === 'list') {
    return await listMcpResources(context, session, actionArgs)
  }
  if (action === 'attach') {
    return await attachMcpResource(context, session, actionArgs)
  }
  context.ui.renderWarning(
    '/mcp resource',
    'Usage: /mcp resource list [server] or /mcp resource attach <server> <uri>'
  )
  return { continue: true }
}

async function listMcpResources(
  context: CliCommandContext,
  session: ThreadMcpSession,
  args: readonly string[]
): Promise<CommandResult> {
  try {
    const result = await session.listResources(args[0])
    if (result.items.length === 0) {
      context.ui.renderWarning('/mcp resource list', 'No MCP resources found.')
    } else {
      context.ui.renderInfo('/mcp resource list', [
        'MCP resources:',
        ...result.items.map(
          ({ server, uri, name }) => `- ${server}  ${name}  ${uri}`
        ),
      ])
    }
    renderSessionWarnings(context, result.issues)
  } catch (error) {
    context.ui.renderError(
      '/mcp resource list',
      getErrorMessage(error),
      'markdown'
    )
  }
  return { continue: true }
}

async function attachMcpResource(
  context: CliCommandContext,
  session: ThreadMcpSession,
  args: readonly string[]
): Promise<CommandResult> {
  const server = args[0] ?? ''
  const uri = args[1] ?? ''
  if (server === '' || uri === '') {
    context.ui.renderWarning(
      '/mcp resource attach',
      'Usage: /mcp resource attach <server> <uri>'
    )
    return { continue: true }
  }
  context.ui.setBusy(true)
  try {
    const attachment = await session.createResourceAttachment(server, uri)
    await context.submitThreadInput(
      attachment,
      `/mcp resource attach ${server} ${uri}`
    )
  } catch (error) {
    renderMcpOperationError(context, '/mcp resource attach', error)
  } finally {
    context.ui.setBusy(false)
  }
  return { continue: true }
}

async function handleMcpPrompt(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const [action, ...actionArgs] = args
  const session = getActiveMcpSession(context, '/mcp prompt')
  if (session === null) {
    return { continue: true }
  }
  if (action === 'list') {
    return await listMcpPrompts(context, session, actionArgs)
  }
  if (action === 'attach') {
    return await attachMcpPrompt(context, session, actionArgs)
  }
  context.ui.renderWarning(
    '/mcp prompt',
    'Usage: /mcp prompt list [server] or /mcp prompt attach <server> <prompt> [json-arguments]'
  )
  return { continue: true }
}

async function listMcpPrompts(
  context: CliCommandContext,
  session: ThreadMcpSession,
  args: readonly string[]
): Promise<CommandResult> {
  try {
    const result = await session.listPrompts(args[0])
    if (result.items.length === 0) {
      context.ui.renderWarning('/mcp prompt list', 'No MCP prompts found.')
    } else {
      context.ui.renderInfo('/mcp prompt list', [
        'MCP prompts:',
        ...result.items.map(({ server, name, arguments: promptArguments }) => {
          const argumentNames = (promptArguments ?? []).map((argument) =>
            argument.required === true ? `${argument.name}*` : argument.name
          )
          return `- ${server}  ${name}${argumentNames.length > 0 ? `  (${argumentNames.join(', ')})` : ''}`
        }),
      ])
    }
    renderSessionWarnings(context, result.issues)
  } catch (error) {
    context.ui.renderError(
      '/mcp prompt list',
      getErrorMessage(error),
      'markdown'
    )
  }
  return { continue: true }
}

async function attachMcpPrompt(
  context: CliCommandContext,
  session: ThreadMcpSession,
  args: readonly string[]
): Promise<CommandResult> {
  const server = args[0] ?? ''
  const prompt = args[1] ?? ''
  if (server === '' || prompt === '') {
    context.ui.renderWarning(
      '/mcp prompt attach',
      'Usage: /mcp prompt attach <server> <prompt> [json-arguments]'
    )
    return { continue: true }
  }

  let promptArguments: Record<string, string>
  try {
    promptArguments = parsePromptArguments(args.slice(2).join(' '))
  } catch (error) {
    context.ui.renderError('/mcp prompt attach', getErrorMessage(error))
    return { continue: true }
  }

  context.ui.setBusy(true)
  try {
    const attachment = await session.createPromptAttachment(
      server,
      prompt,
      promptArguments
    )
    await context.submitThreadInput(
      attachment,
      `/mcp prompt attach ${server} ${prompt}`
    )
  } catch (error) {
    renderMcpOperationError(context, '/mcp prompt attach', error)
  } finally {
    context.ui.setBusy(false)
  }
  return { continue: true }
}

function parsePromptArguments(value: string): Record<string, string> {
  if (value.trim() === '') {
    return {}
  }
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) {
    throw new Error('Prompt arguments must be a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [name, argument] of Object.entries(parsed)) {
    if (typeof argument !== 'string') {
      throw new Error(`Prompt argument ${name} must be a string`)
    }
    result[name] = argument
  }
  return result
}

function getActiveMcpSession(
  context: CliCommandContext,
  title: string
): ThreadMcpSession | null {
  const thread = getActiveThread(context)
  if (thread === null) {
    context.ui.renderWarning(title, 'No active thread.')
    return null
  }
  const session = thread.runtime.getMcpSession()
  if (session === null) {
    context.ui.renderWarning(title, 'MCP is not configured in this runtime.')
    return null
  }
  return session
}

function renderSessionWarnings(
  context: CliCommandContext,
  warnings: readonly { markdown: string }[]
): void {
  for (const warning of warnings) {
    context.ui.renderWarning('MCP', warning.markdown, 'markdown')
  }
}

function renderMcpOperationError(
  context: CliCommandContext,
  title: string,
  error: unknown
): void {
  if (isAbortError(error)) {
    context.ui.renderWarning(title, 'MCP operation cancelled.')
    return
  }
  context.ui.renderError(title, getErrorMessage(error), 'markdown')
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
