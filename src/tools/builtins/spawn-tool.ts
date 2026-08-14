import {
  createToolError,
  Tool,
  defineToolMetadata,
} from '../core/tool-definition.ts'
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
  description: 'Run a self-contained child task and wait for its result.',
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
        enum: [
          'chatgpt',
          'gemini',
          'deepseek',
          'doubao',
          'grok',
          'glm',
          'qwen',
          'kimi',
        ],
        description:
          'Optional provider for the worker. Defaults to the current provider.',
      },
    },
    required: ['prompt'],
  },
})
class SpawnTool extends Tool<SpawnInput, ToolOutput> {
  public async call(
    input: SpawnInput,
    options: ToolExecutionOptions = {}
  ): Promise<ToolOutput> {
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      return createToolError('spawn requires a non-empty string params.prompt')
    }

    if (this.services.spawnTask === undefined) {
      return createToolError('spawn is not configured in this runtime')
    }

    try {
      options.onProgress?.({ type: 'start', startedAt: Date.now() })
    } catch {
      // Progress is display-only and must not change child task execution.
    }

    const result = await this.services.spawnTask(
      {
        prompt: input.prompt,
        ...(typeof input.provider === 'string'
          ? { provider: input.provider }
          : {}),
      },
      options
    )
    if ('kind' in result) {
      return createToolError(result.message)
    }
    return {
      result: { ...result },
      displayText: [
        'Spawn completed.',
        `provider: ${result.provider}`,
        `conversation: ${result.conversationUrl}`,
      ].join('\n'),
    }
  }
}

export { SpawnTool }
export type { SpawnInput }
