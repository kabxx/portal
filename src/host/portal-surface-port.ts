import { buildThreadHistoryTitle } from '../threads/thread-store.ts'
import type {
  ThreadInputHandlers,
  ThreadManager,
} from '../threads/thread-manager.ts'
import type { ThreadLifecycleService } from '../threads/thread-lifecycle-service.ts'
import type { ThreadOperationCoordinator } from '../threads/thread-operation-coordinator.ts'
import type { ProviderHost } from '../providers/provider-host.ts'
import type { AgentHost } from '../agents/agent-host.ts'
import type { TurnItem } from '../threads/thread-registry.ts'
import type {
  SurfaceCreateThreadInput,
  SurfaceMessageEvent,
  SurfaceOperation,
  SurfacePortActions,
  SurfaceProvisionResult,
  SurfaceStartResult,
  SurfaceThread,
  SurfaceTurnItem,
} from '../surfaces/surface-port.ts'

export class PortalSurfacePort implements SurfacePortActions {
  readonly #threads: ThreadManager
  readonly #lifecycle: ThreadLifecycleService
  readonly #operations: ThreadOperationCoordinator
  readonly #providers: ProviderHost
  readonly #agents: AgentHost

  public constructor(options: {
    readonly threadManager: ThreadManager
    readonly threadLifecycle: ThreadLifecycleService
    readonly threadOperations: ThreadOperationCoordinator
    readonly providerHost: ProviderHost
    readonly agentHost: AgentHost
  }) {
    this.#threads = options.threadManager
    this.#lifecycle = options.threadLifecycle
    this.#operations = options.threadOperations
    this.#providers = options.providerHost
    this.#agents = options.agentHost
  }

  public listThreads(): readonly SurfaceThread[] {
    return Object.freeze(
      this.#threads.listThreads().map((thread) => this.toThread(thread))
    )
  }

  public getThread(threadId: string): SurfaceThread | null {
    const thread = this.#threads.getThread(threadId)
    return thread === null ? null : this.toThread(thread)
  }

  public getActiveThread(): SurfaceThread | null {
    const thread = this.#threads.getActiveThread()
    return thread === null ? null : this.toThread(thread)
  }

  public switchThread(threadId: string): SurfaceThread | null {
    const thread = this.#threads.switchThread(threadId)
    return thread === null ? null : this.toThread(thread)
  }

  public listProviders(): readonly string[] {
    return Object.freeze(this.#providers.list().map(({ id }) => id))
  }

  public listAgentModes(): readonly ('chat' | 'agent')[] {
    return Object.freeze(
      this.#agents.list().map(({ descriptor }) => descriptor.mode)
    )
  }

  public async createThread(
    input: SurfaceCreateThreadInput,
    signal: AbortSignal
  ): Promise<SurfaceProvisionResult> {
    this.#agents.resolveMode(input.mode)
    const provider = this.#providers.resolveProviderId(input.provider)
    if (provider === null)
      throw new Error(`Unsupported provider: ${input.provider}`)
    const provision = await this.#lifecycle.create(
      {
        provider,
        model: this.#providers.resolveModel(
          provider,
          typeof input.model === 'string' || input.model === null
            ? input.model
            : input.model.key,
          typeof input.model === 'object' && input.model !== null
            ? input.model.option
            : input.option
        ),
        mode: input.mode,
        source: input.source,
        activate: input.activate,
        persistInitialHistory: input.source !== 'exec',
      },
      signal
    )
    if (!provision.ok) throw new Error(provision.failure.message)
    const thread = this.getThread(provision.threadId)
    if (thread === null)
      throw new Error(`Thread was not committed: ${provision.threadId}`)
    return Object.freeze({ thread, warnings: provision.warnings })
  }

  public async resumeThread(
    conversationUrl: string,
    source: 'tui' | 'mcp' | 'exec',
    activate: boolean,
    signal: AbortSignal
  ): Promise<SurfaceProvisionResult> {
    const provision = await this.#lifecycle.resume(
      { conversationUrl, source, activate },
      signal
    )
    if (!provision.ok) throw new Error(provision.failure.message)
    const thread = this.getThread(provision.threadId)
    if (thread === null)
      throw new Error(`Thread was not committed: ${provision.threadId}`)
    return Object.freeze({ thread, warnings: provision.warnings })
  }

  public async closeThread(
    threadId: string
  ): Promise<{ readonly closed: boolean }> {
    return Object.freeze({
      closed: (await this.#lifecycle.close(threadId, 'user')).closed,
    })
  }

  public startMessage(
    threadId: string,
    input: string,
    onEvent: (event: SurfaceMessageEvent) => void | Promise<void>,
    title = input,
    signal?: AbortSignal
  ): SurfaceStartResult {
    const start = this.#lifecycle.startSend(threadId, input, async (signal) => {
      const handlers: ThreadInputHandlers = {
        signal,
        onAssistantStream: async (text) =>
          await onEvent({ type: 'assistant.delta', text }),
        onToolProgress: (event, toolCall, toolCallId) => {
          void Promise.resolve()
            .then(
              async () =>
                await onEvent({
                  type: 'tool.progress',
                  toolName: toolCall?.tool ?? 'tool',
                  ...(toolCallId === undefined ? {} : { toolCallId }),
                  event,
                })
            )
            .catch(() => undefined)
        },
        onTurnItem: async (item) =>
          await onEvent({ type: 'turn.item', item: mapTurnItem(item) }),
      }
      const result = await this.#threads.submitThreadInput(
        threadId,
        input,
        handlers
      )
      await this.#lifecycle.recordActivity({
        threadId,
        provider: this.#threads.getThread(threadId)!.provider,
        conversationUrl:
          this.#threads.getThread(threadId)!.runtime.conversationUrl,
        title: buildThreadHistoryTitle(title),
      })
      if (result !== null) {
        await onEvent({ type: 'assistant.result', text: result.assistant })
      }
    })
    if (!start.accepted) return start
    const operation =
      start.operation.settled === undefined
        ? start.operation
        : Object.freeze({
            ...start.operation,
            done: Promise.all([
              start.operation.done,
              start.operation.settled,
            ]).then(() => undefined),
          })
    if (signal !== undefined) {
      const cancel = () => {
        void start.operation.cancel().catch(() => undefined)
      }
      if (signal.aborted) cancel()
      else {
        signal.addEventListener('abort', cancel, { once: true })
        void operation.done.then(
          () => signal.removeEventListener('abort', cancel),
          () => signal.removeEventListener('abort', cancel)
        )
      }
    }
    return Object.freeze({ accepted: true, operation })
  }

  public async cancelThread(threadId: string): Promise<boolean> {
    return await this.#lifecycle.cancel(threadId)
  }

  public async recordActivity(
    threadId: string,
    title: string
  ): Promise<string | null> {
    const thread = this.#threads.getThread(threadId)
    if (thread === null) throw new Error(`Unknown thread: ${threadId}`)
    return await this.#lifecycle.recordActivity({
      threadId,
      provider: thread.provider,
      conversationUrl: thread.runtime.conversationUrl,
      title,
    })
  }

  public async restoreThread(threadId: string): Promise<void> {
    const thread = this.#threads.getThread(threadId)
    if (thread === null) throw new Error(`Unknown thread: ${threadId}`)
    await thread.runtime.restore()
  }

  public async preflightMessage(
    threadId: string,
    input: string
  ): Promise<void> {
    const thread = this.#threads.getThread(threadId)
    if (thread === null) throw new Error(`Unknown thread: ${threadId}`)
    const check = await thread.runtime.preflightInitialInput(input)
    if (check.status === 'over_limit') {
      throw new Error('Message exceeds the provider input limit.')
    }
  }

  public operation(threadId: string): SurfaceOperation | null {
    return this.#lifecycle.getOperation(threadId)
  }

  private toThread(thread: {
    readonly id: string
    readonly provider: string
    readonly runtime: { readonly conversationUrl: string }
    readonly title: string | null
    readonly turnCount: number
    readonly createdAt: number
    readonly updatedAt: number
  }): SurfaceThread {
    return Object.freeze({
      id: thread.id,
      provider: thread.provider,
      title: thread.title,
      conversationUrl: thread.runtime.conversationUrl,
      busy: this.#operations.get(thread.id) !== null,
      turnCount: thread.turnCount,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    })
  }
}

function mapTurnItem(item: TurnItem): SurfaceTurnItem {
  if (item.kind === 'assistant_text')
    return { kind: 'assistant_text', text: item.text }
  if (item.kind === 'tool_call') {
    return {
      kind: 'tool_call',
      toolName: item.toolName,
      rawPayload: item.rawPayload,
      ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    }
  }
  if (item.kind === 'tool_result') {
    return {
      kind: 'tool_result',
      toolName: item.toolName,
      outcome: item.outcome,
      result: item.result,
      ...(item.displayText === undefined
        ? {}
        : { displayText: item.displayText }),
      ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
    }
  }
  if (item.kind === 'status') return { kind: 'status', text: item.text }
  return { kind: 'error', text: item.text }
}
