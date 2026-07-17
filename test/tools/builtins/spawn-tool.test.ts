import test from 'node:test'
import assert from 'node:assert/strict'

import { SpawnTool } from '../../../src/tools/builtins/spawn-tool.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`)
  }
  return value
}

test('SpawnTool exposes prompt and optional provider as input', () => {
  const tool = new SpawnTool(createProviderAdapterStub())
  const schema = requireRecord(tool.metadata.inputSchema, 'input schema')
  const properties = requireRecord(schema.properties, 'schema properties')
  const provider = requireRecord(properties.provider, 'provider schema')

  assert.equal(tool.name, 'spawn')
  assert.deepEqual(Object.keys(properties), ['prompt', 'provider'])
  assert.deepEqual(schema.required, ['prompt'])
  assert.deepEqual(provider.enum, [
    'chatgpt',
    'gemini',
    'deepseek',
    'doubao',
    'grok',
    'glm',
    'qwen',
    'kimi',
  ])
  assert.match(tool.prompt, /Examples:\n\n<tool>\n\{/)
  assert.match(tool.prompt, /\n<\/tool>/)
})

test('SpawnTool delegates prompt to the configured synchronous runner', async () => {
  const calls: Array<{ prompt: string; provider?: string }> = []
  const tool = new SpawnTool(createProviderAdapterStub(), {
    spawnTask: async (input) => {
      calls.push(input)
      return {
        provider: 'gemini',
        conversationUrl: 'https://gemini.google.com/app/worker',
        output: 'worker result',
      }
    },
  })

  const output = await tool.call({
    provider: 'gemini',
    prompt: 'Summarize the test fixture.',
  })

  assert.deepEqual(calls, [
    {
      provider: 'gemini',
      prompt: 'Summarize the test fixture.',
    },
  ])
  assert.equal(output.result.output, 'worker result')
  assert.equal(
    output.displayText,
    [
      'Spawn completed.',
      'provider: gemini',
      'conversation: https://gemini.google.com/app/worker',
    ].join('\n')
  )
})

test('SpawnTool emits a start progress event before running the child task', async () => {
  const events: string[] = []
  const tool = new SpawnTool(createProviderAdapterStub(), {
    spawnTask: async () => ({
      provider: 'gemini',
      conversationUrl: 'https://gemini.google.com/app/worker',
      output: 'done',
    }),
  })

  await tool.call(
    { prompt: 'inspect the child task' },
    {
      onProgress: (event) => events.push(event.type),
    }
  )

  assert.deepEqual(events, ['start'])
})

test('SpawnTool ignores progress rendering failures and forwards options', async () => {
  let receivedInput: { prompt: string; provider?: string } | undefined
  let receivedOptions: unknown
  const tool = new SpawnTool(createProviderAdapterStub(), {
    spawnTask: async (input, options) => {
      receivedInput = input
      receivedOptions = options
      return {
        provider: 'chatgpt',
        conversationUrl: 'https://chatgpt.com/c/worker',
        output: 'done',
      }
    },
  })
  const options = {
    onProgress: () => {
      throw new Error('display failed')
    },
  }

  const output = await tool.call({ prompt: 'inspect the child task' }, options)

  assert.deepEqual(receivedInput, { prompt: 'inspect the child task' })
  assert.equal(receivedOptions, options)
  assert.equal(output.result.output, 'done')
})

test('SpawnTool rejects missing prompt before invoking the runner', async () => {
  const tool = new SpawnTool(createProviderAdapterStub(), {
    spawnTask: async () => {
      throw new Error('runner should not be called')
    },
  })

  assert.deepEqual(await tool.call({ prompt: '' }), {
    outcome: 'error',
    result: { message: 'spawn requires a non-empty string params.prompt' },
    displayText: 'spawn requires a non-empty string params.prompt',
  })
  assert.deepEqual(await tool.call({ prompt: '   ' }), {
    outcome: 'error',
    result: { message: 'spawn requires a non-empty string params.prompt' },
    displayText: 'spawn requires a non-empty string params.prompt',
  })
  // @ts-expect-error Deliberately exercises runtime validation of a non-string prompt.
  assert.deepEqual(await tool.call({ prompt: 1 }), {
    outcome: 'error',
    result: { message: 'spawn requires a non-empty string params.prompt' },
    displayText: 'spawn requires a non-empty string params.prompt',
  })
})

test('SpawnTool reports when spawn is unavailable', async () => {
  const tool = new SpawnTool(createProviderAdapterStub())

  assert.deepEqual(await tool.call({ prompt: 'Inspect the repo.' }), {
    outcome: 'error',
    result: { message: 'spawn is not configured in this runtime' },
    displayText: 'spawn is not configured in this runtime',
  })
})

test('SpawnTool maps runner errors to structured tool errors', async () => {
  const tool = new SpawnTool(createProviderAdapterStub(), {
    spawnTask: async () => ({
      kind: 'error',
      message: 'Unsupported spawn provider: legacy',
    }),
  })

  assert.deepEqual(await tool.call({ prompt: 'Inspect the repo.' }), {
    outcome: 'error',
    result: { message: 'Unsupported spawn provider: legacy' },
    displayText: 'Unsupported spawn provider: legacy',
  })
})
