import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { PortalMcpServer } from '../../src/mcp-server/mcp-server.ts'
import type {
  PortalMcpHandlers,
  PortalMcpMessageOperation,
  PortalMcpThreadSummary,
} from '../../src/mcp-server/mcp-server-types.ts'

const thread: PortalMcpThreadSummary = {
  id: 't-1',
  provider: 'chatgpt',
  title: null,
  conversationUrl: 'https://chatgpt.com/c/test',
  busy: false,
  turnCount: 1,
  createdAt: 1,
  updatedAt: 2,
}

function createHandlers(calls: string[] = []): PortalMcpHandlers {
  const operation: PortalMcpMessageOperation = {
    operationId: 'op-1',
    threadId: 't-1',
    status: 'running',
  }
  return {
    listProviders: () => ({ providers: ['chatgpt', 'gemini'] }),
    listThreads: () => ({ threads: [thread] }),
    getThread: async (threadId) => {
      calls.push(`get:${threadId}`)
      return thread
    },
    createThread: async ({ provider, model, option, mode }, signal) => {
      assert.equal(signal.aborted, false)
      calls.push(`create:${provider}:${model ?? ''}:${option ?? ''}:${mode}`)
      return thread
    },
    resumeThread: async (conversationUrl) => {
      calls.push(`resume:${conversationUrl}`)
      return thread
    },
    closeThread: async (threadId) => {
      calls.push(`close:${threadId}`)
      return { closed: true, threadId }
    },
    sendMessage: async (threadId, input) => {
      calls.push(`send:${threadId}:${input}`)
      return operation
    },
    waitMessage: async (operationId, timeoutMs) => {
      calls.push(`wait:${operationId}:${timeoutMs}`)
      return { ...operation, status: 'completed', assistant: 'answer' }
    },
    cancelMessage: async (operationId) => {
      calls.push(`cancel:${operationId}`)
      return { ...operation, status: 'cancelled' }
    },
  }
}

test('PortalMcpServer initializes, lists, and calls its fixed tools', async () => {
  const calls: string[] = []
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(calls),
  })
  await server.start()
  const client = await connectClient(server.address()!)

  try {
    assert.deepEqual(
      (await client.listTools()).tools.map(({ name }) => name),
      [
        'portal_list_providers',
        'portal_list_threads',
        'portal_get_thread',
        'portal_create_thread',
        'portal_resume_thread',
        'portal_close_thread',
        'portal_send_message',
        'portal_wait_message',
        'portal_cancel_message',
      ]
    )
    const providers = await client.callTool({
      name: 'portal_list_providers',
      arguments: {},
    })
    assert.deepEqual(providers.structuredContent, {
      providers: ['chatgpt', 'gemini'],
    })
    assert.deepEqual(providers.content, [
      { type: 'text', text: '{"providers":["chatgpt","gemini"]}' },
    ])

    await client.callTool({
      name: 'portal_create_thread',
      arguments: { provider: 'chatgpt' },
    })
    const created = await client.callTool({
      name: 'portal_create_thread',
      arguments: {
        provider: 'gemini',
        model: '3.1-pro',
        option: 'extended',
        mode: 'chat',
      },
    })
    assert.deepEqual(created.structuredContent, thread)

    const sent = await client.callTool({
      name: 'portal_send_message',
      arguments: { threadId: 't-1', input: 'hello' },
    })
    assert.deepEqual(sent.structuredContent, {
      operationId: 'op-1',
      threadId: 't-1',
      status: 'running',
    })
    const waited = await client.callTool({
      name: 'portal_wait_message',
      arguments: { operationId: 'op-1', timeoutSeconds: 2 },
    })
    assert.deepEqual(waited.structuredContent, {
      operationId: 'op-1',
      threadId: 't-1',
      status: 'completed',
      assistant: 'answer',
    })
    assert.deepEqual(calls, [
      'create:chatgpt:::agent',
      'create:gemini:3.1-pro:extended:chat',
      'send:t-1:hello',
      'wait:op-1:2000',
    ])
  } finally {
    await client.close()
    await server.stop()
  }
})

test('PortalMcpServer returns tool errors as MCP error results', async () => {
  const handlers = createHandlers()
  handlers.getThread = async () => {
    throw new Error('Unknown thread: missing')
  }
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers,
  })
  await server.start()
  const client = await connectClient(server.address()!)

  try {
    const result = await client.callTool({
      name: 'portal_get_thread',
      arguments: { threadId: 'missing' },
    })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Unknown thread: missing' },
    ])
  } finally {
    await client.close()
    await server.stop()
  }
})

test('PortalMcpServer enforces only non-empty configured tokens', async () => {
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'secret',
    handlers: createHandlers(),
  })
  await server.start()
  try {
    assert.equal(server.status().auth, true)
    const unauthorized = await fetch(server.address()!, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: initializeRequest(),
    })
    assert.equal(unauthorized.status, 401)

    const client = await connectClient(server.address()!, 'secret')
    try {
      assert.equal((await client.listTools()).tools.length, 9)
    } finally {
      await client.close()
    }
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer allows non-loopback listeners with an empty token', async () => {
  const server = new PortalMcpServer({
    host: '0.0.0.0',
    port: 0,
    token: '',
    handlers: createHandlers(),
  })
  await server.start()
  try {
    assert.equal(server.status().auth, false)
    const client = await connectClient(
      server.address()!.replace('0.0.0.0', '127.0.0.1')
    )
    try {
      assert.equal((await client.listTools()).tools.length, 9)
    } finally {
      await client.close()
    }
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer preserves whitespace as an enabled token', async () => {
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: '   ',
    handlers: createHandlers(),
  })
  await server.start()
  try {
    assert.equal(server.token(), '   ')
    assert.equal(server.status().auth, true)
    const response = await fetch(server.address()!, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: initializeRequest(),
    })
    assert.equal(response.status, 401)
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer rejects browser origins and unsupported methods', async () => {
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(),
  })
  await server.start()
  try {
    const origin = await fetch(server.address()!, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Origin: 'https://example.com',
      },
      body: initializeRequest(),
    })
    assert.equal(origin.status, 403)

    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(server.address()!, { method })
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'POST')
    }
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer maps HTTP parsing and size errors at the protocol boundary', async () => {
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(),
    bodyLimitBytes: 64,
  })
  await server.start()
  try {
    const malformed = await fetch(server.address()!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(await malformed.json(), {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error.' },
      id: null,
    })

    const oversized = await fetch(server.address()!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(100) }),
    })
    assert.equal(oversized.status, 413)
    assert.deepEqual(await oversized.json(), {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Request body is too large.' },
      id: null,
    })

    const unsupported = await fetch(server.address()!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<request />',
    })
    assert.equal(unsupported.status, 415)
    assert.deepEqual(await unsupported.json(), {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Unsupported media type.' },
      id: null,
    })
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer bounds stop when a request handler ignores cancellation', async () => {
  const handlers = createHandlers()
  const requestEntered = deferred()
  handlers.createThread = async () => {
    requestEntered.resolve()
    return await new Promise(() => {})
  }
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers,
    closeTimeoutMs: 10,
  })
  await server.start()
  const client = await connectClient(server.address()!)
  const call = client.callTool({
    name: 'portal_create_thread',
    arguments: { provider: 'chatgpt' },
  })

  await requestEntered.promise
  const startedAt = Date.now()
  await server.stop()
  assert.ok(Date.now() - startedAt < 500)

  await call.catch(() => {})
  await client.close().catch(() => {})
})

test('PortalMcpServer can restart and runs its stop callback', async () => {
  let stops = 0
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(),
    onStop: async () => {
      stops += 1
    },
  })

  await server.start()
  await server.stop()
  await server.start()
  await server.stop()

  assert.equal(stops, 2)
})

test('PortalMcpServer serializes concurrent lifecycle operations', async () => {
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(),
  })

  await Promise.all([server.start(), server.start(), server.start()])
  assert.equal(server.status().running, true)

  await Promise.all([server.stop(), server.stop()])
  assert.equal(server.status().running, false)

  await Promise.all([server.start(), server.stop()])
  assert.deepEqual(server.status(), {
    running: false,
    address: null,
    auth: false,
  })
})

test('PortalMcpServer queues a restart behind an in-progress stop', async () => {
  const stopEntered = deferred()
  const releaseStop = deferred()
  let stops = 0
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(),
    onStop: async () => {
      stops += 1
      if (stops === 1) {
        stopEntered.resolve()
        await releaseStop.promise
      }
    },
  })

  await server.start()
  const stop = server.stop()
  await stopEntered.promise
  assert.equal(server.status().running, true)
  assert.notEqual(server.status().address, null)

  let restarted = false
  const restart = server.start().then(() => {
    restarted = true
  })
  await Promise.resolve()
  assert.equal(restarted, false)

  releaseStop.resolve()
  await Promise.all([stop, restart])
  try {
    assert.equal(server.status().running, true)
    const client = await connectClient(server.address()!)
    await client.close()
  } finally {
    await server.stop()
  }
})

test('PortalMcpServer reports an occupied port and can retry after failure', async () => {
  const blocker = await occupyTcpPort()
  const server = new PortalMcpServer({
    host: '127.0.0.1',
    port: blocker.port,
    token: null,
    handlers: createHandlers(),
  })

  try {
    await assert.rejects(server.start(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE')
      assert.equal(
        error.message,
        `MCP Server could not listen on 127.0.0.1:${blocker.port}: address is already in use.`
      )
      assert.ok(error.cause instanceof Error)
      return true
    })
    assert.deepEqual(server.status(), {
      running: false,
      address: null,
      auth: false,
    })
  } finally {
    await closeTcpServer(blocker.server)
  }

  await server.start()
  try {
    const client = await connectClient(server.address()!)
    await client.close()
  } finally {
    await server.stop()
  }
})

async function connectClient(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: 'portal-mcp-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(token === undefined
      ? {}
      : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  })
  if (!isTransport(transport)) {
    throw new Error('MCP SDK returned an invalid test transport.')
  }
  await client.connect(transport)
  return client
}

function isTransport(value: unknown): value is Transport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    typeof value.start === 'function' &&
    'send' in value &&
    typeof value.send === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  )
}

function initializeRequest(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  })
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function occupyTcpPort(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return { server, port: address.port }
}

async function closeTcpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}
