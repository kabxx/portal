import { randomUUID } from 'node:crypto'

import { runHookCommand } from './hook-command-runner.ts'
import type {
  HookDecision,
  HookEventEnvelope,
  HookEventName,
  HookEventSink,
  HookExecutionScope,
  HookHandler,
  HookHandlerResult,
  HookModelExecutor,
} from './hook-types.ts'

export class HookDispatcher {
  public constructor(
    private modelExecutor: HookModelExecutor | null = null,
    private readonly sink: HookEventSink | null = null
  ) {}

  public setModelExecutor(executor: HookModelExecutor): void {
    this.modelExecutor = executor
  }

  public async dispatch(
    event: HookEventEnvelope,
    scope: HookExecutionScope,
    signal?: AbortSignal
  ): Promise<HookDecision> {
    const rewrittenBy: string[] = []
    let params = event.payload.params
    const handlers = scope.snapshot.enabled
      ? scope.snapshot.handlers.filter((handler) =>
          this.matches(handler, event, scope)
        )
      : []

    for (const handler of handlers) {
      const handlerEvent =
        params === undefined
          ? event
          : { ...event, payload: { ...event.payload, params } }
      let result: HookHandlerResult
      try {
        result = await this.runHandler(handler, handlerEvent, scope, signal)
      } catch (error) {
        if (signal?.aborted === true) throw error
        if (handler.onError === 'deny' && event.event === 'tool.before') {
          return {
            action: 'deny',
            reason: `Hook ${handler.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            handler: handler.name,
            rewrittenBy,
          }
        }
        continue
      }
      if (event.event !== 'tool.before') continue
      if (result.action === 'deny') {
        return {
          action: 'deny',
          reason:
            typeof result.reason === 'string' && result.reason.trim()
              ? result.reason
              : `Blocked by hook ${handler.name}`,
          handler: handler.name,
          rewrittenBy,
        }
      }
      if (result.action === 'rewrite') {
        params = result.params
        rewrittenBy.push(handler.name)
      }
    }
    return rewrittenBy.length === 0
      ? { action: 'allow', rewrittenBy }
      : {
          action: 'rewrite',
          params: params as Record<string, unknown> | string,
          rewrittenBy,
        }
  }

  public createEvent(
    event: HookEventName,
    scope: HookExecutionScope,
    payload: Record<string, unknown> = {},
    ids: Partial<Pick<HookEventEnvelope, 'toolCallId' | 'spawnId'>> = {}
  ): HookEventEnvelope {
    return {
      eventId: randomUUID(),
      event,
      occurredAt: Date.now(),
      cwd: scope.cwd,
      source: scope.source,
      spawnDepth: scope.spawnDepth,
      ...(scope.provider === undefined ? {} : { provider: scope.provider }),
      ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
      ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
      ...(scope.parentThreadId === undefined
        ? {}
        : { parentThreadId: scope.parentThreadId }),
      ...(scope.parentTurnId === undefined
        ? {}
        : { parentTurnId: scope.parentTurnId }),
      ...(scope.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: scope.parentToolCallId }),
      ...ids,
      payload,
    }
  }

  private matches(
    handler: HookHandler,
    event: HookEventEnvelope,
    scope: HookExecutionScope
  ): boolean {
    if (!handler.enabled || !handler.events.includes(event.event)) return false
    if (handler.name === scope.originatingHandlerId) return false
    if (scope.hookDepth > scope.snapshot.maxDepth) return false
    if (
      handler.match.provider !== undefined &&
      handler.match.provider !== event.provider
    )
      return false
    if (
      handler.match.tool !== undefined &&
      handler.match.tool !== event.payload.tool
    )
      return false
    return true
  }

  private async runHandler(
    handler: HookHandler,
    event: HookEventEnvelope,
    scope: HookExecutionScope,
    signal?: AbortSignal
  ): Promise<HookHandlerResult> {
    const hookRunId = randomUUID()
    const startedAt = Date.now()
    await this.emit({
      hookRunId,
      phase: 'started',
      event: event.event,
      handler: handler.name,
      handlerType: handler.type,
      occurredAt: startedAt,
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.toolCallId === undefined
        ? {}
        : { toolCallId: event.toolCallId }),
    })
    const timeout = new AbortController()
    const onAbort = () => timeout.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () =>
        timeout.abort(new Error(`Hook timed out after ${handler.timeoutMs}ms`)),
      handler.timeoutMs
    )
    try {
      let output: string
      if (handler.type === 'command') {
        output = await runHookCommand(handler.command, event, {
          cwd: event.cwd,
          timeoutMs: handler.timeoutMs,
          signal: timeout.signal,
        })
      } else {
        if (this.modelExecutor === null)
          throw new Error(`${handler.type} hook execution is not configured`)
        output = await this.modelExecutor.execute(
          handler,
          event,
          scope,
          timeout.signal
        )
      }
      const result = parseHandlerOutput(output, event.event)
      await this.emit({
        hookRunId,
        phase: result.action === 'deny' ? 'blocked' : 'completed',
        event: event.event,
        handler: handler.name,
        handlerType: handler.type,
        occurredAt: Date.now(),
        durationMs: Date.now() - startedAt,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.toolCallId === undefined
          ? {}
          : { toolCallId: event.toolCallId }),
        ...(result.action === 'deny'
          ? {
              message:
                typeof result.reason === 'string'
                  ? result.reason
                  : `Blocked by hook ${handler.name}`,
            }
          : {}),
      })
      return result
    } catch (error) {
      await this.emit({
        hookRunId,
        phase: signal?.aborted === true ? 'cancelled' : 'failed',
        event: event.event,
        handler: handler.name,
        handlerType: handler.type,
        occurredAt: Date.now(),
        durationMs: Date.now() - startedAt,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.toolCallId === undefined
          ? {}
          : { toolCallId: event.toolCallId }),
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async emit(
    event: Parameters<HookEventSink['emit']>[0]
  ): Promise<void> {
    try {
      await this.sink?.emit(event)
    } catch {
      // Observers must not affect Hook control flow.
    }
  }
}

function parseHandlerOutput(
  output: string,
  event: HookEventName
): HookHandlerResult {
  const trimmed = output.trim()
  if (trimmed === '') throw new Error('Hook returned empty output')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('Hook returned invalid JSON')
  }
  if (!isRecord(value)) throw new Error('Hook output must be a JSON object')
  if (event !== 'tool.before') return value
  if (value.action === 'allow') return { action: 'allow' }
  if (value.action === 'deny') {
    if (value.reason !== undefined && typeof value.reason !== 'string')
      throw new Error('Hook deny reason must be a string')
    return {
      action: 'deny',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    }
  }
  if (value.action === 'rewrite') {
    if (!isRecord(value.params) && typeof value.params !== 'string')
      throw new Error('Hook rewrite params must be an object or string')
    return { action: 'rewrite', params: value.params }
  }
  throw new Error('tool.before Hook must return action allow, deny, or rewrite')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
