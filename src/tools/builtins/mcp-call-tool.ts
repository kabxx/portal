import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'
import {
  createToolError,
  Tool,
  defineToolMetadata,
} from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'

interface McpCallToolInput {
  server: string
  tool: string
  arguments: Record<string, unknown>
}

@defineToolMetadata({
  name: 'mcp_call_tool',
  description: [
    'Call one MCP tool using exact server and tool names.',
    'Load an unfamiliar tool definition with mcp_search_tool before constructing arguments.',
    'Never retry an MCP call automatically when its outcome is reported as unknown.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'Exact MCP server name.',
      },
      tool: {
        type: 'string',
        description: 'Exact MCP tool name.',
      },
      arguments: {
        type: 'object',
        description: 'Arguments matching the MCP tool input schema.',
      },
    },
    required: ['server', 'tool', 'arguments'],
  },
})
class McpCallTool extends Tool<McpCallToolInput, ToolOutput> {
  public async call(
    input: McpCallToolInput,
    options: AbortOptions = {}
  ): Promise<ToolOutput> {
    if (typeof input.server !== 'string' || input.server.trim() === '') {
      return createToolError(
        'mcp_call_tool requires a non-empty string params.server'
      )
    }
    if (typeof input.tool !== 'string' || input.tool.trim() === '') {
      return createToolError(
        'mcp_call_tool requires a non-empty string params.tool'
      )
    }
    if (!isRecord(input.arguments)) {
      return createToolError(
        'mcp_call_tool requires an object params.arguments'
      )
    }
    if (this.services.mcpCallTool === undefined) {
      return createToolError('mcp_call_tool is not configured in this runtime')
    }
    return await this.services.mcpCallTool(input, options)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { McpCallTool }
