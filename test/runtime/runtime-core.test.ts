import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext } from 'playwright'

import { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import {
  ProviderAdapter,
  ProviderAdapterError,
  type AbortOptions,
} from '../../src/providers/adapters/adapter-base.ts'
import { ToolRegistry } from '../../src/tools/core/tool-registry.ts'
import {
  Tool,
  defineToolMetadata,
} from '../../src/tools/core/tool-definition.ts'
import type { ToolExecutionOptions } from '../../src/tools/core/tool-definition.ts'
import {
  abortable,
  PortalAbortError,
} from '../../src/runtime/runtime-cancellation.ts'
import { loadProjectInstructions } from '../../src/instructions/project-instructions.ts'

class FakeAdapter extends ProviderAdapter {
  public readonly attachedTexts: string[] = []
  public readonly submitSignals: Array<AbortSignal | undefined> = []
  public submitTextReporterMessages: string[] = []

  public constructor(private readonly responses: string[]) {
    super({} as BrowserContext)
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

  public async changeModel(_model: string): Promise<void> {
    return undefined
  }

  public async attachText(text: string): Promise<void> {
    this.attachedTexts.push(text)
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

@defineToolMetadata({
  name: 'slow_tool',
  description: 'A slow test tool.',
})
class SlowTool extends Tool<Record<string, unknown>, string> {
  public started = false

  public async call(
    _input: Record<string, unknown>,
    options: AbortOptions = {}
  ): Promise<string> {
    this.started = true
    return await abortable(new Promise<string>(() => {}), options.signal)
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

@defineToolMetadata({
  name: 'legacy_tool',
  description: 'A legacy string output test tool.',
})
class LegacyTool extends Tool<Record<string, unknown>, string> {
  public async call(): Promise<string> {
    return 'LEGACY STRING RESULT'
  }
}

@defineToolMetadata({
  name: 'progress_tool',
  description: 'A progress forwarding test tool.',
})
class ProgressTool extends Tool<Record<string, unknown>, string> {
  public async call(
    _input: Record<string, unknown>,
    options: ToolExecutionOptions = {}
  ): Promise<string> {
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
    return 'done'
  }
}

@defineToolMetadata({
  name: 'freeform_tool',
  inputFormat: 'freeform',
  description: 'A freeform test tool.',
})
class FreeformTool extends Tool<string, string> {
  public async call(input: string): Promise<string> {
    return `received:${input}`
  }
}

let instructionRunCommandCalls = 0

@defineToolMetadata({
  name: 'run_command',
  description: 'A project-instruction preflight test tool.',
})
class InstructionRunCommandTool extends Tool<Record<string, unknown>, string> {
  public async call(): Promise<string> {
    instructionRunCommandCalls += 1
    return 'command completed'
  }
}

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

  await runtime.submitUserInput('Run the progress tool.', {
    onToolProgress: (event, toolCall) => {
      progress.push(`${event.type}:${toolCall?.tool ?? 'none'}`)
    },
  })

  assert.deepEqual(progress, [
    'start:progress_tool',
    'output:progress_tool',
    'output:progress_tool',
  ])
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

test('RuntimeCore forwards submit abort signal to the adapter', async () => {
  const adapter = new FakeAdapter(['Done.'])
  const runtime = new RuntimeCore(adapter, new ToolRegistry(adapter, []))
  const controller = new AbortController()

  await runtime.submitUserInput('Say done.', {
    signal: controller.signal,
  })

  assert.equal(adapter.submitSignals[0], controller.signal)
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
  assert.doesNotMatch(runtime.prompt, /Runtime Capabilities|Host Tool/)
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

test('RuntimeCore keeps legacy string tool results compatible', async () => {
  const adapter = new FakeAdapter([
    '<tool>{"tool":"legacy_tool","params":{}}</tool>',
    'Done.',
  ])
  const runtime = new RuntimeCore(
    adapter,
    new ToolRegistry(adapter, [LegacyTool])
  )
  const results: Array<{
    outcome: string
    result: Record<string, unknown>
    displayText?: string
  }> = []

  await runtime.submitUserInput('Run the legacy tool.', {
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
      result: { content: 'LEGACY STRING RESULT' },
    },
  ])
  assert.equal(
    adapter.attachedTexts[1],
    [
      '### Tool Result ###',
      '{',
      '  "tool": "legacy_tool",',
      '  "outcome": "success",',
      '  "result": {',
      '    "content": "LEGACY STRING RESULT"',
      '  }',
      '}',
    ].join('\n')
  )
})
