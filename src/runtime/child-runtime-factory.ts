import type { ProviderId } from '../providers/provider-id.ts'
import type { RuntimeCore } from './runtime-core.ts'

const CHILD_CLOSE_TIMEOUT_MS = 2_000
import type {
  AgentHookHandler,
  HookEventEnvelope,
  HookExecutionScope,
  HookModelExecutor,
  PromptHookHandler,
} from '../hooks/hook-types.ts'

export interface ChildRuntimeRequest {
  provider: ProviderId
  allowedTools: readonly string[]
  executionScope: HookExecutionScope
  signal: AbortSignal
}

export interface ChildRuntimeHandle {
  runtime: RuntimeCore
  close(): Promise<void>
}

export class ChildRuntimeFactory implements HookModelExecutor {
  public constructor(
    private readonly defaultProvider: ProviderId,
    private readonly createChild: (
      request: ChildRuntimeRequest
    ) => Promise<ChildRuntimeHandle>
  ) {}

  public async execute(
    handler: PromptHookHandler | AgentHookHandler,
    event: HookEventEnvelope,
    scope: HookExecutionScope,
    signal: AbortSignal
  ): Promise<string> {
    const childScope: HookExecutionScope = {
      ...scope,
      source: 'hook',
      hookDepth: scope.hookDepth + 1,
      originatingHandlerId: handler.name,
    }
    const child = await this.createChild({
      provider: handler.provider ?? event.provider ?? this.defaultProvider,
      allowedTools: handler.type === 'prompt' ? [] : handler.tools,
      executionScope: childScope,
      signal,
    })
    try {
      return await child.runtime.submitUserInput(
        [
          '# Hook Task',
          handler.prompt,
          '',
          '# Hook Event',
          JSON.stringify(event, null, 2),
          '',
          '# Response Contract',
          event.event === 'tool.before'
            ? 'Return only JSON with action "allow", "deny", or "rewrite".'
            : 'Return only one JSON object.',
        ].join('\n'),
        {
          signal,
          executionScope: childScope,
          ...(handler.type === 'agent'
            ? { maxToolCalls: handler.maxTurns - 1 }
            : { maxToolCalls: 0 }),
        }
      )
    } finally {
      await Promise.race([
        child.close().catch(() => {}),
        new Promise<void>((resolve) =>
          setTimeout(resolve, CHILD_CLOSE_TIMEOUT_MS)
        ),
      ])
    }
  }
}
