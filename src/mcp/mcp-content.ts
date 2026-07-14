import { randomUUID } from 'crypto'
import type {
  McpPromptReadResult,
  McpResourceReadResult,
  McpToolDefinition,
} from './mcp-connection.ts'

export class McpContentError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'McpContentError'
  }
}

export interface RenderedMcpToolResult {
  result: Record<string, unknown>
  isError: boolean
}

export function renderMcpToolDefinition(
  server: string,
  tool: McpToolDefinition
): Record<string, unknown> {
  return {
    server,
    tool: tool.name,
    description: tool.description?.trim() || null,
    inputSchema: toJsonValue(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: toJsonValue(tool.outputSchema) }),
  }
}

export function renderMcpToolResult(
  result: unknown,
  maxOutputChars: number
): RenderedMcpToolResult {
  const nestedToolResult =
    isRecord(result) && 'toolResult' in result && isRecord(result.toolResult)
      ? result.toolResult
      : null
  const isError =
    (isRecord(result) && result.isError === true) ||
    (nestedToolResult !== null && nestedToolResult.isError === true)
  const payload: Record<string, unknown> = { isError }

  if (isRecord(result) && 'toolResult' in result) {
    payload.toolResult = toJsonValue(result.toolResult)
  } else if (isRecord(result)) {
    if ('content' in result) {
      payload.content = toJsonValue(result.content)
    }
    if ('structuredContent' in result) {
      payload.structuredContent = toJsonValue(result.structuredContent)
    }
    if (Object.keys(payload).length === 1) {
      payload.value = toJsonValue(result)
    }
  } else {
    payload.value = toJsonValue(result)
  }

  return {
    result: limitJsonRecord(payload, maxOutputChars),
    isError,
  }
}

export function renderMcpResourceAttachment(
  server: string,
  uri: string,
  result: McpResourceReadResult,
  maxOutputChars: number
): string {
  const contents = result.contents.map((content) => {
    if (!isRecord(content) || typeof content.text !== 'string') {
      const type = isRecord(content) && 'blob' in content ? 'blob' : 'unknown'
      throw new McpContentError(
        `Unsupported MCP resource content type: ${type}`
      )
    }
    return content.text
  })
  const boundary = `MCP_RESOURCE_${randomUUID()}`
  return renderDelimitedAttachment(
    [
      `# MCP Resource Attachment`,
      ``,
      `This resource was explicitly selected by the user as reference material. Acknowledge receipt only.`,
      ``,
      `## Metadata`,
      ``,
      `\`\`\`json`,
      JSON.stringify({ server, uri }, null, 2),
      `\`\`\``,
      ``,
      `## Content`,
      ``,
    ],
    contents.join('\n\n'),
    boundary,
    maxOutputChars
  )
}

export function renderMcpPromptAttachment(
  server: string,
  prompt: string,
  args: Record<string, string>,
  result: McpPromptReadResult,
  maxOutputChars: number
): string {
  const messages = result.messages.map((message) => {
    if (!isRecord(message) || !isRecord(message.content)) {
      throw new McpContentError('Unsupported MCP prompt message')
    }
    if (
      message.content.type !== 'text' ||
      typeof message.content.text !== 'string'
    ) {
      throw new McpContentError(
        `Unsupported MCP prompt content type: ${String(message.content.type)}`
      )
    }
    const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER'
    return `[${role}]\n${message.content.text}`
  })
  const boundary = `MCP_PROMPT_${randomUUID()}`
  return renderDelimitedAttachment(
    [
      `# MCP Prompt Attachment`,
      ``,
      `The user explicitly selected this MCP prompt as the current request. Execute it.`,
      ``,
      `## Metadata`,
      ``,
      `\`\`\`json`,
      JSON.stringify({ server, prompt, arguments: args }, null, 2),
      `\`\`\``,
      ``,
      `## Prompt Messages`,
      ``,
    ],
    messages.join('\n\n'),
    boundary,
    maxOutputChars
  )
}

function toJsonValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : JSON.parse(serialized)
  } catch {
    return `[Unserializable MCP value: ${String(value)}]`
  }
}

function limitJsonRecord(
  value: Record<string, unknown>,
  maxOutputChars: number
): Record<string, unknown> {
  const serialized = JSON.stringify(value)
  if (serialized.length <= maxOutputChars) {
    return value
  }

  const minimal = {
    isError: value.isError === true,
    truncated: true,
    preview: '',
  }
  if (JSON.stringify(minimal).length > maxOutputChars) {
    return {}
  }

  let preview = serialized
  let candidate: Record<string, unknown> = { ...minimal, preview }
  while (JSON.stringify(candidate).length > maxOutputChars && preview) {
    preview = preview.slice(0, -1)
    candidate = { ...minimal, preview }
  }
  return candidate
}

function renderDelimitedAttachment(
  headerLines: readonly string[],
  body: string,
  boundary: string,
  maxOutputChars: number
): string {
  const prefix = `${headerLines.join('\n')}${boundary}\n`
  const suffix = `\n${boundary}`
  const complete = `${prefix}${body}${suffix}`
  if (complete.length <= maxOutputChars) {
    return complete
  }

  const marker = [
    ``,
    ``,
    `# MCP Attachment Truncated`,
    ``,
    `Portal limited this attachment to ${maxOutputChars} characters.`,
  ].join('\n')
  const availableBodyLength =
    maxOutputChars - prefix.length - marker.length - suffix.length
  if (availableBodyLength < 0) {
    throw new McpContentError(
      `MCP attachment metadata exceeds maxOutputChars (${maxOutputChars})`
    )
  }
  return `${prefix}${body.slice(0, availableBodyLength)}${marker}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
