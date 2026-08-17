import type { ToolCall } from '../tools/core/tool-registry.ts'
import type { ToolProgressEvent } from '../tools/core/tool-definition.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import {
  ThreadRegistry,
  type ThreadRecord,
  type TurnItem,
  type TurnRecord,
} from './thread-registry.ts'
import { ThreadSelectionController } from './thread-selection.ts'
import type { ThreadRuntime } from './thread-runtime.ts'

export interface ThreadHandle {
  id: string
  provider: string
  runtime: ThreadRuntime
  title: string | null
  turnCount: number
  createdAt: number
  updatedAt: number
}

interface CreateThreadInput {
  id: string
  provider: string
  runtime: ThreadRuntime
  createdAt: number
  origin?: 'new' | 'resumed'
  activate?: boolean
}

export interface ThreadInputHandlers {
  onAssistantStream?: (
    message: string,
    turn: TurnRecord
  ) => void | Promise<void>
  onAssistantStreamReset?: (turn: TurnRecord) => void | Promise<void>
  onTurnItem?: (item: TurnItem, turn: TurnRecord) => void | Promise<void>
  onToolProgress?: (
    event: ToolProgressEvent,
    toolCall: ToolCall | null,
    toolCallId: string,
    turn: TurnRecord
  ) => void
  signal?: AbortSignal
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

export class ThreadCloseCleanupError extends Error {
  public readonly cleanupErrors: readonly unknown[]

  public constructor(
    public readonly threadId: string,
    cleanupErrors: readonly unknown[]
  ) {
    super(
      `Thread ${threadId} was closed, but cleanup failed: ${cleanupErrors.map(String).join('; ')}`,
      {
        cause:
          cleanupErrors.length === 1
            ? cleanupErrors[0]
            : new AggregateError(cleanupErrors),
      }
    )
    this.name = 'ThreadCloseCleanupError'
    this.cleanupErrors = [...cleanupErrors]
  }
}

export class ThreadManager {
  private readonly threads = new ThreadRegistry()
  private readonly selection: ThreadSelectionController
  private readonly runningThreadIds = new Set<string>()
  private readonly pageCloseListeners = new Set<(threadId: string) => void>()
  private readonly pageCloseUnsubscribers = new Map<string, () => void>()
  private readonly closingThreads = new Map<string, Promise<boolean>>()

  public constructor(selection?: ThreadSelectionController) {
    this.selection = selection ?? new ThreadSelectionController()
  }

  public createThreadId(): string {
    return this.threads.createThreadId()
  }

  public onThreadPageClosed(listener: (threadId: string) => void): () => void {
    this.pageCloseListeners.add(listener)
    return () => {
      this.pageCloseListeners.delete(listener)
    }
  }

  public addThread(thread: CreateThreadInput): ThreadHandle {
    const activate = thread.activate ?? true
    this.threads.addThread({
      id: thread.id,
      provider: thread.provider,
      runtime: thread.runtime,
      createdAt: thread.createdAt,
    })
    this.selection.register(thread.id)
    if (activate) {
      this.selection.switch(thread.id)
    }
    const handle = this.toThreadHandle(thread.id)
    this.pageCloseUnsubscribers.set(
      thread.id,
      thread.runtime.onUnexpectedPageClose(() => {
        if (this.threads.getThread(thread.id) === null) {
          return
        }
        for (const listener of [...this.pageCloseListeners]) {
          try {
            listener(thread.id)
          } catch {
            // One observer must not prevent delivery to the remaining observers.
          }
        }
      })
    )
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
    const activeThreadId = this.selection.getActiveId()
    const thread =
      activeThreadId === null ? null : this.threads.getThread(activeThreadId)
    return thread === null ? null : this.toThreadHandle(thread.id)
  }

  public isThreadRunning(id: string): boolean {
    return this.runningThreadIds.has(id)
  }

  public switchThread(id: string): ThreadHandle | null {
    const thread = this.threads.getThread(id)
    if (thread === null || !this.selection.switch(id)) {
      return null
    }
    return thread === null ? null : this.toThreadHandle(thread.id)
  }

  public deactivateThread(): void {
    this.selection.clearActive()
  }

  public resumeLastThread(): ThreadHandle | null {
    const latestThread = this.listThreads().at(-1) ?? null
    if (latestThread === null) {
      return null
    }
    return this.switchThread(latestThread.id)
  }

  public closeThread(id: string): Promise<boolean> {
    const existing = this.closingThreads.get(id)
    if (existing !== undefined) {
      return existing
    }

    const closing = Promise.resolve()
      .then(async () => await this.closeThreadOnce(id))
      .finally(() => {
        if (this.closingThreads.get(id) === closing) {
          this.closingThreads.delete(id)
        }
      })
    this.closingThreads.set(id, closing)
    return closing
  }

  private async closeThreadOnce(id: string): Promise<boolean> {
    const thread = this.threads.getThread(id)
    if (thread === null) {
      return false
    }

    const unsubscribe = this.pageCloseUnsubscribers.get(id)
    this.pageCloseUnsubscribers.delete(id)
    unsubscribe?.()
    const failures: unknown[] = []
    try {
      await thread.runtime.close()
    } catch (error) {
      failures.push(error)
    }
    this.threads.removeThread(id)
    this.selection.detach(id)
    if (failures.length > 0) {
      throw new ThreadCloseCleanupError(id, failures)
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
    const preflight = await thread.runtime.preflightInitialInput(
      input,
      handlers.signal
    )
    if (preflight.status === 'over_limit') {
      throw new Error('Message exceeds the provider input limit.')
    }
    const turn = this.threads.beginTurn(thread.id, input)
    if (turn === null) {
      throw new Error(`Unknown thread: ${thread.id}`)
    }
    const emitTurnItem = async (item: TurnItem) => {
      throwIfAborted(handlers.signal)
      this.threads.appendTurnItem(thread.id, turn.id, item)
      await handlers.onTurnItem?.(item, turn)
    }

    try {
      const assistant = await thread.runtime.submitUserInput(input, {
        onAssistantStream: async (message) => {
          throwIfAborted(handlers.signal)
          await handlers.onAssistantStream?.(message, turn)
        },
        onAssistantStreamReset: async () => {
          throwIfAborted(handlers.signal)
          await handlers.onAssistantStreamReset?.(turn)
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
        onToolCall: async (toolCall: ToolCall, rawPayload, metadata) => {
          await emitTurnItem({
            kind: 'tool_call',
            toolName: toolCall.tool,
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
            toolName: toolCall.tool,
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
      })
      throwIfAborted(handlers.signal)
      this.threads.completeTurn(thread.id, turn.id, 'completed')
      return { assistant, turn }
    } catch (error) {
      if (isAbortError(error)) {
        this.threads.completeTurn(thread.id, turn.id, 'canceled')
        throw error
      }
      await emitTurnItem({
        kind: 'error',
        text: String(error),
        createdAt: Date.now(),
      })
      this.threads.completeTurn(thread.id, turn.id, 'failed')
      throw error
    }
  }
}
