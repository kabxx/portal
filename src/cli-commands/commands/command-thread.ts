import { resolveConversationUrl } from '../../providers/provider-conversation-url.ts'
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
import { getActiveThread } from '../core/command-types.ts'

const THREAD_SUBCOMMANDS = [
  {
    name: 'open',
    usage: 'open <provider> [model-number]',
    description: 'Open a new thread.',
  },
  { name: 'list', usage: 'list', description: 'List local threads.' },
  {
    name: 'history',
    usage: 'history [limit]',
    description: 'Show opened thread history.',
  },
  {
    name: 'resume',
    usage: 'resume <conversation-url|#history-id>',
    description: 'Resume a conversation URL or history entry.',
  },
  {
    name: 'reload',
    usage: 'reload',
    description: 'Reload the active provider page.',
  },
  {
    name: 'switch',
    usage: 'switch <thread-id>',
    description: 'Switch to another thread.',
  },
  {
    name: 'status',
    usage: 'status',
    description: 'Show active thread status.',
  },
  {
    name: 'close',
    usage: 'close [thread-id]',
    description: 'Close a thread.',
  },
  {
    name: 'detach',
    usage: 'detach',
    description: 'Detach from the active thread.',
  },
  {
    name: 'capability',
    usage: 'capability [name] [action]',
    description: 'Show or change active thread capabilities.',
  },
] as const

export const ThreadCommand: CliCommand = {
  name: '/thread',
  usage: '/thread <subcommand>',
  description: 'Manage threads.',
  subcommands: THREAD_SUBCOMMANDS.map(({ name }) => name),
  async execute(context, args) {
    const [subcommand, ...subcommandArgs] = args
    if (subcommand === undefined) {
      renderThreadHelp(context)
      return { continue: true }
    }

    switch (subcommand) {
      case 'open':
        return await openThread(context, subcommandArgs)
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
  const usageWidth = Math.max(
    ...THREAD_SUBCOMMANDS.map(({ usage }) => usage.length)
  )
  context.ui.renderInfo(
    '/thread',
    [
      'Subcommands:',
      ...THREAD_SUBCOMMANDS.map(
        ({ usage, description }) =>
          `  ${usage.padEnd(usageWidth)}  ${description}`
      ),
    ].join('\n')
  )
}

function isSupportedProviderModel(
  provider:
    | 'chatgpt'
    | 'deepseek'
    | 'doubao'
    | 'gemini'
    | 'grok'
    | 'glm'
    | 'kimi',
  model: string
): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    provider === 'gemini'
      ? /^([1-9]\d*)(\+extended)?$/
      : provider === 'chatgpt'
        ? /^([1-9]\d*)(\+[1-9]\d*)?$/
        : /^([1-9]\d*)$/
  ).test(normalized)
}

async function openThread(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const rawProvider = args[0] ?? ''
  if (!rawProvider) {
    context.ui.renderWarning(
      '/thread open',
      'Missing provider. Usage: /thread open <provider> [model-number]'
    )
    return { continue: true }
  }

  const provider = context.resolveProvider(rawProvider)
  if (provider === null) {
    context.ui.renderWarning('/thread open', `Unknown provider: ${rawProvider}`)
    return { continue: true }
  }

  const model = args[1] ?? null
  if (model !== null && !isSupportedProviderModel(provider, model)) {
    context.ui.renderWarning(
      '/thread open',
      `${provider} does not support model "${model}".`
    )
    return { continue: true }
  }

  await context.createThread(provider, model)
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
  const closed = await context.closeThread(targetId)
  if (!closed) {
    context.ui.renderWarning('/thread close', `Unknown thread: ${targetId}`)
    return { continue: true }
  }

  context.ui.removeThreadTimeline(targetId)
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
