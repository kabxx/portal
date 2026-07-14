import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type {
  ToolExecutionOptions,
  ToolOutput,
} from '../core/tool-definition.ts'

interface SpawnInput {
  prompt: string
  provider?: string
}

@defineToolMetadata({
  name: 'spawn',
  description: [
    'Delegate a self-contained subtask to a child browser worker and wait synchronously for the final result.',
    '',
    'Use spawn only when a focused side task should be completed independently and its result is needed for the current user task.',
    'Do not use spawn for work you can complete directly, and do not delegate the entire user task.',
    'Pass the task instructions in prompt. Optionally pass provider to choose chatgpt, gemini, deepseek, doubao, grok, or glm; when omitted, the current provider is used.',
    'Do not include cwd, shell commands, process arguments, model names, or lifecycle controls.',
    'The portal runtime creates a child browser conversation, sends the normal setup prompt, waits for READY, submits prompt, and returns the worker output as an observation.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Self-contained instructions for the child browser worker to complete.',
      },
      provider: {
        type: 'string',
        enum: ['chatgpt', 'gemini', 'deepseek', 'doubao', 'grok', 'glm'],
        description:
          'Optional provider for the worker. Defaults to the current provider.',
      },
    },
    required: ['prompt'],
  },
  examples: [
    {
      params: {
        provider: 'gemini',
        prompt:
          'Inspect the provider adapter tests and summarize the selectors that look brittle.',
      },
    },
  ],
})
class SpawnTool extends Tool<SpawnInput, ToolOutput> {
  public async call(
    input: SpawnInput,
    options: ToolExecutionOptions = {}
  ): Promise<ToolOutput> {
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      return '[ERROR] spawn requires a non-empty string params.prompt'
    }

    if (this.services.spawnTask === undefined) {
      return '[ERROR] spawn is not configured in this runtime'
    }

    try {
      options.onProgress?.({ type: 'start', startedAt: Date.now() })
    } catch {
      // Progress is display-only and must not change child task execution.
    }

    const content = await this.services.spawnTask(
      {
        prompt: input.prompt,
        ...(typeof input.provider === 'string'
          ? { provider: input.provider }
          : {}),
      },
      options
    )
    if (content.startsWith('[ERROR]')) {
      return content
    }

    try {
      const parsed = JSON.parse(content) as unknown
      if (!isRecord(parsed)) {
        return {
          result: { output: content },
          displayText: 'Spawn completed.',
        }
      }
      const lines = ['Spawn completed.']
      if (typeof parsed.provider === 'string') {
        lines.push(`provider: ${parsed.provider}`)
      }
      if (typeof parsed.conversationUrl === 'string') {
        lines.push(`conversation: ${parsed.conversationUrl}`)
      }
      return { result: parsed, displayText: lines.join('\n') }
    } catch {
      return {
        result: { output: content },
        displayText: 'Spawn completed.',
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { SpawnTool }
export type { SpawnInput }
