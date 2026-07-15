import type { ProviderId } from '../providers/provider-id.ts'

export const HOOK_EVENTS = [
  'thread.ready',
  'thread.closed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'tool.before',
  'tool.after',
  'spawn.started',
  'spawn.completed',
  'spawn.failed',
  'spawn.cancelled',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]
export type HookHandlerType = 'command' | 'prompt' | 'agent'
export type HookErrorPolicy = 'deny' | 'continue'

export interface HookMatchConfig {
  tool?: string
  provider?: ProviderId
}

interface HookHandlerBase {
  name: string
  enabled: boolean
  events: readonly HookEventName[]
  match: HookMatchConfig
  timeoutMs: number
  onError: HookErrorPolicy
}

export interface CommandHookHandler extends HookHandlerBase {
  type: 'command'
  command: readonly string[]
}

interface ModelHookHandlerBase extends HookHandlerBase {
  provider?: ProviderId
  prompt: string
}

export interface PromptHookHandler extends ModelHookHandlerBase {
  type: 'prompt'
}

export interface AgentHookHandler extends ModelHookHandlerBase {
  type: 'agent'
  tools: readonly string[]
  maxTurns: number
}

export type HookHandler =
  | CommandHookHandler
  | PromptHookHandler
  | AgentHookHandler

export interface HooksConfig {
  enabled: boolean
  maxDepth: number
  handlers: readonly HookHandler[]
}

export interface HookSnapshot extends HooksConfig {
  revision: string
  loadedAt: number
}

export interface HookEventEnvelope {
  eventId: string
  event: HookEventName
  occurredAt: number
  cwd: string
  source: 'tui' | 'api' | 'mcp' | 'spawn' | 'hook' | 'system'
  spawnDepth: number
  provider?: ProviderId
  threadId?: string
  turnId?: string
  toolCallId?: string
  spawnId?: string
  parentThreadId?: string
  parentTurnId?: string
  parentToolCallId?: string
  payload: Record<string, unknown>
}

export interface HookExecutionScope {
  snapshot: HookSnapshot
  cwd: string
  source: HookEventEnvelope['source']
  spawnDepth: number
  hookDepth: number
  provider?: ProviderId
  threadId?: string
  turnId?: string
  parentThreadId?: string
  parentTurnId?: string
  parentToolCallId?: string
  originatingHandlerId?: string
}

export type HookDecision =
  | { action: 'allow'; rewrittenBy: readonly string[] }
  | {
      action: 'deny'
      reason: string
      handler: string
      rewrittenBy: readonly string[]
    }
  | {
      action: 'rewrite'
      params: Record<string, unknown> | string
      rewrittenBy: readonly string[]
    }

export type HookHandlerResult =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'rewrite'; params: Record<string, unknown> | string }
  | Record<string, unknown>

export interface HookExecutionEvent {
  hookRunId: string
  phase: 'started' | 'completed' | 'blocked' | 'failed' | 'cancelled'
  event: HookEventName
  handler: string
  handlerType: HookHandlerType
  occurredAt: number
  durationMs?: number
  threadId?: string
  turnId?: string
  toolCallId?: string
  message?: string
}

export interface HookEventSink {
  emit(event: HookExecutionEvent): void | Promise<void>
}

export interface HookModelExecutor {
  execute(
    handler: PromptHookHandler | AgentHookHandler,
    event: HookEventEnvelope,
    scope: HookExecutionScope,
    signal: AbortSignal
  ): Promise<string>
}
