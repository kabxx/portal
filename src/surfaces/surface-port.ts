export interface SurfaceThread {
  readonly id: string
  readonly provider: string
  readonly title?: string | null
  readonly conversationUrl?: string
  readonly busy?: boolean
  readonly turnCount?: number
  readonly createdAt?: number
  readonly updatedAt?: number
}

export interface SurfaceJob {
  readonly id: string
  readonly pid: number | null
  readonly command: string
  readonly cwd: string
  readonly shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh'
  readonly startedAt: number
  readonly state: 'running' | 'stopping'
}

export interface SurfacePort {
  listThreads(): readonly SurfaceThread[]
  getThread(threadId: string): SurfaceThread | null
  getActiveThread(): SurfaceThread | null
  switchThread(threadId: string): SurfaceThread | null
}

export type SurfaceMessageEvent =
  | { readonly type: 'assistant.delta'; readonly text: string }
  | { readonly type: 'assistant.result'; readonly text: string }
  | {
      readonly type: 'tool.progress'
      readonly toolName: string
      readonly toolCallId?: string
      readonly event: SurfaceToolProgress
    }
  | { readonly type: 'turn.item'; readonly item: SurfaceTurnItem }

export type SurfaceToolProgress =
  | { readonly type: 'start'; readonly startedAt: number }
  | {
      readonly type: 'output'
      readonly stream: 'stdout' | 'stderr'
      readonly text: string
    }

export type SurfaceTurnItem =
  | { readonly kind: 'assistant_text'; readonly text: string }
  | {
      readonly kind: 'tool_call'
      readonly toolName: string
      readonly rawPayload: string
      readonly toolCallId?: string
    }
  | {
      readonly kind: 'tool_result'
      readonly toolName: string
      readonly outcome: 'success' | 'error' | 'unknown'
      readonly result: Record<string, unknown>
      readonly displayText?: string
      readonly toolCallId?: string
    }
  | { readonly kind: 'status'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

export interface SurfaceOperation {
  readonly threadId: string
  readonly phase: 'running' | 'cancelling' | 'closing'
  readonly startedAt: number
  readonly done: Promise<void>
  readonly settled?: Promise<void>
  cancel(reason?: unknown): Promise<boolean>
}

export type SurfaceStartResult =
  | { readonly accepted: true; readonly operation: SurfaceOperation }
  | {
      readonly accepted: false
      readonly reason: 'not_found' | 'running' | 'closing'
    }

export interface SurfaceCreateThreadInput {
  readonly provider: string
  readonly model:
    string | { readonly key: string; readonly option: string | null } | null
  readonly option: string | null
  readonly mode: 'chat' | 'agent'
  readonly source: 'tui' | 'mcp' | 'exec'
  readonly activate: boolean
}

export interface SurfaceProvisionResult {
  readonly thread: SurfaceThread
  readonly warnings: readonly string[]
}

export interface SurfacePortActions extends SurfacePort {
  listProviders(): readonly string[]
  listJobs(): readonly SurfaceJob[]
  stopJob(jobId: string): Promise<'stopped' | 'not_found' | 'timeout'>
  createThread(
    input: SurfaceCreateThreadInput,
    signal: AbortSignal
  ): Promise<SurfaceProvisionResult>
  resumeThread(
    conversationUrl: string,
    source: 'tui' | 'mcp' | 'exec',
    activate: boolean,
    signal: AbortSignal
  ): Promise<SurfaceProvisionResult>
  closeThread(threadId: string): Promise<{ readonly closed: boolean }>
  startMessage(
    threadId: string,
    input: string,
    onEvent: (event: SurfaceMessageEvent) => void | Promise<void>,
    title?: string,
    signal?: AbortSignal
  ): SurfaceStartResult
  operation(threadId: string): SurfaceOperation | null
  cancelThread(threadId: string): Promise<boolean>
  recordActivity(threadId: string, title: string): Promise<string | null>
  restoreThread(threadId: string): Promise<void>
  preflightMessage(threadId: string, input: string): Promise<void>
}
