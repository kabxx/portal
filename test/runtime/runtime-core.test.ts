import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import {
  ProviderAdapter,
  ProviderAdapterError,
  ProviderResponseTimeoutError,
  type AbortOptions,
  type ProviderTimingOptions,
} from '../../src/providers/adapters/adapter-base.ts'
import { ToolRegistry } from '../../src/tools/core/tool-registry.ts'
import {
  Tool,
  defineToolMetadata,
  type ToolConstructor,
} from '../../src/tools/core/tool-definition.ts'
import type {
  ToolExecutionOptions,
  ToolOutcome,
  ToolOutput,
} from '../../src/tools/core/tool-definition.ts'
import {
  ComposerLimitExceededError,
  type ComposerLimit,
} from '../../src/providers/composer-limit.ts'
import {
  abortable,
  PortalAbortError,
} from '../../src/runtime/runtime-cancellation.ts'
import { loadProjectInstructions } from '../../src/instructions/project-instructions.ts'
import {
  createHookSnapshot,
  parseHooksConfig,
} from '../../src/hooks/hook-config.ts'
import { HookDispatcher } from '../../src/hooks/hook-dispatcher.ts'
import type { HookExecutionScope } from '../../src/hooks/hook-types.ts'
import { createBrowserContextStub } from '../helpers/fakes.ts'
import { SETUP_HANDSHAKE_PROMPT } from '../../src/runtime/setup-handshake.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class FakeAdapter extends ProviderAdapter {
  public readonly attachedTexts: string[] = []
  public readonly retryPreparedTexts: string[] = []
  public readonly submitSignals: Array<AbortSignal | undefined> = []
  public submitTextReporterMessages: string[] = []
  public retryClearCalls = 0

  public constructor(
    private readonly responses: string[],
    timings?: ProviderTimingOptions
  ) {
    super(createBrowserContextStub(), timings === undefined ? {} : { timings })
  }

  public async restore(): Promise<void> {
    return undefined
  }

  public async isLoggedIn(): Promise<boolean> {
    return true
  }

  public get conversationId(): string | null {
    return null
  }

  public get conversationUrl(): string {
    return 'https://example.com/thread'
  }

  public async changeModel(
    _model: Parameters<ProviderAdapter['changeModel']>[0]
  ): Promise<void> {
    return undefined
  }

  public async attachText(text: string): Promise<void> {
    this.attachedTexts.push(text)
  }

  protected override async prepareRetrySubmit(
    text: string,
    _options: AbortOptions
  ): Promise<() => Promise<void>> {
    this.retryPreparedTexts.push(text)
    this.attachedTexts.push(text)
    return async () => {
      this.retryClearCalls += 1
    }
  }

  public async attachFile(_path: string | readonly string[]): Promise<void> {
    return undefined
  }

  public async attachImage(_path: string | readonly string[]): Promise<void> {
    return undefined
  }

  public async submit(options?: AbortOptions): Promise<string> {
    this.submitSignals.push(options?.signal)
    const queuedResponse = this.responses[0]
    if (queuedResponse !== undefined) {
      const halfway = Math.max(1, Math.floor(queuedResponse.length / 2))
      await this.emitSubmitText(queuedResponse.slice(0, halfway))
      await this.emitSubmitText(queuedResponse)
      this.submitTextReporterMessages.push(queuedResponse)
    }
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error('No fake adapter response queued.')
    }
    return response
  }
}

class LimitedFakeAdapter extends FakeAdapter {
  public constructor(
    responses: string[],
    private readonly composerLimit: Extract<ComposerLimit, { kind: 'known' }>
  ) {
    super(responses)
  }

  public override async getComposerLimit(): Promise<ComposerLimit> {
    return this.composerLimit
  }
}

class RetryToolResultAdapter extends LimitedFakeAdapter {
  public restoreCalls = 0
  private submitCalls = 0

  public override async submit(options?: AbortOptions): Promise<string> {
    this.submitCalls += 1
    if (this.submitCalls === 2) {
      this.submitSignals.push(options?.signal)
      throw new ProviderAdapterError(
        'submit',
        'temporary tool result failure',
        {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
        }
      )
    }
    return await super.submit(options)
  }

  public override async restore(): Promise<void> {
    this.restoreCalls += 1
  }
}

class RetryableToolResultAdapter extends LimitedFakeAdapter {
  private submitCalls = 0

  public override async submit(options?: AbortOptions): Promise<string> {
    this.submitCalls += 1
    if (this.submitCalls === 2) {
      this.submitSignals.push(options?.signal)
      await this.emitSubmitText('partial tool result response')
      throw new ProviderAdapterError('submit', 'rate limited', {
        kind: 'rate_limit',
        recovery: 'retry',
        retryable: true,
        maxAttempts: 2,
      })
    }
    return await super.submit(options)
  }
}

class StallingAdapter extends FakeAdapter {
  public stopCalls = 0

  public constructor(responses: string[] = []) {
    super(responses, {
      requestStartWarningAfterMs: 100,
      blockedWarningIntervalMs: 100,
      responseStartTimeoutMs: 10,
      responseStallTimeoutMs: 10,
      restoreTimeoutMs: 100,
      historyLoadTimeoutMs: 100,
      historyPageTimeoutMs: 100,
    })
  }

  public override async submit(options: AbortOptions = {}): Promise<string> {
    this.submitSignals.push(options.signal)
    this.emitSubmitSent()
    return await abortable(new Promise<string>(() => {}), options.signal)
  }

  public override async stopGeneration(): Promise<void> {
    this.stopCalls += 1
  }
}

class TimeoutThenSuccessAdapter extends StallingAdapter {
  private firstSubmit = true

  public constructor() {
    super(['Done.'])
  }

  public override async submit(options: AbortOptions = {}): Promise<string> {
    if (this.firstSubmit) {
      this.firstSubmit = false
      return await super.submit(options)
    }
    return await FakeAdapter.prototype.submit.call(this, options)
  }
}

class RateLimitThenSuccessAdapter extends FakeAdapter {
  private failuresRemaining: number
  private readonly streamBeforeFailure: boolean

  public constructor(
    failures = 1,
    streamBeforeFailure = false,
    responses = ['Done.']
  ) {
    super(responses)
    this.failuresRemaining = failures
    this.streamBeforeFailure = streamBeforeFailure
  }

  public override async submit(options?: AbortOptions): Promise<string> {
    this.submitSignals.push(options?.signal)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      if (this.streamBeforeFailure) {
        await this.emitSubmitText('partial response')
      }
      throw new ProviderAdapterError('submit', 'rate limited', {
        kind: 'rate_limit',
        recovery: 'retry',
        retryable: true,
        maxAttempts: 2,
      })
    }
    return await super.submit(options)
  }
}

class RateLimitOnSecondSubmitAdapter extends FakeAdapter {
  private submitCount = 0

  public override async submit(options?: AbortOptions): Promise<string> {
    this.submitCount += 1
    if (this.submitCount === 2) {
      this.submitSignals.push(options?.signal)
      throw new ProviderAdapterError('submit', 'rate limited', {
        kind: 'rate_limit',
        recovery: 'retry',
        retryable: true,
        maxAttempts: 2,
      })
    }
    return await super.submit(options)
  }
}

class RetryRestoreAdapter extends FakeAdapter {
  public restoreStarted = false
  public restoreSignal: AbortSignal | undefined
  private shouldFailSubmit = true

  public override async submit(options?: AbortOptions): Promise<string> {
    if (!this.shouldFailSubmit) {
      return await super.submit(options)
    }

    this.shouldFailSubmit = false
    this.submitSignals.push(options?.signal)
    throw new ProviderAdapterError('submit', 'temporary failure', {
      kind: 'transient',
      recovery: 'restore',
      retryable: true,
      maxAttempts: 2,
    })
  }

  public override async restore(options: AbortOptions = {}): Promise<void> {
    this.restoreStarted = true
    this.restoreSignal = options.signal
    await abortable(new Promise<void>(() => {}), options.signal)
  }
}

function createRuntimeForRetryTests(
  adapter: ProviderAdapter,
  tools: ToolConstructor[] = []
): RuntimeCore {
  return new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, tools),
    null,
    null,
    null,
    null,
    null,
    null,
    [],
    null,
    3
  )
}

let retryCountingToolCalls = 0

@defineToolMetadata({
  name: 'retry_counting_tool',
  description: 'Counts executions across provider retries.',
})
class RetryCountingTool extends Tool<
  Record<string, unknown>,
  { result: { value: string }; displayText: string }
> {
  public async call(): Promise<{
    result: { value: string }
    displayText: string
  }> {
    retryCountingToolCalls += 1
    return {
      result: { value: 'tool result' },
      displayText: 'tool result',
    }
  }
}

@defineToolMetadata({
  name: 'slow_tool',
  description: 'A slow test tool.',
})
class SlowTool extends Tool<Record<string, unknown>, ToolOutput> {
  public started = false

  public async call(
    _input: Record<string, unknown>,
    options: AbortOptions = {}
  ): Promise<ToolOutput> {
    this.started = true
    return await abortable(new Promise<ToolOutput>(() => {}), options.signal)
  }
}

@defineToolMetadata({
  name: 'structured_tool',
  description: 'A structured output test tool.',
})
class StructuredTool extends Tool<
  Record<string, unknown>,
  { result: Record<string, unknown>; displayText: string }
> {
  public async call(): Promise<{
    result: Record<string, unknown>
    displayText: string
  }> {
    return {
      result: { content: 'FULL MODEL CONTENT' },
      displayText: 'Short display content.',
    }
  }
}

let oversizedOutcomeToolCalls = 0

@defineToolMetadata({
  name: 'oversized_outcome_tool',
  description: 'Returns a large result with a selected outcome.',
})
class OversizedOutcomeTool extends Tool<{ outcome: ToolOutcome }, ToolOutput> {
  public async call(input: { outcome: ToolOutcome }): Promise<ToolOutput> {
    oversizedOutcomeToolCalls += 1
    return {
      outcome: input.outcome,
      result: { content: `${input.outcome}:${'x'.repeat(1_000)}` },
      displayText: `large ${input.outcome} result`,
    }
  }
}

@defineToolMetadata({
  name: 'progress_tool',
  description: 'A progress forwarding test tool.',
})
class ProgressTool extends Tool<Record<string, unknown>, ToolOutput> {
  public async call(
    _input: Record<string, unknown>,
    options: ToolExecutionOptions = {}
  ): Promise<ToolOutput> {
    options.onProgress?.({ type: 'start', startedAt: 100 })
    options.onProgress?.({
      type: 'output',
      stream: 'stdout',
      text: 'progress line\n',
    })
    options.onProgress?.({
      type: 'output',
      stream: 'stderr',
      text: 'warning line\n',
    })
    return { result: { content: 'done' }, displayText: 'done' }
  }
}

@defineToolMetadata({
  name: 'freeform_tool',
  inputFormat: 'freeform',
  description: 'A freeform test tool.',
})
class FreeformTool extends Tool<string, ToolOutput> {
  public async call(input: string): Promise<ToolOutput> {
    const content = `received:${input}`
    return { result: { content }, displayText: content }
  }
}

let instructionRunCommandCalls = 0

@defineToolMetadata({
  name: 'run_command',
  description: 'A project-instruction preflight test tool.',
})
class InstructionRunCommandTool extends Tool<
  Record<string, unknown>,
  ToolOutput
> {
  public async call(): Promise<ToolOutput> {
    instructionRunCommandCalls += 1
    return {
      result: { content: 'command completed' },
      displayText: 'command completed',
    }
  }
}

let hookTargetInputs: Array<Record<string, unknown> | string> = []

@defineToolMetadata({
  name: 'hook_target',
  description: 'A Hook integration test tool.',
})
class HookTargetTool extends Tool<Record<string, unknown>, ToolOutput> {
  public async call(input: Record<string, unknown>): Promise<ToolOutput> {
    hookTargetInputs.push(input)
    return {
      result: { content: 'hook target completed' },
      displayText: 'hook target completed',
    }
  }
}

function createHookScope(handler: Record<string, unknown>): HookExecutionScope {
  return {
    snapshot: createHookSnapshot(
      parseHooksConfig({ enabled: true, handlers: [handler] })
    ),
    cwd: process.cwd(),
    source: 'tui',
    spawnDepth: 0,
    hookDepth: 0,
    provider: 'chatgpt',
    threadId: 'thread-hook-test',
    turnId: 'turn-hook-test',
  }
}

test('RuntimeCore blocks a tool through tool.before and feeds HOOK_BLOCKED back', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"hook_target","params":{"value":"original"}}</tool>',
    'Handled the blocked result.',
  ])
  const dispatcher = new HookDispatcher({
    execute: async () =>
      JSON.stringify({ action: 'deny', reason: 'policy denied' }),
  })
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [HookTargetTool]),
    null,
    null,
    null,
    null,
    null,
    null,
    [],
    dispatcher
  )
  const scope = createHookScope({
    name: 'deny-tool',
    type: 'prompt',
    events: ['tool.before'],
    prompt: 'Review the tool.',
  })
  hookTargetInputs = []
  const metadata: unknown[] = []

  await runtime.submitUserInput('Run it.', {
    executionScope: scope,
    onToolResult: async (result, _call, details) => {
      metadata.push({ result, details })
    },
  })

  assert.deepEqual(hookTargetInputs, [])
  const firstMetadata = metadata[0]
  assert.ok(isRecord(firstMetadata))
  assert.ok(isRecord(firstMetadata.result))
  assert.ok(isRecord(firstMetadata.result.result))
  assert.equal(firstMetadata.result.result.code, 'HOOK_BLOCKED')
  assert.match(adapter.attachedTexts[1] ?? '', /"code": "HOOK_BLOCKED"/)
})

test('RuntimeCore executes revalidated rewritten params and records both inputs', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"hook_target","params":{"value":"original"}}</tool>',
    'Rewrite complete.',
  ])
  const dispatcher = new HookDispatcher({
    execute: async () =>
      JSON.stringify({ action: 'rewrite', params: { value: 'rewritten' } }),
  })
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [HookTargetTool]),
    null,
    null,
    null,
    null,
    null,
    null,
    [],
    dispatcher
  )
  const scope = createHookScope({
    name: 'rewrite-tool',
    type: 'prompt',
    events: ['tool.before'],
    prompt: 'Review the tool.',
  })
  hookTargetInputs = []
  let details:
    | import('../../src/runtime/runtime-core.ts').ToolCallMetadata
    | undefined

  await runtime.submitUserInput('Run it.', {
    executionScope: scope,
    onToolResult: async (_result, _call, value) => {
      details = value
    },
  })

  assert.deepEqual(hookTargetInputs, [{ value: 'rewritten' }])
  assert.deepEqual(details?.originalInput, { value: 'original' })
  assert.deepEqual(details?.effectiveInput, { value: 'rewritten' })
  assert.deepEqual(details?.rewrittenBy, ['rewrite-tool'])
  assert.equal(typeof details?.toolCallId, 'string')
})

test('RuntimeCore keeps assistant text around an inline tool call', async () => {
  const adapter = new FakeAdapter([
    [
      'I will inspect the workspace first.',
      '<tool>{"tool":"run_command","params":{"command":"pwd"}}</tool>',
      'Then I will summarize the result.',
    ].join('\n\n'),
    'Inspection complete.',
  ])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))
  const events: string[] = []

  const assistant = await runtime.submitUserInput('Inspect the repo.', {
    onAssistantText: async (message) => {
      events.push(`assistant:${message}`)
    },
    onToolCall: async (_toolCall, rawPayload) => {
      events.push(`tool_call:${rawPayload}`)
    },
    onToolResult: async (toolResult) => {
      events.push(`tool_result:${JSON.stringify(toolResult)}`)
    },
  })

  assert.equal(assistant, 'Inspection complete.')
  assert.deepEqual(events, [
    'assistant:I will inspect the workspace first.',
    'tool_call:{"tool":"run_command","params":{"command":"pwd"}}',
    'assistant:Then I will summarize the result.',
    'tool_result:{"outcome":"error","result":{"message":"Tool not found: run_command"},"displayText":"Tool not found: run_command"}',
    'assistant:Inspection complete.',
  ])
  assert.equal(adapter.attachedTexts[0], 'Inspect the repo.')
  assert.match(adapter.attachedTexts[1] ?? '', /^### Tool Result ###\n/)
})

test('RuntimeCore executes named freeform tool payloads without JSON parsing', async () => {
  const adapter = new FakeAdapter([
    '<tool name="freeform_tool">\nraw payload\n</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [FreeformTool])
  )

  const assistant = await runtime.submitUserInput('Use the freeform tool.')

  assert.match(adapter.attachedTexts[1] ?? '', /received:\\nraw payload\\n/)
  assert.equal(assistant, 'Done.')
})

test('RuntimeCore loads an explicitly selected skill before submitting the task', async () => {
  const adapter = new FakeAdapter(['Done.'])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, []),
    null,
    null,
    null,
    null,
    async (name) =>
      name === 'manual-skill'
        ? {
            name,
            content: '# Manual instructions\n\nUse the test workflow.',
          }
        : null
  )
  const loaded: string[] = []

  await runtime.submitUserInput('$manual-skill Inspect this.', {
    onManualSkill: async (name) => {
      loaded.push(name)
    },
  })

  assert.deepEqual(loaded, ['manual-skill'])
  assert.match(
    adapter.attachedTexts[0] ?? '',
    /^# Portal Manual Skill Context\nThe user explicitly selected the skill "manual-skill" for this turn\./
  )
  assert.match(
    adapter.attachedTexts[0] ?? '',
    /## Skill Instructions\n\n# Manual instructions\n\nUse the test workflow\./
  )
  assert.match(
    adapter.attachedTexts[0] ?? '',
    /## User Task\n\nInspect this\.$/
  )
  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /\$manual-skill/)
})

test('RuntimeCore keeps an explicitly selected skill task section empty when no task is provided', async () => {
  const adapter = new FakeAdapter(['Tell me what you need.'])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, []),
    null,
    null,
    null,
    null,
    async (name) =>
      name === 'manual-skill'
        ? { name, content: 'Follow the manual workflow.' }
        : null
  )

  await runtime.submitUserInput('$manual-skill')

  assert.match(adapter.attachedTexts[0] ?? '', /## User Task\n\n$/)
})

test('RuntimeCore leaves unknown manual skill prefixes as ordinary user input', async () => {
  const adapter = new FakeAdapter(['Done.'])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, []),
    null,
    null,
    null,
    null,
    async () => null
  )
  const loaded: string[] = []

  await runtime.submitUserInput('$unknown-skill Continue normally.', {
    onManualSkill: async (name) => {
      loaded.push(name)
    },
  })

  assert.deepEqual(loaded, [])
  assert.equal(adapter.attachedTexts[0], '$unknown-skill Continue normally.')
})

test('RuntimeCore forwards transient tool progress without changing tool results', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"progress_tool","params":{}}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [ProgressTool])
  )
  const progress: string[] = []
  const toolCallIds: string[] = []

  await runtime.submitUserInput('Run the progress tool.', {
    onToolProgress: (event, toolCall, toolCallId) => {
      progress.push(`${event.type}:${toolCall?.tool ?? 'none'}`)
      toolCallIds.push(toolCallId)
    },
  })

  assert.deepEqual(progress, [
    'start:progress_tool',
    'output:progress_tool',
    'output:progress_tool',
  ])
  assert.equal(new Set(toolCallIds).size, 1)
  assert.ok(toolCallIds[0])
  assert.equal(
    adapter.attachedTexts[1],
    [
      '### Tool Result ###',
      '{',
      '  "tool": "progress_tool",',
      '  "outcome": "success",',
      '  "result": {',
      '    "content": "done"',
      '  }',
      '}',
    ].join('\n')
  )
})

test('RuntimeCore forwards assistant stream snapshots before the final assistant message', async () => {
  const adapter = new FakeAdapter(['Streaming complete.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))
  const streamSnapshots: string[] = []
  const finalMessages: string[] = []

  const assistant = await runtime.submitUserInput('Say something.', {
    onAssistantStream: async (message) => {
      streamSnapshots.push(message)
    },
    onAssistantText: async (message) => {
      finalMessages.push(message)
    },
  })

  assert.equal(assistant, 'Streaming complete.')
  assert.ok(streamSnapshots.length >= 2)
  assert.equal(streamSnapshots.at(-1), 'Streaming complete.')
  assert.deepEqual(finalMessages, ['Streaming complete.'])
})

test('RuntimeCore propagates submit aborts to the adapter watchdog signal', async () => {
  const adapter = new FakeAdapter(['Done.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))
  const controller = new AbortController()

  await runtime.submitUserInput('Say done.', {
    signal: controller.signal,
  })

  const submitSignal = adapter.submitSignals[0]
  assert.equal(submitSignal?.aborted, false)
  controller.abort(new PortalAbortError('cancel after submit'))
  assert.equal(submitSignal?.aborted, true)
})

test('RuntimeCore does not replay a submit after the response outcome becomes unknown', async () => {
  const adapter = new TimeoutThenSuccessAdapter()
  const runtime = createRuntimeForRetryTests(adapter)

  await assert.rejects(
    runtime.submitUserInput('Do not duplicate this.'),
    ProviderResponseTimeoutError
  )

  assert.equal(adapter.submitSignals.length, 1)
  assert.equal(adapter.stopCalls, 1)
  assert.deepEqual(adapter.retryPreparedTexts, [])
})

test('RuntimeCore honors an explicitly retryable provider error within its attempt limit', async () => {
  const adapter = new RateLimitThenSuccessAdapter()
  const runtime = createRuntimeForRetryTests(adapter)

  assert.equal(await runtime.submitUserInput('Try later.'), 'Done.')
  assert.deepEqual(adapter.retryPreparedTexts, [])
  assert.deepEqual(adapter.attachedTexts, ['Try later.', 'Try later.'])
})

test('RuntimeCore resets API stream state after a partial failed attempt', async () => {
  const adapter = new RateLimitThenSuccessAdapter(1, true)
  const runtime = createRuntimeForRetryTests(adapter)
  const streams: string[] = []
  let resets = 0

  assert.equal(
    await runtime.submitUserInput('Stream twice.', {
      onAssistantStream: async (message) => {
        streams.push(message)
      },
      onAssistantStreamReset: async () => {
        resets += 1
      },
    }),
    'Done.'
  )
  assert.equal(resets, 1)
  assert.ok(streams.includes('partial response'))
  assert.equal(streams.at(-1), 'Done.')
})

test('RuntimeCore re-sends a completed tool result without executing the tool twice', async () => {
  retryCountingToolCalls = 0
  const adapter = new RateLimitOnSecondSubmitAdapter([
    '<tool>{"tool":"retry_counting_tool","params":{}}</tool>',
    'Finished after retry.',
  ])
  const runtime = createRuntimeForRetryTests(adapter, [RetryCountingTool])

  assert.equal(
    await runtime.submitUserInput('Use the tool.'),
    'Finished after retry.'
  )
  assert.equal(retryCountingToolCalls, 1)
  assert.equal(adapter.retryPreparedTexts.length, 0)
  assert.match(adapter.attachedTexts[1] ?? '', /^### Tool Result ###/)
  assert.equal(adapter.attachedTexts[1], adapter.attachedTexts[2])
})

test('RuntimeCore cancels an adapter restore during retry recovery', async () => {
  const adapter = new RetryRestoreAdapter(['Done.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))
  const controller = new AbortController()
  const submission = runtime.submitUserInput('Say done.', {
    signal: controller.signal,
  })

  const waitDeadline = Date.now() + 200
  while (!adapter.restoreStarted && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(adapter.restoreStarted, true)

  controller.abort(new PortalAbortError('cancel retry recovery'))

  let timeout: NodeJS.Timeout | undefined
  try {
    await assert.rejects(
      Promise.race([
        submission,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('retry recovery ignored abort')),
            200
          )
        }),
      ]),
      PortalAbortError
    )
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }

  assert.equal(adapter.restoreSignal, controller.signal)
})

test('RuntimeCore inserts provider prompt before setup handshake', () => {
  const adapter = new FakeAdapter(['READY'])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, []),
    '# Provider Boundary\n- Provider-specific rule.'
  )

  assert.match(
    runtime.prompt,
    /# Runtime Context\n- Current working directory:/
  )
  assert.ok(
    runtime.prompt.indexOf('# Provider Boundary') >
      runtime.prompt.indexOf('# Runtime Context')
  )
  assert.ok(
    runtime.prompt.indexOf('# Provider Boundary') <
      runtime.prompt.indexOf('# Setup Handshake')
  )
})

test('RuntimeCore inserts project instructions after runtime context', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-instructions-')
  )
  try {
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, 'AGENTS.md'), 'Project rule.', 'utf8')
    const { instructions } = await loadProjectInstructions({
      cwd: root,
      config: {
        claude: { global: false, local: true },
        codex: { global: false, local: true },
      },
    })
    const adapter = new FakeAdapter(['READY'])
    const runtime = new RuntimeCore(
      adapter,
      new ToolRegistry(adapter, []),
      '# Provider Boundary\n- Provider-specific rule.',
      null,
      null,
      null,
      null,
      instructions
    )

    assert.match(runtime.prompt, /# Project Instructions/)
    assert.match(runtime.prompt, /Project rule\./)
    assert.ok(
      runtime.prompt.indexOf('# Runtime Context') <
        runtime.prompt.indexOf('# Project Instructions')
    )
    assert.ok(
      runtime.prompt.indexOf('# Project Instructions') <
        runtime.prompt.indexOf('# Provider Boundary')
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('RuntimeCore activates scoped instructions before executing a tool', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-instructions-')
  )
  const sourceDirectory = path.join(root, 'src')
  try {
    await mkdir(path.join(root, '.git'))
    await mkdir(sourceDirectory)
    await writeFile(
      path.join(sourceDirectory, 'AGENTS.md'),
      'Scoped source rule.',
      'utf8'
    )
    const { instructions } = await loadProjectInstructions({
      cwd: root,
      config: {
        claude: { global: false, local: false },
        codex: { global: false, local: true },
      },
    })
    const toolCall = `<tool>${JSON.stringify({
      tool: 'run_command',
      params: { command: 'test', cwd: sourceDirectory },
    })}</tool>`
    const adapter = new FakeAdapter([toolCall, toolCall, 'Done.'])
    instructionRunCommandCalls = 0
    const runtime = new RuntimeCore(
      adapter,
      new ToolRegistry(adapter, [InstructionRunCommandTool]),
      null,
      null,
      null,
      null,
      null,
      instructions
    )
    let emittedToolCalls = 0

    const result = await runtime.submitUserInput('Run the command.', {
      onToolCall: async () => {
        emittedToolCalls += 1
      },
    })

    assert.equal(result, 'Done.')
    assert.equal(instructionRunCommandCalls, 1)
    assert.equal(emittedToolCalls, 1)
    assert.match(
      adapter.attachedTexts[1] ?? '',
      /^# Project Instructions Update/
    )
    assert.match(adapter.attachedTexts[1] ?? '', /Scoped source rule\./)
    assert.match(adapter.attachedTexts[2] ?? '', /^### Tool Result ###/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('RuntimeCore normalizes optional prompt section boundaries', () => {
  const adapter = new FakeAdapter(['READY'])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, []),
    '\n# Provider Boundary\n- Provider-specific rule.\n\n',
    '\n\n# Skills\n- Skill catalog.\n',
    '\n# MCP Servers\n- Server catalog.\n\n'
  )

  assert.equal(runtime.prompt, runtime.prompt.trim())
  assert.doesNotMatch(runtime.prompt, /\n{4,}/)
  assert.match(
    runtime.prompt,
    /# Skills\n- Skill catalog\.\n\n\n# MCP Servers\n- Server catalog\.\n\n\n# Runtime Context/
  )
})

test('RuntimeCore exposes Tools directly and ends with the READY handshake', () => {
  const adapter = new FakeAdapter(['READY'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))

  assert.equal(runtime.prompt, runtime.prompt.trim())
  assert.doesNotMatch(runtime.prompt, /\n{4,}/)
  assert.match(runtime.prompt, /# Tools/)
  assert.ok(
    runtime.prompt.indexOf('# Tools') <
      runtime.prompt.indexOf('# Runtime Context')
  )
  assert.match(
    runtime.prompt,
    /# Setup Handshake\n- This message initializes the runtime only\.\n- Reply with READY when initialization is complete\.$/
  )
})

test('RuntimeCore accepts a case-insensitive READY token with extra text', async () => {
  const adapter = new FakeAdapter(['rEaDy - setup complete'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))

  await runtime.init()
})

test('RuntimeCore handshake mode sends only the shared handshake prompt', async () => {
  const adapter = new FakeAdapter(['Ready, initialized.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))

  await runtime.init({ setupMode: 'handshake' })

  assert.equal(adapter.attachedTexts[0], SETUP_HANDSHAKE_PROMPT)
})

test('RuntimeCore rejects a setup handshake without a READY token', async () => {
  const adapter = new FakeAdapter(['Initialization complete.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))

  await assert.rejects(runtime.init(), /response did not contain READY\./)
})

test('RuntimeCore cancels while waiting for a tool result without feeding it back', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"slow_tool","params":{}}</tool>',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [SlowTool])
  )
  const controller = new AbortController()
  const toolResults: unknown[] = []

  const result = runtime.submitUserInput('Run slow tool.', {
    signal: controller.signal,
    onToolCall: async () => {
      controller.abort(new PortalAbortError('cancel tool wait'))
    },
    onToolResult: async (toolResult) => {
      toolResults.push(toolResult)
    },
  })

  await assert.rejects(result, PortalAbortError)
  assert.deepEqual(toolResults, [])
  assert.equal(adapter.attachedTexts.length, 1)
})

test('RuntimeCore rejects tool calls without params before invoking the tool', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"slow_tool"}</tool>',
    'Recovered after invalid tool call.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [SlowTool])
  )
  const toolResults: unknown[] = []

  const assistant = await runtime.submitUserInput('Run invalid tool.', {
    onToolResult: async (toolResult) => {
      toolResults.push(toolResult)
    },
  })

  assert.equal(assistant, 'Recovered after invalid tool call.')
  assert.deepEqual(toolResults, [
    {
      outcome: 'error',
      result: {
        message:
          'Invalid tool call JSON: Tool call payload must include an object "params"',
      },
      displayText:
        'Invalid tool call JSON: Tool call payload must include an object "params"',
    },
  ])
  const resultMessage = adapter.attachedTexts[1] ?? ''
  assert.match(resultMessage, /^### Tool Result ###\n\{/)
  assert.deepEqual(
    JSON.parse(resultMessage.slice('### Tool Result ###\n'.length)),
    {
      tool: 'unknown',
      outcome: 'error',
      result: {
        message:
          'Invalid tool call JSON: Tool call payload must include an object "params"',
      },
    }
  )
})

test('RuntimeCore sends full structured tool content to the model and forwards display text', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"structured_tool","params":{}}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [StructuredTool])
  )
  const results: Array<{
    outcome: string
    result: Record<string, unknown>
    displayText?: string
  }> = []

  await runtime.submitUserInput('Run the structured tool.', {
    onToolResult: async (toolResult) => {
      results.push({
        outcome: toolResult.outcome,
        result: toolResult.result,
        ...(toolResult.displayText !== undefined
          ? { displayText: toolResult.displayText }
          : {}),
      })
    },
  })

  assert.deepEqual(results, [
    {
      outcome: 'success',
      result: { content: 'FULL MODEL CONTENT' },
      displayText: 'Short display content.',
    },
  ])
  assert.equal(
    adapter.attachedTexts[1],
    [
      '### Tool Result ###',
      '{',
      '  "tool": "structured_tool",',
      '  "outcome": "success",',
      '  "result": {',
      '    "content": "FULL MODEL CONTENT"',
      '  }',
      '}',
    ].join('\n')
  )
})

test('RuntimeCore preserves every original tool outcome when a large result is not delivered', async () => {
  const limit = {
    kind: 'known',
    provider: 'deepseek',
    limit: 600,
    unit: 'utf16_code_units',
    source: 'verified_fallback',
    confidence: 'safe_cap',
  } as const

  for (const outcome of ['success', 'error', 'unknown'] as const) {
    const adapter = new LimitedFakeAdapter(
      [
        `<tool>{"tool":"oversized_outcome_tool","params":{"outcome":"${outcome}"}}</tool>`,
        'Handled the missing result.',
      ],
      limit
    )
    const runtime = new RuntimeCore(
      adapter,
      new ToolRegistry(adapter, [OversizedOutcomeTool])
    )
    const localResults: Array<Record<string, unknown>> = []

    await runtime.submitUserInput('x', {
      onToolResult: async (toolResult) => {
        localResults.push(toolResult.result)
      },
    })

    assert.deepEqual(localResults, [
      { content: `${outcome}:${'x'.repeat(1_000)}` },
    ])
    const outbound: unknown = JSON.parse(
      adapter.attachedTexts[1]!.slice('### Tool Result ###\n'.length)
    )
    assert.ok(isRecord(outbound))
    assert.equal(outbound.tool, 'oversized_outcome_tool')
    assert.equal(outbound.outcome, outcome)
    assert.equal(outbound.result, null)
    assert.ok(isRecord(outbound.delivery))
    assert.equal(outbound.delivery.status, 'not_delivered')
    assert.equal(outbound.delivery.code, 'COMPOSER_LIMIT_EXCEEDED')
    assert.equal(outbound.delivery.limit, 600)
    assert.equal(outbound.delivery.unit, 'utf16_code_units')
    assert.equal(outbound.delivery.source, 'verified_fallback')
    assert.equal(outbound.delivery.confidence, 'safe_cap')
    assert.equal(typeof outbound.delivery.measured, 'number')
    assert.ok(Number(outbound.delivery.measured) > limit.limit)
    assert.doesNotMatch(
      adapter.attachedTexts[1]!,
      /success:x{10}|error:x{10}|unknown:x{10}/
    )
  }
})

test('RuntimeCore does not attach an over-limit delivery replacement', async () => {
  const adapter = new LimitedFakeAdapter(
    [
      '<tool>{"tool":"oversized_outcome_tool","params":{"outcome":"success"}}</tool>',
    ],
    {
      kind: 'known',
      provider: 'deepseek',
      limit: 100,
      unit: 'utf16_code_units',
      source: 'verified_fallback',
      confidence: 'safe_cap',
    }
  )
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [OversizedOutcomeTool])
  )

  await assert.rejects(runtime.submitUserInput('x'), ComposerLimitExceededError)
  assert.deepEqual(adapter.attachedTexts, ['x'])
  assert.equal(adapter.submitSignals.length, 1)
})

test('RuntimeCore keeps an over-limit delivery stable across submit recovery without rerunning the tool', async () => {
  const adapter = new RetryToolResultAdapter(
    [
      '<tool>{"tool":"oversized_outcome_tool","params":{"outcome":"unknown"}}</tool>',
      'Handled after recovery.',
    ],
    {
      kind: 'known',
      provider: 'deepseek',
      limit: 600,
      unit: 'utf16_code_units',
      source: 'verified_fallback',
      confidence: 'safe_cap',
    }
  )
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [OversizedOutcomeTool])
  )
  oversizedOutcomeToolCalls = 0
  let localResultCalls = 0

  await runtime.submitUserInput('x', {
    onToolResult: async () => {
      localResultCalls += 1
    },
  })

  assert.equal(oversizedOutcomeToolCalls, 1)
  assert.equal(localResultCalls, 1)
  assert.equal(adapter.restoreCalls, 1)
  assert.equal(adapter.submitSignals.length, 3)
  assert.equal(adapter.attachedTexts.length, 3)
  assert.equal(adapter.attachedTexts[1], adapter.attachedTexts[2])
  const replacement: unknown = JSON.parse(
    adapter.attachedTexts[2]!.slice('### Tool Result ###\n'.length)
  )
  assert.ok(isRecord(replacement))
  assert.equal(replacement.outcome, 'unknown')
  assert.equal(replacement.result, null)
  assert.ok(isRecord(replacement.delivery))
  assert.equal(replacement.delivery.status, 'not_delivered')
})

test('RuntimeCore reuses one over-limit delivery across a bounded retry without repeating local effects', async () => {
  const adapter = new RetryableToolResultAdapter(
    [
      '<tool>{"tool":"oversized_outcome_tool","params":{"outcome":"success"}}</tool>',
      'Handled after bounded retry.',
    ],
    {
      kind: 'known',
      provider: 'deepseek',
      limit: 600,
      unit: 'utf16_code_units',
      source: 'verified_fallback',
      confidence: 'safe_cap',
    }
  )
  const hookPayloads: Array<Record<string, unknown>> = []
  const dispatcher = new HookDispatcher({
    execute: async (_handler, event) => {
      hookPayloads.push(event.payload)
      return '{}'
    },
  })
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [OversizedOutcomeTool]),
    null,
    null,
    null,
    null,
    null,
    null,
    [],
    dispatcher,
    3
  )
  const scope = createHookScope({
    name: 'record-result',
    type: 'prompt',
    events: ['tool.after'],
    prompt: 'Record the result.',
  })
  const localResults: Array<Record<string, unknown>> = []
  let streamResets = 0
  oversizedOutcomeToolCalls = 0

  assert.equal(
    await runtime.submitUserInput('x', {
      executionScope: scope,
      onToolResult: async (toolResult) => {
        localResults.push(toolResult.result)
      },
      onAssistantStreamReset: async () => {
        streamResets += 1
      },
    }),
    'Handled after bounded retry.'
  )

  assert.equal(oversizedOutcomeToolCalls, 1)
  assert.equal(localResults.length, 1)
  assert.match(String(localResults[0]?.content), /^success:x{1000}$/)
  assert.equal(hookPayloads.length, 1)
  const hookResult = hookPayloads[0]?.result
  assert.ok(isRecord(hookResult))
  assert.match(String(hookResult.content), /^success:x{1000}$/)
  assert.equal(streamResets, 1)
  assert.equal(adapter.retryPreparedTexts.length, 0)
  assert.equal(adapter.attachedTexts[1], adapter.attachedTexts[2])
})
