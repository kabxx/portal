import type { ProviderAdapter } from '../../providers/adapters/adapter-base.ts'
import type { RunCommandJobService } from '../../processes/run-command-job-manager.ts'
import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'

const TOOL_METADATA_SYMBOL = Symbol('TOOL_METADATA')

type ToolInputFormat = 'json' | 'freeform'

interface ToolMetadata {
  name: string
  description: string
  inputFormat?: ToolInputFormat
  inputSchema?: unknown
  parameters?: string
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
  toolCallId?: string
}

interface ToolServices {
  runCommandJobs?: RunCommandJobService
  spawnTask?: (
    input: { prompt: string; provider?: string },
    options?: ToolExecutionOptions
  ) => Promise<SpawnTaskResult>
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
    'parameters' in value &&
    value.parameters !== undefined &&
    typeof value.parameters !== 'string'
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
    const { name, description, inputSchema, parameters } = this.metadata
    const format = this.inputFormat === 'freeform' ? 'freeform' : 'JSON'
    const renderedParameters =
      this.inputFormat === 'freeform'
        ? (parameters ?? 'raw text')
        : renderJsonParameters(inputSchema)
    return [
      `### ${name}`,
      `Description: ${description.replace(/\s+/g, ' ').trim()}`,
      `Parameters (${format}): ${renderedParameters}`,
    ].join('\n')
  }
}

function renderJsonParameters(schema: unknown): string {
  if (!isRecord(schema) || schema.type !== 'object') {
    return '{}'
  }
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === 'string'
        )
      : []
  )
  return `{${Object.entries(properties)
    .map(
      ([name, value]) =>
        `${name}${required.has(name) ? '' : '?'}: ${renderJsonType(value)}`
    )
    .join('; ')}}`
}

function renderJsonType(schema: unknown): string {
  if (!isRecord(schema)) {
    return 'unknown'
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  }
  if (schema.type === 'array') {
    return `${renderJsonType(schema.items)}[]`
  }
  return typeof schema.type === 'string' ? schema.type : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ToolConstructor {
  new (providerAdapter: ProviderAdapter, services?: ToolServices): Tool
}

export { TOOL_METADATA_SYMBOL, createToolError, defineToolMetadata, Tool }
export type {
  ToolConstructor,
  ToolMetadata,
  ToolInputFormat,
  ToolExecutionOptions,
  ToolOutcome,
  ToolOutput,
  ToolProgressEvent,
  SpawnTaskResult,
  ToolServices,
}
