import { PortalHost, type PortalHostDependencies } from '../host/portal-host.ts'
import { PortalSurfacePort } from '../host/portal-surface-port.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import type { SurfacePortActions } from '../surfaces/surface-port.ts'
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
    private readonly host: PortalHost,
    private readonly surface: SurfacePortActions
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
    const services = host.services
    return new PortalApplicationCore(
      options,
      host,
      new PortalSurfacePort({
        threadManager: services.threadManager,
        threadLifecycle: services.lifecycle,
        threadOperations: services.threadOperations,
        runCommandJobs: services.runCommandJobs,
      })
    )
  }

  public async run(task: string, signal: AbortSignal): Promise<string> {
    void this.host.services
    if (this.threadId !== null) {
      throw new Error('An exec session can run only one task.')
    }
    const browserDisconnected = this.host.services.browser.disconnected.then(
      () => {
        throw new Error('Browser disconnected while the exec task was running.')
      }
    )
    return await Promise.race([
      this.executeTask(task, signal),
      browserDisconnected,
    ])
  }

  private async executeTask(
    task: string,
    signal: AbortSignal
  ): Promise<string> {
    const provision = await this.surface.createThread(
      {
        provider: this.options.provider,
        model: this.options.model,
        option: null,
        mode: 'agent',
        source: 'exec',
        activate: false,
      },
      signal
    )
    this.threadId = provision.thread.id
    let assistant = ''
    const start = this.surface.startMessage(
      provision.thread.id,
      task,
      async (event) => {
        if (event.type === 'assistant.result') {
          assistant = event.text
        } else if (event.type === 'tool.progress') {
          this.options.onProgress({ type: 'tool', name: event.toolName })
        } else if (event.type === 'turn.item') {
          if (event.item.kind === 'status') {
            this.options.onProgress({
              type: 'status',
              message: event.item.text,
            })
          } else if (event.item.kind === 'tool_call') {
            this.options.onProgress({ type: 'tool', name: event.item.toolName })
          } else if (event.item.kind === 'error') {
            this.options.onProgress({
              type: 'warning',
              message: event.item.text,
            })
          }
        }
      },
      task,
      signal
    )
    if (!start.accepted) {
      throw new Error(
        start.reason === 'closing'
          ? `Thread ${provision.thread.id} is closing.`
          : `Thread ${provision.thread.id} is already running.`
      )
    }
    await start.operation.done
    if (assistant === '') {
      throw new Error('The exec thread did not produce a final response.')
    }
    return assistant
  }

  public async close(): Promise<void> {
    await this.host.close()
  }
}

function reportLifecycleEvent(
  onProgress: (event: ExecProgressEvent) => void,
  event: unknown
): void {
  if (!isRecord(event) || typeof event.type !== 'string') return
  if (event.type === 'provision.warning' && Array.isArray(event.lines)) {
    onProgress({
      type: 'warning',
      message: event.lines
        .filter((line): line is string => typeof line === 'string')
        .join(' '),
    })
  } else if (
    event.type === 'provision.login_wait' &&
    typeof event.provider === 'string'
  ) {
    onProgress({
      type: 'status',
      message: `Waiting for ${event.provider} login...`,
    })
  } else if (
    event.type === 'thread.ready' &&
    typeof event.provider === 'string' &&
    typeof event.conversationUrl === 'string'
  ) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
