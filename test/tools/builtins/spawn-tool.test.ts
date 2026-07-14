import test from 'node:test'
import assert from 'node:assert/strict'

import { SpawnTool } from '../../../src/tools/builtins/spawn-tool.ts'

test('SpawnTool exposes prompt and optional provider as input', () => {
  const tool = new SpawnTool({} as any)
  const schema = tool.metadata.inputSchema as {
    properties?: Record<string, unknown>
    required?: string[]
  }

  assert.equal(tool.name, 'spawn')
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['prompt', 'provider'])
  assert.deepEqual(schema.required, ['prompt'])
  assert.match(tool.prompt, /Examples:\n\n<tool>\n\{/)
  assert.match(tool.prompt, /\n<\/tool>/)
})

test('SpawnTool delegates prompt to the configured synchronous runner', async () => {
  const calls: Array<{ prompt: string; provider?: string }> = []
  const tool = new SpawnTool({} as any, {
    spawnTask: async (input) => {
      calls.push(input)
      return JSON.stringify({
        output: 'worker result',
      })
    },
  })

  const output = await tool.call({
    provider: 'gemini',
    prompt: 'Summarize the test fixture.',
  })
  if (typeof output === 'string') assert.fail('expected structured output')
  const result = output.result as {
    output: string
  }

  assert.deepEqual(calls, [
    {
      provider: 'gemini',
      prompt: 'Summarize the test fixture.',
    },
  ])
  assert.equal(result.output, 'worker result')
  assert.equal(output.displayText, 'Spawn completed.')
})

test('SpawnTool emits a start progress event before running the child task', async () => {
  const events: string[] = []
  const tool = new SpawnTool({} as any, {
    spawnTask: async () => JSON.stringify({ provider: 'gemini' }),
  })

  await tool.call(
    { prompt: 'inspect the child task' },
    {
      onProgress: (event) => events.push(event.type),
    }
  )

  assert.deepEqual(events, ['start'])
})

test('SpawnTool rejects missing prompt before invoking the runner', async () => {
  const tool = new SpawnTool({} as any, {
    spawnTask: async () => {
      throw new Error('runner should not be called')
    },
  })

  assert.equal(
    await tool.call({ prompt: '' }),
    '[ERROR] spawn requires a non-empty string params.prompt'
  )
})

test('SpawnTool reports when spawn is unavailable', async () => {
  const tool = new SpawnTool({} as any)

  assert.equal(
    await tool.call({ prompt: 'Inspect the repo.' }),
    '[ERROR] spawn is not configured in this runtime'
  )
})
