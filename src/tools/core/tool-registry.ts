import { isAbortError } from '../../runtime/runtime-cancellation.ts'
import type {
  ToolExecutionOptions,
  ToolInputFormat,
  ToolOutcome,
} from './tool-definition.ts'
import {
  DEFAULT_TEXT_TOOL_PROTOCOL,
  type TextToolProtocol,
} from './text-tool-protocol.ts'
import type { ToolRuntimeService } from '../tool-runtime-service.ts'
import type { ChildConversationParent } from '../../threads/child-conversation-service.ts'

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

export type PreparedToolCall =
  | {
      ok: true
      toolCall: ToolCall
      execute(options?: ToolExecutionOptions): Promise<ToolResult>
    }
  | { ok: false; toolCall: ToolCall | null; result: ToolResult }

export function extractToolCall(
  response: string,
  protocol: TextToolProtocol = DEFAULT_TEXT_TOOL_PROTOCOL
): ExtractedToolCall | null {
  const tag = escapeRegExp(protocol.tagName)
  const match = response.match(
    new RegExp(
      `([\\s\\S]*?)<${tag}(?:\\s+name\\s*=\\s*(?:"([^"]+)"|'([^']+)'))?\\s*>([\\s\\S]*?)<\\/${tag}>([\\s\\S]*)`,
      'i'
    )
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

export function projectStreamingAssistantText(
  response: string,
  protocol: TextToolProtocol = DEFAULT_TEXT_TOOL_PROTOCOL
): string {
  const extracted = extractToolCall(response, protocol)
  if (extracted !== null) {
    return isToolCallAtResponseEnd(extracted)
      ? extracted.leadingText.trim()
      : response
  }

  const tagPrefix = `<${protocol.tagName}`.toLowerCase()
  const normalized = maskMarkdownCode(response).toLowerCase()
  let searchFrom = 0

  while (searchFrom < normalized.length) {
    const toolStart = normalized.indexOf(tagPrefix, searchFrom)
    if (toolStart === -1) {
      break
    }

    const nextCharacter = normalized[toolStart + tagPrefix.length]
    if (
      nextCharacter === undefined ||
      nextCharacter === '>' ||
      /\s/.test(nextCharacter)
    ) {
      return response.slice(0, toolStart).trim()
    }

    searchFrom = toolStart + tagPrefix.length
  }

  for (let length = tagPrefix.length - 1; length > 0; length -= 1) {
    if (normalized.endsWith(tagPrefix.slice(0, length))) {
      return response.slice(0, -length).trim()
    }
  }

  return response
}

export function projectStreamingAssistantTextForProtocols(
  response: string,
  protocols: readonly TextToolProtocol[]
): string {
  for (const protocol of protocols) {
    const extracted = extractToolCall(response, protocol)
    const projected = projectStreamingAssistantText(response, protocol)
    if (extracted !== null || projected !== response) {
      return projected
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
  private readonly graphToolHost: ToolRuntimeService
  private readonly availableCapabilities: readonly string[]
  private readonly invocation: ChildConversationParent | null
  private readonly promptedToolPrompts: readonly string[]
  public readonly protocol: TextToolProtocol

  constructor(
    provider: { readonly toolCapabilities: readonly string[] },
    options: {
      readonly toolHost: ToolRuntimeService
      readonly hiddenToolNames?: readonly string[]
      readonly protocol?: TextToolProtocol
      readonly invocation?: ChildConversationParent
    }
  ) {
    this.protocol = options.protocol ?? DEFAULT_TEXT_TOOL_PROTOCOL
    this.graphToolHost = options.toolHost
    this.availableCapabilities = provider.toolCapabilities
    this.invocation = options.invocation ?? null
    const hiddenNames = new Set(options.hiddenToolNames ?? [])
    this.promptedToolPrompts = Object.freeze([
      ...this.graphToolHost
        .list()
        .filter(({ descriptor }) => !hiddenNames.has(descriptor.name))
        .map(({ descriptor }) => formatGraphToolPrompt(descriptor)),
    ])
  }

  public get prompt(): string {
    return this.promptedToolPrompts.join('\n\n')
  }

  public async extractToolCall(
    response: string
  ): Promise<ExtractedToolCall | null> {
    return extractToolCall(response, this.protocol)
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
        : this.inputFormatFor(declaredToolName)
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

  public projectStreamingAssistantText(response: string): string {
    return projectStreamingAssistantText(response, this.protocol)
  }

  public formatToolResultMessage(
    toolName: string,
    toolResult: ToolResult,
    delivery?: ToolResultDelivery
  ): string {
    return formatToolResultMessage(
      toolName,
      toolResult,
      delivery,
      this.protocol
    )
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
          `${this.protocol.displayName} calls require <${this.protocol.tagName} name="tool_name">PAYLOAD</${this.protocol.tagName}>`
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
          this.inputFormatFor(declaredToolName) === 'json'
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
    const graphTool = this.graphToolHost
      .list()
      .find(({ descriptor }) => descriptor.name === toolCall.tool)
    if (graphTool === undefined) {
      return {
        ok: false,
        toolCall,
        result: asErrorResult(`Tool not found: ${toolCall.tool}`),
      }
    }
    const inputFormat = graphTool.descriptor.inputFormat
    if (inputFormat === 'freeform') {
      if (!namedInvocation) {
        return {
          ok: false,
          toolCall,
          result: asErrorResult(
            `${this.protocol.displayName} ${toolCall.tool} requires <${this.protocol.tagName} name="${toolCall.tool}"> with a freeform payload`
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
    if (inputFormat === 'json' && typeof toolCall.params === 'string') {
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
          const result = await this.graphToolHost.execute(
            toolCall.tool,
            toolCall.params,
            options.toolCallId ?? `runtime-${toolCall.tool}`,
            {
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
              availableCapabilities: this.availableCapabilities,
              ...(this.invocation === null
                ? {}
                : { invocation: this.invocation }),
              ...(options.onProgress === undefined
                ? {}
                : { onProgress: options.onProgress }),
            }
          )
          return {
            outcome: result.status,
            result: result.output,
            ...(result.displayText === undefined
              ? {}
              : { displayText: result.displayText }),
          }
        } catch (error) {
          if (isAbortError(error)) throw error
          return asErrorResult(`Tool execution failed: ${String(error)}`)
        }
      },
    }
  }

  private inputFormatFor(toolName: string): ToolInputFormat | undefined {
    return this.graphToolHost
      .list()
      .find(({ descriptor }) => descriptor.name === toolName)?.descriptor
      .inputFormat
  }
}

function formatGraphToolPrompt(descriptor: {
  readonly name: string
  readonly description: string
  readonly inputFormat?: ToolInputFormat
  readonly inputSchema: Record<string, unknown>
}): string {
  const format = descriptor.inputFormat === 'freeform' ? 'freeform' : 'JSON'
  const parameters =
    descriptor.inputFormat === 'freeform'
      ? 'raw text'
      : renderJsonParameters(descriptor.inputSchema)
  return [
    `### ${descriptor.name}`,
    `Description: ${descriptor.description.replace(/\s+/g, ' ').trim()}`,
    `Parameters (${format}): ${parameters}`,
  ].join('\n')
}

function renderJsonParameters(schema: Record<string, unknown>): string {
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
  if (!isRecord(schema)) return 'unknown'
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  }
  if (schema.type === 'array') return `${renderJsonType(schema.items)}[]`
  return typeof schema.type === 'string' ? schema.type : 'unknown'
}

function asErrorResult(message: string): ToolResult {
  return {
    outcome: 'error',
    result: { message },
    displayText: message,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatToolResultMessage(
  toolName: string,
  toolResult: ToolResult,
  delivery?: ToolResultDelivery,
  protocol: TextToolProtocol = DEFAULT_TEXT_TOOL_PROTOCOL
): string {
  return [
    protocol.resultHeading,
    JSON.stringify(
      {
        [protocol.resultField]: toolName,
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
