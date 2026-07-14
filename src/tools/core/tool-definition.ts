import type { ProviderAdapter } from '../../providers/adapters/adapter-base.ts'
import type { RunCommandJobService } from '../../processes/run-command-job-manager.ts'
import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'
import { joinPromptSections } from '../../shared/prompt-sections.ts'

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

interface ToolOutputDetail {
  result: Record<string, unknown>
  displayText: string
  outcome?: ToolOutcome
}

type ToolOutput = string | ToolOutputDetail

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
}

interface ToolServices {
  runCommandJobs?: RunCommandJobService
  spawnTask?: (
    input: { prompt: string; provider?: string },
    options?: AbortOptions
  ) => Promise<string>
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

function defineToolMetadata(metadata: ToolMetadata) {
  return function (target: any) {
    target[TOOL_METADATA_SYMBOL] = metadata
  }
}

abstract class Tool<TInput = any, TOutput = ToolOutput> {
  constructor(
    protected readonly providerAdapter: ProviderAdapter,
    protected readonly services: ToolServices = {}
  ) {}

  abstract call(input: TInput, options?: ToolExecutionOptions): Promise<TOutput>

  public get metadata(): ToolMetadata {
    const metadata = (this.constructor as any)[TOOL_METADATA_SYMBOL]
    if (!metadata) {
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

export { TOOL_METADATA_SYMBOL, defineToolMetadata, Tool }
export type {
  ToolConstructor,
  ToolMetadata,
  ToolMetadataExample,
  ToolInputFormat,
  ToolExecutionOptions,
  ToolOutcome,
  ToolOutput,
  ToolOutputDetail,
  ToolProgressEvent,
  ToolServices,
}
