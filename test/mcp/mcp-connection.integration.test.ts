import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Server } from 'http'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import * as z from 'zod'

import { connectMcpServer } from '../../src/mcp/mcp-connection.ts'

test('connectMcpServer initializes, lists, calls, and closes a real stdio server', async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const fixturePath = path.resolve(
    testDirectory,
    '..',
    'fixtures',
    'mcp-stdio-server.ts'
  )
  const connection = await connectMcpServer(
    'stdio-test',
    {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', fixturePath],
      connectTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
    },
    { configDirectory: process.cwd() }
  )

  try {
    assert.deepEqual(
      connection.listCachedTools().map((tool) => tool.name),
      ['add_dynamic_tool', 'echo']
    )
    assert.match(
      connection.getCachedTool('echo')?.description ?? '',
      /stdio test server/
    )
    const result = await connection.callTool('echo', { value: 'hello' })
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'stdio:hello' }],
    })
    await connection.callTool('add_dynamic_tool', {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(connection.getCachedTool('dynamic')?.name, 'dynamic')
  } finally {
    await connection.close()
  }

  assert.equal(connection.available, false)
})

test('connectMcpServer uses Streamable HTTP and expands header environment values', async () => {
  const app = createMcpExpressApp()
  const receivedTokens: string[] = []
  app.post('/mcp', async (request: Request, response: Response) => {
    receivedTokens.push(request.header('x-test-token') ?? '')
    const server = new McpServer({
      name: 'portal-test-http-server',
      version: '1.0.0',
    })
    server.registerTool(
      'echo',
      {
        description: 'Echo a value from the HTTP test server.',
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({
        content: [{ type: 'text', text: `http:${value}` }],
      })
    )
    server.registerResource(
      'memo',
      'memo://one',
      { description: 'Test memo.', mimeType: 'text/plain' },
      async (uri) => ({
        contents: [{ uri: uri.href, text: 'memo body' }],
      })
    )
    server.registerPrompt(
      'review',
      {
        description: 'Review a topic.',
        argsSchema: { focus: z.string() },
      },
      async ({ focus }) => ({
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: `Review ${focus}.` },
          },
        ],
      })
    )
    const transport = new StreamableHTTPServerTransport()
    let onclose: NonNullable<Transport['onclose']> = () => {}
    let onerror: NonNullable<Transport['onerror']> = () => {}
    let onmessage: NonNullable<Transport['onmessage']> = () => {}
    const serverTransport = {
      start: () => transport.start(),
      send: (message, options) => transport.send(message, options),
      close: () => transport.close(),
      get onclose() {
        return onclose
      },
      set onclose(handler: NonNullable<Transport['onclose']>) {
        onclose = handler
        transport.onclose = handler
      },
      get onerror() {
        return onerror
      },
      set onerror(handler: NonNullable<Transport['onerror']>) {
        onerror = handler
        transport.onerror = handler
      },
      get onmessage() {
        return onmessage
      },
      set onmessage(handler: NonNullable<Transport['onmessage']>) {
        onmessage = handler
        transport.onmessage = handler
      },
    } satisfies Transport
    await server.connect(serverTransport)
    await transport.handleRequest(request, response, request.body)
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
  })
  const httpServer = await listen(app)
  const address = httpServer.address()
  assert.ok(address !== null && typeof address !== 'string')

  try {
    const connection = await connectMcpServer(
      'http-test',
      {
        transport: 'streamable-http',
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { 'X-Test-Token': '${env:TEST_MCP_TOKEN}' },
        connectTimeoutMs: 10_000,
        toolTimeoutMs: 10_000,
      },
      {
        configDirectory: process.cwd(),
        environment: { TEST_MCP_TOKEN: 'header-secret' },
      }
    )
    try {
      assert.deepEqual(
        connection.listCachedTools().map((tool) => tool.name),
        ['echo']
      )
      const result = await connection.callTool('echo', { value: 'hello' })
      assert.deepEqual(result, {
        content: [{ type: 'text', text: 'http:hello' }],
      })
      assert.deepEqual(
        (await connection.listResources()).map(({ uri }) => uri),
        ['memo://one']
      )
      assert.deepEqual(await connection.readResource('memo://one'), {
        contents: [{ uri: 'memo://one', text: 'memo body' }],
      })
      assert.deepEqual(
        (await connection.listPrompts()).map(({ name }) => name),
        ['review']
      )
      assert.deepEqual(
        await connection.getPrompt('review', { focus: 'bugs' }),
        {
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: 'Review bugs.' },
            },
          ],
        }
      )
      assert.ok(receivedTokens.length >= 3)
      assert.ok(receivedTokens.every((token) => token === 'header-secret'))
    } finally {
      await connection.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) =>
        error === undefined ? resolve() : reject(error)
      )
    })
  }
})

async function listen(
  app: ReturnType<typeof createMcpExpressApp>
): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
}
