import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'
import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'

interface McpSearchToolInput {
  server: string
  tool: string
}

@defineToolMetadata({
  name: 'mcp_search_tool',
  description: [
    'Load the definition of one MCP tool using its exact server and tool names.',
    'Use names from the MCP Servers catalog. This operation does not call the MCP tool.',
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
    },
    required: ['server', 'tool'],
  },
})
class McpSearchTool extends Tool<McpSearchToolInput, ToolOutput> {
  public async call(
    input: McpSearchToolInput,
    _options: AbortOptions = {}
  ): Promise<ToolOutput> {
    if (typeof input.server !== 'string' || input.server.trim() === '') {
      return '[ERROR] mcp_search_tool requires a non-empty string params.server'
    }
    if (typeof input.tool !== 'string' || input.tool.trim() === '') {
      return '[ERROR] mcp_search_tool requires a non-empty string params.tool'
    }
    if (this.services.mcpSearchTool === undefined) {
      return '[ERROR] mcp_search_tool is not configured in this runtime'
    }
    return await this.services.mcpSearchTool(input.server, input.tool)
  }
}

export { McpSearchTool }
