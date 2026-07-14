import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'

const server = new McpServer({
  name: 'portal-test-stdio-server',
  version: '1.0.0',
})

server.registerTool(
  'echo',
  {
    description: 'Echo a value from the stdio test server.',
    inputSchema: {
      value: z.string(),
    },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `stdio:${value}` }],
  })
)

server.registerTool(
  'add_dynamic_tool',
  {
    description: 'Add a tool after initialization.',
    inputSchema: {},
  },
  async () => {
    if (server.isConnected()) {
      try {
        server.registerTool(
          'dynamic',
          { description: 'Added dynamically.', inputSchema: {} },
          async () => ({
            content: [{ type: 'text', text: 'dynamic:ok' }],
          })
        )
      } catch {}
    }
    return { content: [{ type: 'text', text: 'dynamic tool requested' }] }
  }
)

await server.connect(new StdioServerTransport())
