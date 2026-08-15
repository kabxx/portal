import { PortalHost, type PortalHostDependencies } from '../host/portal-host.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import type { ThreadLifecycleEvent } from '../threads/thread-lifecycle-service.ts'
import { buildThreadHistoryTitle } from '../threads/thread-store.ts'
import type {
  ExecProgressEvent,
  PortalExecSession,
  PortalExecSessionOptions,
} from './exec-types.ts'

export async function createPortalExecSession(
  options: PortalExecSessionOptions
): Promise<PortalExecSession> {
  return await PortalApplicationCore.open(options)
}

export type PortalApplicationCoreDependencies = PortalHostDependencies

/** UI-independent facade over the shared PortalHost composition. */
export class PortalApplicationCore implements PortalExecSession {
  private threadId: string | null = null

  private constructor(
    private readonly options: PortalExecSessionOptions,
    private readonly host: PortalHost
  ) {}

  public static async open(
    options: PortalExecSessionOptions,
    dependencies: PortalApplicationCoreDependencies = {}
  ): Promise<PortalApplicationCore> {
    throwIfAborted(options.signal)
    const host = await PortalHost.prepare(
      {
        profile: 'exec',
        cwd: options.cwd,
        ...(options.dataDirectory === undefined
          ? {}
          : { dataDirectory: options.dataDirectory }),
        ...(options.browserExecutablePath === undefined
          ? {}
          : { browserExecutablePath: options.browserExecutablePath }),
      },
      dependencies
    )
    options.onProgress({
      type: 'status',
      message: `Connecting to ${options.provider}...`,
    })
    try {
      await host.start({
        signal: options.signal,
        observer: {
          onEvent: (event) =>
            reportLifecycleEvent(
              (progressEvent) => options.onProgress(progressEvent),
              event
            ),
        },
      })
    } catch (error) {
      try {
        await host.close(error)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Portal exec startup failed and could not close cleanly.',
          { cause: cleanupError }
        )
      }
      throw error
    }
    return new PortalApplicationCore(options, host)
  }

  public async run(task: string, signal: AbortSignal): Promise<string> {
    const { browser } = this.host.services
    if (this.threadId !== null) {
      throw new Error('An exec session can run only one task.')
    }
    const disconnected = browser.disconnected.then<never>(() => {
      throw new Error('Browser disconnected while the exec task was running.')
    })
    const execution = this.executeTask(task, signal)
    return await Promise.race([execution, disconnected])
  }

  private async executeTask(
    task: string,
    signal: AbortSignal
  ): Promise<string> {
    const { lifecycle } = this.host.services
    const provision = await lifecycle.create(
      {
        provider: this.options.provider,
        model: this.options.model,
        mode: 'agent',
        source: 'exec',
        activate: false,
        persistInitialHistory: false,
      },
      signal
    )
    if (!provision.ok) throw new Error(provision.failure.message)
    this.threadId = provision.threadId
    const result = await lifecycle.send(provision.threadId, task, {
      signal,
      onTurnItem: async (item) => {
        if (item.kind === 'status') {
          this.options.onProgress({ type: 'status', message: item.text })
        } else if (item.kind === 'tool_call') {
          this.options.onProgress({ type: 'tool', name: item.toolName })
        } else if (item.kind === 'error') {
          this.options.onProgress({ type: 'warning', message: item.text })
        }
      },
    })
    if (result === null) throw new Error('The exec thread could not run.')
    const persistenceWarning = await lifecycle.recordActivity({
      threadId: provision.threadId,
      provider: provision.provider,
      conversationUrl: provision.conversationUrl,
      title: buildThreadHistoryTitle(task),
      createdAt: provision.createdAt,
    })
    if (persistenceWarning !== null) {
      this.options.onProgress({
        type: 'warning',
        message: persistenceWarning,
      })
    }
    return result.assistant
  }

  public async close(): Promise<void> {
    await this.host.close()
  }
}

function reportLifecycleEvent(
  onProgress: (event: ExecProgressEvent) => void,
  event: ThreadLifecycleEvent
): void {
  if (event.type === 'provision.warning') {
    onProgress({ type: 'warning', message: event.lines.join(' ') })
  } else if (event.type === 'provision.login_wait') {
    onProgress({
      type: 'status',
      message: `Waiting for ${event.provider} login...`,
    })
  } else if (event.type === 'thread.ready') {
    const conversation = resolveConversationUrl(event.conversationUrl)
    onProgress({
      type: 'status',
      message:
        conversation === null
          ? `Connected to ${event.provider}.`
          : `Conversation: ${conversation.conversationUrl}`,
    })
  }
}
