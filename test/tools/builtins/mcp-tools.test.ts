import test from 'node:test'
import assert from 'node:assert/strict'

import { McpCallTool } from '../../../src/tools/builtins/mcp-call-tool.ts'
import { McpSearchTool } from '../../../src/tools/builtins/mcp-search-tool.ts'
import type { ToolOutput } from '../../../src/tools/core/tool-definition.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

function assertToolError(output: ToolOutput, message: string): void {
  assert.deepEqual(output, {
    outcome: 'error',
    result: { message },
    displayText: message,
  })
}

test('McpSearchTool returns structured validation and availability errors', async () => {
  const tool = new McpSearchTool(createProviderAdapterStub())

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

test('McpSearchTool delegates exact names and propagates service failures', async () => {
  const calls: Array<[string, string]> = []
  const expected: ToolOutput = {
    result: { name: 'echo', inputSchema: { type: 'object' } },
    displayText: 'Loaded MCP tool: server/echo',
  }
  const tool = new McpSearchTool(createProviderAdapterStub(), {
    mcpSearchTool: async (server, name) => {
      calls.push([server, name])
      return expected
    },
  })

  assert.equal(await tool.call({ server: 'server', tool: 'echo' }), expected)
  assert.deepEqual(calls, [['server', 'echo']])

  const failure = new Error('search failed')
  const failingTool = new McpSearchTool(createProviderAdapterStub(), {
    mcpSearchTool: async () => {
      throw failure
    },
  })
  await assert.rejects(
    failingTool.call({ server: 'server', tool: 'echo' }),
    (error) => error === failure
  )
})

test('McpCallTool returns structured validation and availability errors', async () => {
  const tool = new McpCallTool(createProviderAdapterStub())

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

test('McpCallTool forwards input and cancellation options unchanged', async () => {
  const controller = new AbortController()
  const input = {
    server: 'server',
    tool: 'echo',
    arguments: { text: 'hello', nested: { enabled: true } },
  }
  const options = { signal: controller.signal }
  let receivedInput: typeof input | undefined
  let receivedOptions: typeof options | undefined
  const expected: ToolOutput = {
    outcome: 'success',
    result: { content: [{ type: 'text', text: 'hello' }] },
    displayText: 'MCP tool completed.',
  }
  const tool = new McpCallTool(createProviderAdapterStub(), {
    mcpCallTool: async (callInput, callOptions) => {
      receivedInput = callInput as typeof input
      receivedOptions = callOptions as typeof options
      return expected
    },
  })

  assert.equal(await tool.call(input, options), expected)
  assert.equal(receivedInput, input)
  assert.equal(receivedOptions, options)
})

test('McpCallTool propagates service failures', async () => {
  const failure = new Error('call outcome is unknown')
  const tool = new McpCallTool(createProviderAdapterStub(), {
    mcpCallTool: async () => {
      throw failure
    },
  })

  await assert.rejects(
    tool.call({ server: 'server', tool: 'echo', arguments: {} }),
    (error) => error === failure
  )
})
