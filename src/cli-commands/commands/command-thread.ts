import { resolveConversationUrl } from '../../providers/provider-conversation-url.ts'
import {
  ProviderModelSelectionError,
  resolveProviderModel,
} from '../../providers/provider-model-catalog.ts'
import {
  parseThreadHistoryId,
  parseThreadHistoryLimit,
} from '../../threads/thread-store.ts'
import { executeThreadCapability } from './command-thread-capability.ts'
import type {
  CliCommand,
  CliCommandContext,
  CommandResult,
} from '../core/command-types.ts'
import {
  commandGuideSubcommands,
  getActiveThread,
} from '../core/command-types.ts'
import type { ThreadCreationMode } from '../../threads/thread-creation-mode.ts'

const THREAD_GUIDES = [
  {
    path: ['agent'],
    usage: 'agent <provider> [model-key] [option-key]',
    description: 'Create an agent thread.',
  },
  {
    path: ['chat'],
    usage: 'chat <provider> [model-key] [option-key]',
    description: 'Create a chat thread with only the setup handshake.',
  },
  { path: ['list'], usage: 'list', description: 'List local threads.' },
  {
    path: ['history'],
    usage: 'history [limit]',
    description: 'Show thread history.',
  },
  {
    path: ['resume'],
    usage: 'resume <conversation-url|#history-id>',
    description: 'Resume a conversation URL or history entry.',
  },
  {
    path: ['reload'],
    usage: 'reload',
    description: 'Reload the active provider page.',
  },
  {
    path: ['switch'],
    usage: 'switch <thread-id>',
    description: 'Switch to another thread.',
  },
  {
    path: ['status'],
    usage: 'status',
    description: 'Show active thread status.',
  },
  {
    path: ['close'],
    usage: 'close [thread-id]',
    description: 'Close a thread.',
  },
  {
    path: ['detach'],
    usage: 'detach',
    description: 'Detach from the active thread.',
  },
  {
    path: ['capability'],
    usage: 'capability [name] [action]',
    description: 'Show or change active thread capabilities.',
  },
] as const

export const ThreadCommand: CliCommand = {
  name: '/thread',
  usage: '/thread <subcommand>',
  description: 'Manage threads.',
  subcommands: commandGuideSubcommands(THREAD_GUIDES),
  guides: THREAD_GUIDES,
  async execute(context, args) {
    const [subcommand, ...subcommandArgs] = args
    if (subcommand === undefined) {
      renderThreadHelp(context)
      return { continue: true }
    }

    switch (subcommand) {
      case 'agent':
        return await createThread(context, subcommandArgs, 'agent')
      case 'chat':
        return await createThread(context, subcommandArgs, 'chat')
      case 'list':
        return await listThreads(context)
      case 'history':
        return await showThreadHistory(context, subcommandArgs)
      case 'resume':
        return await resumeThread(context, subcommandArgs)
      case 'reload':
        return await reloadThread(context)
      case 'switch':
        return await switchThread(context, subcommandArgs)
      case 'status':
        return await showThreadStatus(context)
      case 'close':
        return await closeThread(context, subcommandArgs)
      case 'detach':
        return await detachThread(context)
      case 'capability':
        return await executeThreadCapability(context, subcommandArgs)
      default:
        context.ui.renderWarning('/thread', [
          `Unknown thread subcommand: ${subcommand}`,
          'Run /thread to see available subcommands.',
        ])
        return { continue: true }
    }
  },
}

function renderThreadHelp(context: CliCommandContext): void {
  const usageWidth = Math.max(...THREAD_GUIDES.map(({ usage }) => usage.length))
  context.ui.renderInfo(
    '/thread',
    [
      'Subcommands:',
      ...THREAD_GUIDES.map(
        ({ usage, description }) =>
          `  ${usage.padEnd(usageWidth)}  ${description}`
      ),
    ].join('\n')
  )
}

async function createThread(
  context: CliCommandContext,
  args: readonly string[],
  mode: ThreadCreationMode
): Promise<CommandResult> {
  const label = mode === 'chat' ? '/thread chat' : '/thread agent'
  const usage = `${label} <provider> [model-key] [option-key]`
  const rawProvider = args[0] ?? ''
  if (!rawProvider) {
    context.ui.renderWarning(label, `Missing provider. Usage: ${usage}`)
    return { continue: true }
  }

  const provider = context.resolveProvider(rawProvider)
  if (provider === null) {
    context.ui.renderWarning(label, `Unknown provider: ${rawProvider}`)
    return { continue: true }
  }

  if (args.length > 3) {
    context.ui.renderWarning(label, `Too many arguments. Usage: ${usage}`)
    return { continue: true }
  }

  let model: ReturnType<typeof resolveProviderModel>
  try {
    model = resolveProviderModel(provider, args[1] ?? null, args[2] ?? null)
  } catch (error) {
    if (!(error instanceof ProviderModelSelectionError)) throw error
    context.ui.renderWarning(label, error.message)
    return { continue: true }
  }

  await context.createThread(provider, model, mode)
  return { continue: true }
}

async function listThreads(context: CliCommandContext): Promise<CommandResult> {
  context.ui.renderThreadList(context.threadManager.listThreads())
  return { continue: true }
}

async function showThreadHistory(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const { limit, error } = parseThreadHistoryLimit(args[0])
  if (error !== null || limit === null) {
    context.ui.renderWarning(
      '/thread history',
      error ?? 'Invalid history limit.'
    )
    return { continue: true }
  }

  const entries = await context.threadStore.list(limit)
  context.ui.renderThreadHistory(entries)
  return { continue: true }
}

async function resumeThread(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const rawTarget = args[0] ?? ''
  if (!rawTarget) {
    context.ui.renderWarning(
      '/thread resume',
      'Missing conversation URL or history id. Usage: /thread resume <conversation-url|#history-id>'
    )
    return { continue: true }
  }

  const historyId = parseThreadHistoryId(rawTarget)
  if (rawTarget.startsWith('#') && historyId === null) {
    context.ui.renderWarning(
      '/thread resume',
      `Invalid history id: ${rawTarget}. Expected #<positive-integer>.`
    )
    return { continue: true }
  }

  const historyEntry =
    historyId === null ? null : await context.threadStore.getById(historyId)
  if (historyId !== null && historyEntry === null) {
    context.ui.renderWarning(
      '/thread resume',
      `History entry not found: #${historyId}`
    )
    return { continue: true }
  }

  const conversationUrl = historyEntry?.conversationUrl ?? rawTarget
  const resolved = resolveConversationUrl(conversationUrl)
  if (resolved === null) {
    context.ui.renderWarning(
      '/thread resume',
      `Unsupported conversation URL: ${conversationUrl}`
    )
    return { continue: true }
  }

  const existingThread = context.threadManager
    .listThreads()
    .find(
      (thread) => thread.runtime.conversationUrl === resolved.conversationUrl
    )
  if (existingThread !== undefined) {
    context.ui.renderWarning(
      '/thread resume',
      `Conversation already exists as thread ${existingThread.id}. Use /thread switch ${existingThread.id} to select it.`
    )
    return { continue: true }
  }

  await context.resumeThread(resolved.conversationUrl)
  return { continue: true }
}

async function switchThread(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const threadId = args[0] ?? ''
  if (!threadId) {
    context.ui.renderWarning(
      '/thread switch',
      'Usage: /thread switch <thread-id>'
    )
    return { continue: true }
  }

  const thread = context.threadManager.switchThread(threadId)
  if (thread === null) {
    context.ui.renderWarning('/thread switch', `Unknown thread: ${threadId}`)
    return { continue: true }
  }

  context.ui.showThreadTimeline(thread.id)
  return { continue: true }
}

async function reloadThread(
  context: CliCommandContext
): Promise<CommandResult> {
  const activeThread = getActiveThread(context)
  if (activeThread === null) {
    context.ui.renderWarning('/thread reload', 'No active thread.')
    return { continue: true }
  }
  if (context.reloadThread === undefined) {
    context.ui.renderWarning(
      '/thread reload',
      'Thread reload is not available in this runtime.'
    )
    return { continue: true }
  }

  try {
    await context.reloadThread(activeThread.id)
  } catch (error) {
    context.ui.renderThreadWarning(
      activeThread,
      '/thread reload',
      error instanceof Error ? error.message : String(error)
    )
  }
  return { continue: true }
}

async function showThreadStatus(
  context: CliCommandContext
): Promise<CommandResult> {
  const activeThread = getActiveThread(context)
  if (activeThread === null) {
    context.ui.renderWarning('/thread status', 'No active thread.')
    return { continue: true }
  }

  context.ui.renderThreadStatus(activeThread)
  return { continue: true }
}

async function closeThread(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const requestedId = args[0]
  const targetId =
    requestedId === undefined ? getActiveThread(context)?.id : requestedId
  if (targetId === undefined) {
    context.ui.renderWarning('/thread close', 'No active thread.')
    return { continue: true }
  }
  if (!targetId) {
    context.ui.renderWarning(
      '/thread close',
      'Usage: /thread close [thread-id]'
    )
    return { continue: true }
  }

  const wasActive = context.threadManager.getActiveThread()?.id === targetId
  let closed: boolean
  try {
    closed = await context.closeThread(targetId)
  } finally {
    if (context.threadManager.getThread(targetId) === null) {
      context.ui.removeThreadTimeline(targetId)
    }
  }
  if (!closed) {
    context.ui.renderWarning('/thread close', `Unknown thread: ${targetId}`)
    return { continue: true }
  }

  if (!wasActive) {
    context.ui.renderSuccess('/thread close', `Closed ${targetId}.`)
  }
  return { continue: true }
}

async function detachThread(
  context: CliCommandContext
): Promise<CommandResult> {
  const activeThread = context.threadManager.getActiveThread()
  if (activeThread === null) {
    context.ui.renderWarning('/thread detach', 'No active thread.')
    return { continue: true }
  }

  context.threadManager.deactivateThread()
  context.ui.showHomeTimeline()
  return { continue: true }
}
