import { Tool } from './tool-definition.ts'
import type { ProviderAdapter } from '../../providers/adapters/adapter-base.ts'
import { isAbortError } from '../../runtime/runtime-cancellation.ts'
import type {
  ToolConstructor,
  ToolExecutionOptions,
  ToolInputFormat,
  ToolOutcome,
  ToolServices,
} from './tool-definition.ts'
import { createToolError, type ToolOutput } from './tool-definition.ts'

export interface ExtractedToolCall {
  leadingText: string
  declaredToolName: string | null
  rawPayload: string
  trailingText: string
}

export interface ToolCall {
  tool: string
  params: Record<string, unknown> | string
}

export interface ToolResult {
  outcome: ToolOutcome
  result: Record<string, unknown>
  displayText?: string
}

export interface ToolResultDelivery {
  status: 'not_delivered'
  code: string
  message: string
  [key: string]: unknown
}

const TOOL_TAG_PREFIX = '<tool'

export type PreparedToolCall =
  | {
      ok: true
      toolCall: ToolCall
      execute(options?: ToolExecutionOptions): Promise<ToolResult>
    }
  | { ok: false; toolCall: ToolCall | null; result: ToolResult }

export function extractToolCall(response: string): ExtractedToolCall | null {
  const match = response.match(
    /([\s\S]*?)<tool(?:\s+name\s*=\s*(?:"([^"]+)"|'([^']+)'))?\s*>([\s\S]*?)<\/tool>([\s\S]*)/i
  )
  if (!match) {
    return null
  }

  return {
    leadingText: match[1] ?? '',
    declaredToolName: (match[2] ?? match[3] ?? '').trim() || null,
    rawPayload: match[4] ?? '',
    trailingText: match[5] ?? '',
  }
}

export function isToolCallAtResponseEnd(extracted: ExtractedToolCall): boolean {
  return extracted.trailingText.trim() === ''
}

export function projectStreamingAssistantText(response: string): string {
  const extracted = extractToolCall(response)
  if (extracted !== null) {
    return isToolCallAtResponseEnd(extracted)
      ? extracted.leadingText.trim()
      : response
  }

  const normalized = maskMarkdownCode(response).toLowerCase()
  let searchFrom = 0

  while (searchFrom < normalized.length) {
    const toolStart = normalized.indexOf(TOOL_TAG_PREFIX, searchFrom)
    if (toolStart === -1) {
      break
    }

    const nextCharacter = normalized[toolStart + TOOL_TAG_PREFIX.length]
    if (
      nextCharacter === undefined ||
      nextCharacter === '>' ||
      /\s/.test(nextCharacter)
    ) {
      return response.slice(0, toolStart).trim()
    }

    searchFrom = toolStart + TOOL_TAG_PREFIX.length
  }

  for (let length = TOOL_TAG_PREFIX.length - 1; length > 0; length -= 1) {
    if (normalized.endsWith(TOOL_TAG_PREFIX.slice(0, length))) {
      return response.slice(0, -length).trim()
    }
  }

  return response
}

function maskMarkdownCode(value: string): string {
  let delimiterLength: number | null = null
  let masked = ''

  for (let index = 0; index < value.length;) {
    if (value[index] !== '`') {
      const character = value[index]!
      masked += delimiterLength === null || character === '\n' ? character : ' '
      index += 1
      continue
    }

    let runEnd = index + 1
    while (value[runEnd] === '`') {
      runEnd += 1
    }
    const runLength = runEnd - index
    masked += ' '.repeat(runLength)

    if (delimiterLength === null) {
      delimiterLength = runLength
    } else if (
      runLength === delimiterLength ||
      (delimiterLength >= 3 && runLength > delimiterLength)
    ) {
      delimiterLength = null
    }

    index = runEnd
  }

  return masked
}

export function parseToolCallPayload(
  toolCallPayload: string,
  declaredToolName: string | null = null,
  declaredInputFormat?: ToolInputFormat
): ToolCall | null {
  if (declaredToolName === null) {
    return null
  }
  if (declaredInputFormat === 'json') {
    try {
      const params: unknown = JSON.parse(toolCallPayload)
      return isRecord(params) ? { tool: declaredToolName, params } : null
    } catch {
      return null
    }
  }
  return {
    tool: declaredToolName,
    params: toolCallPayload,
  }
}

class ToolRegistry {
  private readonly tools: Map<string, Tool>
  private readonly promptedTools: readonly Tool[]

  constructor(
    providerAdapter: ProviderAdapter,
    tools: ToolConstructor[],
    services: ToolServices = {},
    hiddenToolNames: readonly string[] = []
  ) {
    this.tools = new Map()
    for (const ToolClass of tools) {
      const tool = new ToolClass(providerAdapter, services)
      this.tools.set(tool.name, tool)
    }
    const hiddenNames = new Set(hiddenToolNames)
    this.promptedTools = [...this.tools.values()].filter(
      (tool) => !hiddenNames.has(tool.name)
    )
  }

  public get prompt(): string {
    return this.promptedTools.map((tool) => tool.prompt).join('\n\n')
  }

  public async extractToolCall(
    response: string
  ): Promise<ExtractedToolCall | null> {
    return extractToolCall(response)
  }

  public async extractToolCallPayload(
    response: string
  ): Promise<string | null> {
    return (await this.extractToolCall(response))?.rawPayload ?? null
  }

  public parseToolCallPayload(
    toolCallPayload: string,
    declaredToolName: string | null = null
  ): ToolCall | null {
    const declaredInputFormat =
      declaredToolName === null
        ? undefined
        : this.tools.get(declaredToolName)?.inputFormat
    return parseToolCallPayload(
      toolCallPayload,
      declaredToolName,
      declaredInputFormat
    )
  }

  public async executeToolCall(
    toolCallPayload: string,
    options: ToolExecutionOptions = {},
    declaredToolName: string | null = null
  ): Promise<ToolResult> {
    const prepared = this.prepareToolCall(toolCallPayload, declaredToolName)
    return prepared.ok ? await prepared.execute(options) : prepared.result
  }

  public prepareToolCall(
    toolCallPayload: string,
    declaredToolName: string | null = null
  ): PreparedToolCall {
    if (declaredToolName === null) {
      return {
        ok: false,
        toolCall: null,
        result: asErrorResult(
          'Tool calls require <tool name="tool_name">PAYLOAD</tool>'
        ),
      }
    }
    const toolCall = this.parseToolCallPayload(
      toolCallPayload,
      declaredToolName
    )
    if (toolCall === null) {
      let parseError = 'Invalid tool call shape'
      try {
        const parsed: unknown = JSON.parse(toolCallPayload)
        if (
          declaredToolName !== null &&
          this.tools.get(declaredToolName)?.inputFormat === 'json'
        ) {
          if (!isRecord(parsed)) {
            parseError = `Tool ${declaredToolName} payload must be a JSON object`
          }
        }
      } catch (error) {
        parseError = String(error)
      }
      return {
        ok: false,
        toolCall: null,
        result: asErrorResult(`Invalid tool call JSON: ${parseError}`),
      }
    }

    return this.prepareParsedToolCall(toolCall, true)
  }

  public prepareParsedToolCall(
    toolCall: ToolCall,
    namedInvocation: boolean
  ): PreparedToolCall {
    const tool = this.tools.get(toolCall.tool)
    if (!tool) {
      return {
        ok: false,
        toolCall,
        result: asErrorResult(`Tool not found: ${toolCall.tool}`),
      }
    }
    if (tool.inputFormat === 'freeform') {
      if (!namedInvocation) {
        return {
          ok: false,
          toolCall,
          result: asErrorResult(
            `Tool ${toolCall.tool} requires <tool name="${toolCall.tool}"> with a freeform payload`
          ),
        }
      }
      if (typeof toolCall.params !== 'string') {
        return {
          ok: false,
          toolCall,
          result: asErrorResult(
            `Tool ${toolCall.tool} requires a freeform invocation`
          ),
        }
      }
    }
    if (tool.inputFormat === 'json' && typeof toolCall.params === 'string') {
      return {
        ok: false,
        toolCall,
        result: asErrorResult(
          `Tool ${toolCall.tool} requires a JSON invocation`
        ),
      }
    }

    return {
      ok: true,
      toolCall,
      execute: async (options: ToolExecutionOptions = {}) => {
        try {
          return normalizeToolOutput(await tool.call(toolCall.params, options))
        } catch (error) {
          if (isAbortError(error)) throw error
          return asErrorResult(`Tool execution failed: ${String(error)}`)
        }
      },
    }
  }
}

function normalizeToolOutput(output: ToolOutput): ToolResult {
  if (
    typeof output === 'object' &&
    output !== null &&
    isRecord(output.result) &&
    typeof output.displayText === 'string'
  ) {
    const result = normalizeResult(output.result)
    if (result === null) {
      return asErrorResult('Tool returned a non-serializable result')
    }
    return {
      outcome: isToolOutcome(output.outcome) ? output.outcome : 'success',
      result,
      displayText: output.displayText,
    }
  }
  return asErrorResult('Tool returned an invalid result')
}

function asErrorResult(message: string): ToolResult {
  return createToolError(message)
}

function normalizeResult(
  result: Record<string, unknown>
): Record<string, unknown> | null {
  try {
    const serialized = JSON.stringify(result)
    if (serialized === undefined) {
      return null
    }
    const normalized = JSON.parse(serialized) as unknown
    return isRecord(normalized) ? normalized : null
  } catch {
    return null
  }
}

function isToolOutcome(value: unknown): value is ToolOutcome {
  return value === 'success' || value === 'error' || value === 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatToolResultMessage(
  toolName: string,
  toolResult: ToolResult,
  delivery?: ToolResultDelivery
): string {
  return [
    '### Tool Result ###',
    JSON.stringify(
      {
        tool: toolName,
        outcome: toolResult.outcome,
        result: delivery === undefined ? toolResult.result : null,
        ...(delivery === undefined ? {} : { delivery }),
      },
      null,
      2
    ),
  ].join('\n')
}

export { formatToolResultMessage, ToolRegistry }
