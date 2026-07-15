import test from 'node:test'
import assert from 'node:assert/strict'

import { McpCallTool } from '../../../src/tools/builtins/mcp-call-tool.ts'
import { McpSearchTool } from '../../../src/tools/builtins/mcp-search-tool.ts'
import type { ToolOutput } from '../../../src/tools/core/tool-definition.ts'

function assertToolError(output: ToolOutput, message: string): void {
  assert.deepEqual(output, {
    outcome: 'error',
    result: { message },
    displayText: message,
  })
}

test('McpSearchTool returns structured validation and availability errors', async () => {
  const tool = new McpSearchTool({} as any)

  assertToolError(
    await tool.call({ server: '', tool: 'echo' }),
    'mcp_search_tool requires a non-empty string params.server'
  )
  assertToolError(
    await tool.call({ server: 'server', tool: '' }),
    'mcp_search_tool requires a non-empty string params.tool'
  )
  assertToolError(
    await tool.call({ server: 'server', tool: 'echo' }),
    'mcp_search_tool is not configured in this runtime'
  )
})

test('McpCallTool returns structured validation and availability errors', async () => {
  const tool = new McpCallTool({} as any)

  assertToolError(
    await tool.call({ server: '', tool: 'echo', arguments: {} }),
    'mcp_call_tool requires a non-empty string params.server'
  )
  assertToolError(
    await tool.call({ server: 'server', tool: '', arguments: {} }),
    'mcp_call_tool requires a non-empty string params.tool'
  )
  assertToolError(
    await tool.call({
      server: 'server',
      tool: 'echo',
      arguments: null as never,
    }),
    'mcp_call_tool requires an object params.arguments'
  )
  assertToolError(
    await tool.call({ server: 'server', tool: 'echo', arguments: {} }),
    'mcp_call_tool is not configured in this runtime'
  )
})
