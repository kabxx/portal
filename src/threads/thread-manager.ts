import type { ToolCall } from '../tools/core/tool-registry.ts'
import type { ToolProgressEvent } from '../tools/core/tool-definition.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import type { ProjectInstructionWarning } from '../instructions/project-instructions.ts'
import {
  ThreadRegistry,
  type ThreadRecord,
  type TurnItem,
  type TurnRecord,
} from './thread-registry.ts'
import type { HookCatalog } from '../hooks/hook-catalog.ts'
import type { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import type { HookExecutionScope } from '../hooks/hook-types.ts'

export interface ThreadHandle {
  id: string
  provider: ProviderId
  runtime: RuntimeCore
  title: string | null
  turnCount: number
  createdAt: number
  updatedAt: number
}

interface CreateThreadInput {
  id: string
  provider: ProviderId
  runtime: RuntimeCore
  createdAt: number
  origin?: 'new' | 'resumed'
  source?: HookExecutionScope['source']
}

export interface ThreadInputHandlers {
  onAssistantStream?: (
    message: string,
    turn: TurnRecord
  ) => void | Promise<void>
  onManualSkill?: (name: string, turn: TurnRecord) => void | Promise<void>
  onInstructionWarning?: (
    warning: ProjectInstructionWarning,
    turn: TurnRecord
  ) => void | Promise<void>
  onTurnItem?: (item: TurnItem, turn: TurnRecord) => void | Promise<void>
  onToolProgress?: (
    event: ToolProgressEvent,
    toolCall: ToolCall | null,
    toolCallId: string,
    turn: TurnRecord
  ) => void
  signal?: AbortSignal
  source?: HookExecutionScope['source']
}

export interface ThreadInputResult {
  assistant: string
  turn: TurnRecord
}

export class ThreadAlreadyRunningError extends Error {
  public constructor(threadId: string) {
    super(`Thread ${threadId} is already running.`)
    this.name = 'ThreadAlreadyRunningError'
  }
}

export class ThreadManager {
  private readonly threads = new ThreadRegistry()
  private readonly runningThreadIds = new Set<string>()
  private readonly ready = new Map<string, Promise<void>>()

  public constructor(
    private readonly hookCatalog: HookCatalog | null = null,
    private readonly hookDispatcher: HookDispatcher | null = null,
    private readonly cwd: string = process.cwd()
  ) {}

  public createThreadId(): string {
    return this.threads.createThreadId()
  }

  public addThread(thread: CreateThreadInput): ThreadHandle {
    this.threads.addThread({
      id: thread.id,
      provider: thread.provider,
      runtime: thread.runtime,
      createdAt: thread.createdAt,
    })
    const handle = this.toThreadHandle(thread.id)
    if (this.hookCatalog !== null && this.hookDispatcher !== null) {
      const scope = this.createHookScope(
        handle,
        this.hookCatalog.snapshot(),
        thread.source ?? 'system'
      )
      this.ready.set(
        thread.id,
        this.hookDispatcher
          .dispatch(
            this.hookDispatcher.createEvent('thread.ready', scope, {
              origin: thread.origin ?? 'new',
            }),
            scope
          )
          .then(() => {})
      )
    }
    return handle
  }

  public listThreads(): ThreadHandle[] {
    return this.threads
      .listThreads()
      .map((thread) => this.toThreadHandle(thread.id))
  }

  public getThread(id: string): ThreadHandle | null {
    const thread = this.threads.getThread(id)
    return thread === null ? null : this.toThreadHandle(thread.id)
  }

  public getActiveThread(): ThreadHandle | null {
    const thread = this.threads.getActiveThread()
    return thread === null ? null : this.toThreadHandle(thread.id)
  }

  public isThreadRunning(id: string): boolean {
    return this.runningThreadIds.has(id)
  }

  public switchThread(id: string): ThreadHandle | null {
    const thread = this.threads.switchThread(id)
    return thread === null ? null : this.toThreadHandle(thread.id)
  }

  public deactivateThread(): void {
    this.threads.clearActiveThread()
  }

  public resumeLastThread(): ThreadHandle | null {
    const latestThread = this.listThreads().at(-1) ?? null
    if (latestThread === null) {
      return null
    }
    return this.switchThread(latestThread.id)
  }

  public async closeThread(
    id: string,
    source: HookExecutionScope['source'] = 'system'
  ): Promise<boolean> {
    const thread = this.threads.getThread(id)
    if (thread === null) {
      return false
    }

    await this.ready.get(id)
    await thread.runtime.close()
    this.threads.removeThread(id)
    this.ready.delete(id)
    if (this.hookCatalog !== null && this.hookDispatcher !== null) {
      const scope = this.createHookScope(
        thread,
        this.hookCatalog.snapshot(),
        source
      )
      await this.hookDispatcher.dispatch(
        this.hookDispatcher.createEvent('thread.closed', scope),
        scope
      )
    }
    return true
  }

  public async submitThreadInput(
    id: string,
    input: string,
    handlers: ThreadInputHandlers = {}
  ): Promise<ThreadInputResult | null> {
    const thread = this.threads.getThread(id)
    if (thread === null) {
      return null
    }
    if (this.runningThreadIds.has(id)) {
      throw new ThreadAlreadyRunningError(id)
    }

    this.runningThreadIds.add(id)
    try {
      return await this.runThreadInput(thread, input, handlers)
    } finally {
      this.runningThreadIds.delete(id)
    }
  }

  private toThreadHandle(id: string): ThreadHandle {
    const thread = this.threads.getThread(id)
    if (thread === null) {
      throw new Error(`Unknown thread: ${id}`)
    }

    return {
      id: thread.id,
      provider: thread.provider,
      runtime: thread.runtime,
      title: thread.title,
      turnCount: thread.turns.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }
  }

  private async runThreadInput(
    thread: ThreadRecord,
    input: string,
    handlers: ThreadInputHandlers
  ): Promise<ThreadInputResult> {
    throwIfAborted(handlers.signal)
    await this.ready.get(thread.id)
    const turn = this.threads.beginTurn(thread.id, input)
    if (turn === null) {
      throw new Error(`Unknown thread: ${thread.id}`)
    }
    const hookScope =
      this.hookCatalog === null
        ? undefined
        : this.createHookScope(
            thread,
            this.hookCatalog.snapshot(),
            handlers.source ?? 'tui',
            turn.id
          )
    const emitTurnItem = async (item: TurnItem) => {
      throwIfAborted(handlers.signal)
      this.threads.appendTurnItem(thread.id, turn.id, item)
      await handlers.onTurnItem?.(item, turn)
    }

    try {
      if (hookScope !== undefined && this.hookDispatcher !== null) {
        await this.hookDispatcher.dispatch(
          this.hookDispatcher.createEvent('turn.started', hookScope, { input }),
          hookScope,
          handlers.signal
        )
      }
      const assistant = await thread.runtime.submitUserInput(input, {
        onAssistantStream: async (message) => {
          throwIfAborted(handlers.signal)
          await handlers.onAssistantStream?.(message, turn)
        },
        onManualSkill: async (name) => {
          throwIfAborted(handlers.signal)
          await handlers.onManualSkill?.(name, turn)
        },
        onInstructionWarning: async (warning) => {
          throwIfAborted(handlers.signal)
          await handlers.onInstructionWarning?.(warning, turn)
        },
        onAssistantText: async (message) => {
          await emitTurnItem({
            kind: 'assistant_text',
            text: message,
            createdAt: Date.now(),
          })
        },
        onStatus: async (message) => {
          await emitTurnItem({
            kind: 'status',
            text: message,
            createdAt: Date.now(),
          })
        },
        onToolCall: async (toolCall: ToolCall | null, rawPayload, metadata) => {
          await emitTurnItem({
            kind: 'tool_call',
            toolName: toolCall?.tool ?? 'unknown',
            rawPayload,
            ...(metadata === undefined
              ? {}
              : {
                  toolCallId: metadata.toolCallId,
                  originalInput: metadata.originalInput,
                }),
            createdAt: Date.now(),
          })
        },
        onToolResult: async (toolResult, toolCall, metadata) => {
          await emitTurnItem({
            kind: 'tool_result',
            toolName: toolCall?.tool ?? 'unknown',
            outcome: toolResult.outcome,
            result: toolResult.result,
            ...(toolResult.displayText !== undefined
              ? { displayText: toolResult.displayText }
              : {}),
            ...(metadata === undefined
              ? {}
              : {
                  toolCallId: metadata.toolCallId,
                  effectiveInput: metadata.effectiveInput,
                  rewrittenBy: metadata.rewrittenBy,
                }),
            createdAt: Date.now(),
          })
        },
        onToolProgress: (event, toolCall, toolCallId) => {
          if (handlers.signal?.aborted !== true) {
            handlers.onToolProgress?.(event, toolCall, toolCallId, turn)
          }
        },
        ...(handlers.signal !== undefined ? { signal: handlers.signal } : {}),
        ...(hookScope === undefined ? {} : { executionScope: hookScope }),
      })
      throwIfAborted(handlers.signal)
      this.threads.completeTurn(thread.id, turn.id, 'completed')
      if (hookScope !== undefined && this.hookDispatcher !== null) {
        await this.hookDispatcher.dispatch(
          this.hookDispatcher.createEvent('turn.completed', hookScope, {
            assistant,
          }),
          hookScope
        )
      }
      return { assistant, turn }
    } catch (error) {
      if (isAbortError(error)) {
        this.threads.completeTurn(thread.id, turn.id, 'canceled')
        if (hookScope !== undefined && this.hookDispatcher !== null) {
          await this.hookDispatcher.dispatch(
            this.hookDispatcher.createEvent('turn.cancelled', hookScope, {
              message: error instanceof Error ? error.message : String(error),
            }),
            hookScope
          )
        }
        throw error
      }
      await emitTurnItem({
        kind: 'error',
        text: String(error),
        createdAt: Date.now(),
      })
      this.threads.completeTurn(thread.id, turn.id, 'failed')
      if (hookScope !== undefined && this.hookDispatcher !== null) {
        await this.hookDispatcher.dispatch(
          this.hookDispatcher.createEvent('turn.failed', hookScope, {
            message: error instanceof Error ? error.message : String(error),
          }),
          hookScope
        )
      }
      throw error
    } finally {
      this.threads.syncConversation(thread.id)
    }
  }

  private createHookScope(
    thread: Pick<ThreadHandle, 'id' | 'provider'>,
    snapshot: ReturnType<HookCatalog['snapshot']>,
    source: HookExecutionScope['source'],
    turnId?: string
  ): HookExecutionScope {
    return {
      snapshot,
      cwd: this.cwd,
      source,
      spawnDepth: 0,
      hookDepth: 0,
      provider: thread.provider,
      threadId: thread.id,
      ...(turnId === undefined ? {} : { turnId }),
    }
  }
}
