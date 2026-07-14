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

export class ThreadManager {
  private readonly threads = new ThreadRegistry()
  private readonly runningThreadIds = new Set<string>()

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
    return this.toThreadHandle(thread.id)
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

  public async closeThread(id: string): Promise<boolean> {
    const thread = this.threads.getThread(id)
    if (thread === null) {
      return false
    }

    await thread.runtime.close()
    this.threads.removeThread(id)
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
        onToolCall: async (toolCall: ToolCall | null, rawPayload) => {
          await emitTurnItem({
            kind: 'tool_call',
            toolName: toolCall?.tool ?? 'unknown',
            rawPayload,
            createdAt: Date.now(),
          })
        },
        onToolResult: async (toolResult, toolCall) => {
          await emitTurnItem({
            kind: 'tool_result',
            toolName: toolCall?.tool ?? 'unknown',
            outcome: toolResult.outcome,
            result: toolResult.result,
            ...(toolResult.displayText !== undefined
              ? { displayText: toolResult.displayText }
              : {}),
            createdAt: Date.now(),
          })
        },
        onToolProgress: (event, toolCall) => {
          if (handlers.signal?.aborted !== true) {
            handlers.onToolProgress?.(event, toolCall, turn)
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
    } finally {
      this.threads.syncConversation(thread.id)
    }
  }
}
