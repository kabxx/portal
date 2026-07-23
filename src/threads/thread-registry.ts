import type { RuntimeCore } from '../runtime/runtime-core.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import type { ToolOutcome } from '../tools/core/tool-definition.ts'

export type TurnStatus = 'running' | 'completed' | 'failed' | 'canceled'

export type TurnItem =
  | {
      kind: 'user_text'
      text: string
      createdAt: number
    }
  | {
      kind: 'assistant_text'
      text: string
      createdAt: number
    }
  | {
      kind: 'tool_call'
      toolName: string
      rawPayload: string
      toolCallId?: string
      originalInput?: Record<string, unknown> | string
      createdAt: number
    }
  | {
      kind: 'tool_result'
      toolName: string
      outcome: ToolOutcome
      result: Record<string, unknown>
      displayText?: string
      toolCallId?: string
      effectiveInput?: Record<string, unknown> | string
      rewrittenBy?: readonly string[]
      createdAt: number
    }
  | {
      kind: 'status'
      text: string
      createdAt: number
    }
  | {
      kind: 'error'
      text: string
      createdAt: number
    }

export interface TurnRecord {
  id: string
  threadId: string
  createdAt: number
  status: TurnStatus
  items: TurnItem[]
}

export interface ThreadRecord {
  id: string
  provider: ProviderId
  runtime: RuntimeCore
  title: string | null
  createdAt: number
  updatedAt: number
  pinned: boolean
  turns: TurnRecord[]
}

interface ThreadRegistryState {
  threads: Map<string, ThreadRecord>
}

interface CreateThreadInput {
  id: string
  provider: ThreadRecord['provider']
  runtime: ThreadRecord['runtime']
  createdAt: number
  title?: string | null
  pinned?: boolean
}

export class ThreadRegistry {
  private readonly state: ThreadRegistryState = {
    threads: new Map<string, ThreadRecord>(),
  }
  private nextThreadNumber = 1
  private nextTurnNumber = 1

  public createThreadId(): string {
    const threadId = `t-${this.nextThreadNumber}`
    this.nextThreadNumber += 1
    return threadId
  }

  public addThread(input: CreateThreadInput): ThreadRecord {
    const thread: ThreadRecord = {
      id: input.id,
      provider: input.provider,
      runtime: input.runtime,
      title: input.title ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      pinned: input.pinned ?? false,
      turns: [],
    }
    this.state.threads.set(thread.id, thread)
    return thread
  }

  public listThreads(): ThreadRecord[] {
    return [...this.state.threads.values()].sort(
      (a, b) => a.createdAt - b.createdAt
    )
  }

  public getThread(id: string): ThreadRecord | null {
    return this.state.threads.get(id) ?? null
  }

  public removeThread(id: string): ThreadRecord | null {
    const thread = this.getThread(id)
    if (thread === null) {
      return null
    }
    this.state.threads.delete(id)
    return thread
  }

  public beginTurn(threadId: string, userText: string): TurnRecord | null {
    const thread = this.getThread(threadId)
    if (thread === null) {
      return null
    }

    const createdAt = Date.now()
    const turn: TurnRecord = {
      id: `turn${this.nextTurnNumber}`,
      threadId,
      createdAt,
      status: 'running',
      items: [
        {
          kind: 'user_text',
          text: userText,
          createdAt,
        },
      ],
    }
    this.nextTurnNumber += 1
    thread.turns.push(turn)
    if (thread.title === null) {
      thread.title = this.toTitle(userText)
    }
    thread.updatedAt = createdAt
    return turn
  }

  public appendTurnItem(threadId: string, turnId: string, item: TurnItem) {
    const turn = this.getTurn(threadId, turnId)
    if (turn === null) {
      return
    }
    turn.items.push(item)
    const thread = this.getThread(threadId)
    if (thread !== null) {
      thread.updatedAt = item.createdAt
    }
  }

  public completeTurn(
    threadId: string,
    turnId: string,
    status: TurnStatus
  ): TurnRecord | null {
    const turn = this.getTurn(threadId, turnId)
    if (turn === null) {
      return null
    }
    turn.status = status
    return turn
  }

  public getTurn(threadId: string, turnId: string): TurnRecord | null {
    const thread = this.getThread(threadId)
    if (thread === null) {
      return null
    }
    return thread.turns.find((turn) => turn.id === turnId) ?? null
  }

  private toTitle(text: string): string {
    return this.normalizePreview(text, 48)
  }

  private normalizePreview(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) {
      return '(empty)'
    }
    if (normalized.length <= maxLength) {
      return normalized
    }
    return normalized.slice(0, Math.max(maxLength - 3, 0)) + '...'
  }
}
