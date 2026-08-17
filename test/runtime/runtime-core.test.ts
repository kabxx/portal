import test from 'node:test'
import assert from 'node:assert/strict'

import { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import {
  ProviderAdapter,
  ProviderAdapterError,
  ProviderResponseTimeoutError,
  type AbortOptions,
  type ProviderTimingOptions,
} from '../../src/providers/adapters/adapter-base.ts'
import { PORTAL_ACTION_PROTOCOL } from '../../src/providers/portal-action-protocol.ts'
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
import { createBrowserContextStub } from '../helpers/fakes.ts'
import { SETUP_HANDSHAKE_PROMPT } from '../../src/runtime/setup-handshake.ts'
import { createTestToolRegistry } from '../helpers/tool-host.ts'

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
  return new RuntimeCore(adapter, createTestToolRegistry(adapter, tools), {
    requestAttemptLimit: 3,
  })
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

test('RuntimeCore executes a terminal tool call after leading assistant text', async () => {
  const adapter = new FakeAdapter([
    [
      'I will inspect the workspace first.',
      '<tool name="run_command">{"command":"pwd"}</tool>',
    ].join('\n\n'),
    'Inspection complete.',
  ])
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))
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
    'tool_call:{"command":"pwd"}',
    'tool_result:{"outcome":"error","result":{"message":"Tool not found: run_command"},"displayText":"Tool not found: run_command"}',
    'assistant:Inspection complete.',
  ])
  assert.equal(adapter.attachedTexts[0], 'Inspect the repo.')
  assert.match(adapter.attachedTexts[1] ?? '', /^### Tool Result ###\n/)
})

test('RuntimeCore maps a web Action call to an internal ToolResult and returns Action Result text', async () => {
  const adapter = new FakeAdapter([
    '<action name="missing_tool">{"value":"input"}</action>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [], { protocol: PORTAL_ACTION_PROTOCOL })
  )

  assert.equal(await runtime.submitUserInput('Run the action.'), 'Done.')
  assert.match(adapter.attachedTexts[1] ?? '', /^### Action Result ###\n/)
  assert.match(adapter.attachedTexts[1] ?? '', /"action": "missing_tool"/)
})

test('RuntimeCore treats a non-terminal tool block as ordinary assistant text', async () => {
  const response = [
    'I will inspect the workspace first.',
    '<tool name="run_command">{"command":"pwd"}</tool>',
    'Then I will summarize the result.',
  ].join('\n\n')
  const adapter = new FakeAdapter([response])
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))
  const assistantMessages: string[] = []
  let toolCalls = 0

  const assistant = await runtime.submitUserInput('Inspect the repo.', {
    onAssistantText: async (message) => {
      assistantMessages.push(message)
    },
    onToolCall: async () => {
      toolCalls += 1
    },
  })

  assert.equal(assistant, response)
  assert.deepEqual(assistantMessages, [response])
  assert.equal(toolCalls, 0)
  assert.deepEqual(adapter.attachedTexts, ['Inspect the repo.'])
})

test('RuntimeCore executes named freeform tool payloads without JSON parsing', async () => {
  const adapter = new FakeAdapter([
    '<tool name="freeform_tool">\nraw payload\n</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [FreeformTool])
  )

  const assistant = await runtime.submitUserInput('Use the freeform tool.')

  assert.match(adapter.attachedTexts[1] ?? '', /received:\\nraw payload\\n/)
  assert.equal(assistant, 'Done.')
})

test('RuntimeCore executes named JSON tool payloads as direct params', async () => {
  const adapter = new FakeAdapter([
    '<tool name="structured_tool">{"value":"direct"}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [StructuredTool])
  )
  let observedToolCall: unknown = null

  const assistant = await runtime.submitUserInput('Use the JSON tool.', {
    onToolCall: async (toolCall) => {
      observedToolCall = toolCall
    },
  })

  assert.deepEqual(observedToolCall, {
    tool: 'structured_tool',
    params: { value: 'direct' },
  })
  assert.match(adapter.attachedTexts[1] ?? '', /FULL MODEL CONTENT/)
  assert.equal(assistant, 'Done.')
})

test('RuntimeCore forwards transient tool progress without changing tool results', async () => {
  const adapter = new FakeAdapter([
    '<tool name="progress_tool">{}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [ProgressTool])
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
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))
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
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))
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
    '<tool name="retry_counting_tool">{}</tool>',
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
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))
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

test('RuntimeCore renders the unified setup structure', () => {
  const adapter = new FakeAdapter(['READY'])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [StructuredTool]),
    {
      skills: [
        {
          name: 'review',
          description: 'Review changes.',
          manifestPath: 'C:\\skills\\review\\SKILL.md',
        },
      ],
      projectInstructions: 'Project rule.',
      workingDirectory: 'C:\\workspace',
    }
  )

  assert.equal(runtime.prompt, runtime.prompt.trim())
  assert.doesNotMatch(runtime.prompt, /\n{4,}/)
  assert.match(runtime.prompt, /^# Portal Agent/)
  assert.match(runtime.prompt, /## Tool Protocol/)
  assert.match(runtime.prompt, /## Tools/)
  assert.match(runtime.prompt, /## Skills/)
  assert.match(runtime.prompt, /## Project Instructions/)
  assert.ok(
    runtime.prompt.indexOf('## Project Instructions') <
      runtime.prompt.indexOf('## Runtime')
  )
  assert.equal(
    runtime.prompt.slice(runtime.prompt.indexOf('## Runtime')),
    `## Runtime\nWorking directory: ${JSON.stringify('C:\\workspace')}\n\n## Initialization\nReply exactly: READY`
  )
  assert.doesNotMatch(runtime.prompt, /Provider Constraints|Objective|Example/)
})

test('RuntimeCore accepts a case-insensitive READY token with extra text', async () => {
  const adapter = new FakeAdapter(['rEaDy - setup complete'])
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))

  await runtime.init()
})

test('RuntimeCore handshake mode sends only the shared handshake prompt', async () => {
  const adapter = new FakeAdapter(['Ready, initialized.'])
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))

  await runtime.init({ setupMode: 'handshake' })

  assert.equal(adapter.attachedTexts[0], SETUP_HANDSHAKE_PROMPT)
})

test('RuntimeCore rejects a setup handshake without a READY token', async () => {
  const adapter = new FakeAdapter(['Initialization complete.'])
  const runtime = new RuntimeCore(adapter, createTestToolRegistry(adapter, []))

  await assert.rejects(runtime.init(), /response did not contain READY\./)
})

test('RuntimeCore cancels while waiting for a tool result without feeding it back', async () => {
  const adapter = new FakeAdapter(['<tool name="slow_tool">{}</tool>'])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [SlowTool])
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

test('RuntimeCore rejects named JSON tool calls with a non-object payload', async () => {
  const adapter = new FakeAdapter([
    '<tool name="slow_tool">[]</tool>',
    'Recovered after invalid tool call.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [SlowTool])
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
          'Invalid tool call JSON: Tool slow_tool payload must be a JSON object',
      },
      displayText:
        'Invalid tool call JSON: Tool slow_tool payload must be a JSON object',
    },
  ])
  const resultMessage = adapter.attachedTexts[1] ?? ''
  assert.match(resultMessage, /^### Tool Result ###\n\{/)
  assert.deepEqual(
    JSON.parse(resultMessage.slice('### Tool Result ###\n'.length)),
    {
      tool: 'slow_tool',
      outcome: 'error',
      result: {
        message:
          'Invalid tool call JSON: Tool slow_tool payload must be a JSON object',
      },
    }
  )
})

test('RuntimeCore sends full structured tool content to the model and forwards display text', async () => {
  const adapter = new FakeAdapter([
    '<tool name="structured_tool">{}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [StructuredTool])
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
        `<tool name="oversized_outcome_tool">{"outcome":"${outcome}"}</tool>`,
        'Handled the missing result.',
      ],
      limit
    )
    const runtime = new RuntimeCore(
      adapter,
      createTestToolRegistry(adapter, [OversizedOutcomeTool])
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
    ['<tool name="oversized_outcome_tool">{"outcome":"success"}</tool>'],
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
    createTestToolRegistry(adapter, [OversizedOutcomeTool])
  )

  await assert.rejects(runtime.submitUserInput('x'), ComposerLimitExceededError)
  assert.deepEqual(adapter.attachedTexts, ['x'])
  assert.equal(adapter.submitSignals.length, 1)
})

test('RuntimeCore keeps an over-limit delivery stable across submit recovery without rerunning the tool', async () => {
  const adapter = new RetryToolResultAdapter(
    [
      '<tool name="oversized_outcome_tool">{"outcome":"unknown"}</tool>',
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
    createTestToolRegistry(adapter, [OversizedOutcomeTool])
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
      '<tool name="oversized_outcome_tool">{"outcome":"success"}</tool>',
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
  const runtime = new RuntimeCore(
    adapter,
    createTestToolRegistry(adapter, [OversizedOutcomeTool]),
    { requestAttemptLimit: 3 }
  )
  const localResults: Array<Record<string, unknown>> = []
  let streamResets = 0
  oversizedOutcomeToolCalls = 0

  assert.equal(
    await runtime.submitUserInput('x', {
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
  assert.equal(streamResets, 1)
  assert.equal(adapter.retryPreparedTexts.length, 0)
  assert.equal(adapter.attachedTexts[1], adapter.attachedTexts[2])
})
