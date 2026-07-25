import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMcpHandlers,
  type McpHandlerDependencies,
} from '../../src/app/mcp-handlers.ts'

test('MCP handler factory exposes the provider catalog without eager work', async () => {
  // This focused fake implements only the catalog dependency path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies

  const handlers = createMcpHandlers(dependencies)
  const result = await handlers.listProviders()

  assert.ok(result.providers.includes('grok'))
  assert.ok(result.providers.includes('chatgpt'))
})

test('MCP handlers map thread state at the surface boundary', async () => {
  const thread = {
    id: 'thread-1',
    provider: 'grok',
    title: 'Smoke',
    runtime: { conversationUrl: 'https://grok.com/c/example' },
    turnCount: 2,
    createdAt: 10,
    updatedAt: 20,
  }
  // This focused fake implements only the thread-summary dependency path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    threadManager: {
      getThread: (threadId: string) => (threadId === thread.id ? thread : null),
    },
    threadOperations: { get: () => ({ phase: 'running' }) },
    foregroundOperations: new Set(),
    isForegroundOperationActive: () => false,
  } as unknown as McpHandlerDependencies
  const handlers = createMcpHandlers(dependencies)

  assert.deepEqual(await handlers.getThread(thread.id), {
    id: 'thread-1',
    provider: 'grok',
    title: 'Smoke',
    conversationUrl: 'https://grok.com/c/example',
    busy: true,
    turnCount: 2,
    createdAt: 10,
    updatedAt: 20,
  })
  await assert.rejects(handlers.getThread('missing'), /Unknown thread: missing/)
})
