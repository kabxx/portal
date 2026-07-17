import type { ProviderAdapter } from '../../providers/adapters/adapter-base.ts'
import type { RunCommandJobService } from '../../processes/run-command-job-manager.ts'
import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'
import { joinPromptSections } from '../../shared/prompt-sections.ts'
import type { HookExecutionScope } from '../../hooks/hook-types.ts'

const TOOL_METADATA_SYMBOL = Symbol('TOOL_METADATA')

interface ToolMetadataExample {
  tool?: string
  params?: unknown
  input?: string
}

type ToolInputFormat = 'json' | 'freeform'

interface ToolMetadata {
  name: string
  description: string
  inputFormat?: ToolInputFormat
  inputSchema?: unknown
  examples?: ToolMetadataExample[]
}

type ToolOutcome = 'success' | 'error' | 'unknown'

interface ToolOutput {
  result: Record<string, unknown>
  displayText: string
  outcome?: ToolOutcome
}

function createToolError(message: string): ToolOutput & { outcome: 'error' } {
  return {
    outcome: 'error',
    result: { message },
    displayText: message,
  }
}

type ToolProgressEvent =
  | {
      type: 'start'
      startedAt: number
    }
  | {
      type: 'output'
      stream: 'stdout' | 'stderr'
      text: string
    }

interface ToolExecutionOptions extends AbortOptions {
  onProgress?: (event: ToolProgressEvent) => void
  executionScope?: HookExecutionScope
  toolCallId?: string
}

interface ToolServices {
  runCommandJobs?: RunCommandJobService
  spawnTask?: (
    input: { prompt: string; provider?: string },
    options?: ToolExecutionOptions
  ) => Promise<SpawnTaskResult>
  loadSkill?: (name: string) => Promise<ToolOutput>
  mcpSearchTool?: (server: string, tool: string) => Promise<ToolOutput>
  mcpCallTool?: (
    input: {
      server: string
      tool: string
      arguments: Record<string, unknown>
    },
    options?: AbortOptions
  ) => Promise<ToolOutput>
}

type SpawnTaskResult =
  | {
      provider: string
      conversationUrl: string
      output: string
    }
  | {
      kind: 'error'
      message: string
    }

function defineToolMetadata(metadata: ToolMetadata) {
  return function (target: object) {
    Object.defineProperty(target, TOOL_METADATA_SYMBOL, {
      configurable: true,
      enumerable: true,
      value: metadata,
      writable: true,
    })
  }
}

function isToolMetadata(value: unknown): value is ToolMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('description' in value) ||
    typeof value.description !== 'string'
  ) {
    return false
  }
  if (
    'inputFormat' in value &&
    value.inputFormat !== undefined &&
    value.inputFormat !== 'json' &&
    value.inputFormat !== 'freeform'
  ) {
    return false
  }
  return !(
    'examples' in value &&
    value.examples !== undefined &&
    !Array.isArray(value.examples)
  )
}

abstract class Tool<TInput = unknown, TOutput extends ToolOutput = ToolOutput> {
  constructor(
    protected readonly providerAdapter: ProviderAdapter,
    protected readonly services: ToolServices = {}
  ) {}

  abstract call(input: TInput, options?: ToolExecutionOptions): Promise<TOutput>

  public get metadata(): ToolMetadata {
    const metadata: unknown = Reflect.get(
      this.constructor,
      TOOL_METADATA_SYMBOL
    )
    if (!isToolMetadata(metadata)) {
      throw new Error(`Missing @defineToolMetadata on ${this.constructor.name}`)
    }
    return metadata
  }

  public get name(): string {
    return this.metadata.name
  }

  public get inputFormat(): ToolInputFormat {
    return this.metadata.inputFormat ?? 'json'
  }

  public get prompt(): string {
    const { name, description, inputSchema, examples } = this.metadata
    const inputPrompt =
      this.inputFormat === 'freeform'
        ? [
            `Input format:`,
            `Freeform text (do not wrap the payload in JSON).`,
          ].join('\n')
        : [
            `Input schema:`,
            `\`\`\`json`,
            JSON.stringify(inputSchema ?? {}, null, 2),
            `\`\`\``,
          ].join('\n')
    const examplesPrompt = examples?.length
      ? [
          `Examples:`,
          ...examples.map((example) => {
            if (this.inputFormat === 'freeform') {
              return [
                `<tool name="${example.tool ?? name}">`,
                example.input ?? '',
                `</tool>`,
              ].join('\n')
            }
            return [
              `<tool>`,
              JSON.stringify(
                {
                  tool: example.tool ?? name,
                  params: example.params ?? {},
                },
                null,
                2
              ),
              `</tool>`,
            ].join('\n')
          }),
        ].join('\n\n')
      : null

    return joinPromptSections([
      `### ${name}`,
      description,
      inputPrompt,
      examplesPrompt,
    ])
  }
}

interface ToolConstructor {
  new (providerAdapter: ProviderAdapter, services?: ToolServices): Tool
}

export { TOOL_METADATA_SYMBOL, createToolError, defineToolMetadata, Tool }
export type {
  ToolConstructor,
  ToolMetadata,
  ToolMetadataExample,
  ToolInputFormat,
  ToolExecutionOptions,
  ToolOutcome,
  ToolOutput,
  ToolProgressEvent,
  SpawnTaskResult,
  ToolServices,
}
