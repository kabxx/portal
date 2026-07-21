import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:net'

import {
  ApiEventHub,
  ApiHttpError,
  PortalApiServer,
  type ApiHandlers,
} from '../../src/api/api-server.ts'
import { normalizeListenerStartError } from '../../src/shared/listener-errors.ts'
import {
  McpConfigError,
  McpDuplicateNameError,
} from '../../src/mcp/mcp-config.ts'

class FakeSseResponse extends EventEmitter {
  public readonly writes: string[] = []
  public writableEnded = false
  public destroyed = false
  public endCalls = 0
  public failWrites = false

  public write(chunk: string): boolean {
    if (this.failWrites) {
      throw new Error('disconnected')
    }
    this.writes.push(chunk)
    return true
  }

  public end(): this {
    this.endCalls += 1
    this.writableEnded = true
    return this
  }
}

function createHandlers(calls: string[], includeReload = true): ApiHandlers {
  return {
    status: () => ({ ok: true }),
    providers: () => ['deepseek'],
    listThreads: () => [{ id: 't-1' }],
    getThread: (threadId) => {
      if (threadId !== 't-1') {
        throw new ApiHttpError(404, 'THREAD_NOT_FOUND', 'Unknown thread.')
      }
      return { id: threadId }
    },
    createThread: async (input) => ({ id: 't-1', ...input }),
    resumeThread: async (input) => ({ id: 't-1', ...input }),
    closeThread: async (threadId) => ({ closed: true, threadId }),
    submitMessage: async (threadId, input) => ({
      accepted: true,
      status: 'busy',
      threadId,
      input,
    }),
    cancelMessage: async (threadId) => ({ cancelled: true, threadId }),
    ...(includeReload
      ? {
          reloadThread: async (threadId: string) => ({
            accepted: true,
            status: 'busy',
            action: 'reload',
            operationId: 'op-reload-1',
            threadId,
          }),
        }
      : {}),
    activateSkill: async (threadId, name) => ({
      accepted: true,
      status: 'busy',
      threadId,
      skill: name,
    }),
    listCapabilities: async () => ({ capabilities: [] }),
    setCapability: async (_threadId, name, state) => ({ name, state }),
    clearCapability: async (_threadId, name) => ({ name, cleared: true }),
    listSkills: async () => ({ skills: [], issues: [] }),
    addSkill: async () => ({
      skills: [
        {
          name: 'alpha-skill',
          description: 'Alpha skill.',
          directory: 'C:\\skills\\alpha-skill',
        },
        {
          name: 'beta-skill',
          description: 'Beta skill.',
          directory: 'C:\\skills\\beta-skill',
        },
      ],
      warnings: [],
    }),
    setSkillEnabled: async (name, enabled) => ({ name, enabled }),
    removeSkill: async (name) => ({
      name,
      removed: true,
      warnings: ['cleanup warning'],
    }),
    listMcpServers: async () => ({ servers: [], issues: [] }),
    addMcpServer: async (name) => {
      calls.push(`add:${name}`)
      return { name, added: true }
    },
    setMcpServer: async (name) => {
      calls.push(`set:${name}`)
      return { name, updated: true }
    },
    removeMcpServer: async (name) => ({ name, removed: true }),
    setMcpServerEnabled: async (name, enabled) => ({ name, enabled }),
    listMcpResources: async () => ({ items: [], issues: [] }),
    listMcpPrompts: async () => ({ items: [], issues: [] }),
  }
}

test('PortalApiServer authenticates v1 routes and preserves thread-scoped results', async () => {
  const calls: string[] = []
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: 'secret',
    handlers: createHandlers(calls),
  })

  await server.start()
  try {
    const address = server.address()
    assert.notEqual(address, null)

    const health = await fetch(`${address}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'portal',
      apiVersion: 'v1',
    })

    const queriedHealth = await fetch(`${address}/health?probe=1`)
    assert.equal(queriedHealth.status, 200)
    assert.deepEqual(await queriedHealth.json(), {
      ok: true,
      service: 'portal',
      apiVersion: 'v1',
    })

    const unauthorized = await fetch(`${address}/v1/status?probe=1`)
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), {
      error: { code: 'AUTH_INVALID', message: 'Invalid API token.' },
    })

    const lowercaseBearer = await fetch(`${address}/v1/status`, {
      headers: { Authorization: 'bearer secret' },
    })
    assert.equal(lowercaseBearer.status, 200)

    const headers = {
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }
    const message = await fetch(`${address}/v1/threads/t-1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: 'hello' }),
    })
    assert.equal(message.status, 202)
    assert.deepEqual(await message.json(), {
      accepted: true,
      status: 'busy',
      threadId: 't-1',
      input: 'hello',
    })

    const skill = await fetch(`${address}/v1/threads/t-1/skill`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'review' }),
    })
    assert.equal(skill.status, 202)
    assert.deepEqual(await skill.json(), {
      accepted: true,
      status: 'busy',
      threadId: 't-1',
      skill: 'review',
    })

    const skillCollection = await fetch(`${address}/v1/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'C:\\skill-collection' }),
    })
    assert.equal(skillCollection.status, 201)
    assert.deepEqual(await skillCollection.json(), {
      skills: [
        {
          name: 'alpha-skill',
          description: 'Alpha skill.',
          directory: 'C:\\skills\\alpha-skill',
        },
        {
          name: 'beta-skill',
          description: 'Beta skill.',
          directory: 'C:\\skills\\beta-skill',
        },
      ],
      warnings: [],
    })

    const removedSkill = await fetch(`${address}/v1/skills/beta-skill`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret' },
    })
    assert.equal(removedSkill.status, 200)
    assert.deepEqual(await removedSkill.json(), {
      name: 'beta-skill',
      removed: true,
      warnings: ['cleanup warning'],
    })

    const reload = await fetch(`${address}/v1/threads/t-1/reload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    })
    assert.equal(reload.status, 202)
    assert.deepEqual(await reload.json(), {
      accepted: true,
      status: 'busy',
      action: 'reload',
      operationId: 'op-reload-1',
      threadId: 't-1',
    })

    const mcp = await fetch(`${address}/v1/mcp/servers/local`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        config: { transport: 'streamable-http', url: 'http://localhost/mcp' },
      }),
    })
    assert.equal(mcp.status, 200)
    assert.deepEqual(calls, ['set:local'])
  } finally {
    await server.stop()
  }
})

test('PortalApiServer routes capability list, toggle updates, and clears', async () => {
  const calls: string[] = []
  const handlers = createHandlers([])
  handlers.listCapabilities = async (threadId) => {
    calls.push(`list:${threadId}`)
    return {
      provider: 'deepseek',
      capabilities: [{ name: 'search', state: 'off' }],
    }
  }
  handlers.setCapability = async (threadId, name, state) => {
    calls.push(`set:${threadId}:${name}:${state}`)
    return { name, state }
  }
  handlers.clearCapability = async (threadId, name) => {
    calls.push(`clear:${threadId}:${name}`)
    return { name, cleared: true }
  }
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers,
  })

  await server.start()
  try {
    const address = server.address()
    const listed = await fetch(`${address}/v1/threads/t-1/capabilities`)
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), {
      provider: 'deepseek',
      capabilities: [{ name: 'search', state: 'off' }],
    })

    const updated = await fetch(
      `${address}/v1/threads/t-1/capabilities/search`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'off' }),
      }
    )
    assert.equal(updated.status, 200)
    assert.deepEqual(await updated.json(), {
      name: 'search',
      state: 'off',
    })

    const cleared = await fetch(
      `${address}/v1/threads/t-1/capabilities/search`,
      { method: 'DELETE' }
    )
    assert.equal(cleared.status, 200)
    assert.deepEqual(await cleared.json(), {
      name: 'search',
      cleared: true,
    })
    assert.deepEqual(calls, [
      'list:t-1',
      'set:t-1:search:off',
      'clear:t-1:search',
    ])
  } finally {
    await server.stop()
  }
})

test('PortalApiServer enforces the configured request body limit', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
    bodyLimitBytes: 16,
  })

  await server.start()
  try {
    const response = await fetch(`${server.address()}/v1/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', padding: 'x'.repeat(32) }),
    })
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'REQUEST_TOO_LARGE',
        message: 'Request body is too large.',
      },
    })
  } finally {
    await server.stop()
  }
})

test('PortalApiServer can restart after stopping', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
  })

  await server.start()
  try {
    const firstAddress = server.address()
    assert.notEqual(firstAddress, null)
    const firstHealth = await fetch(`${firstAddress}/health`)
    assert.equal(firstHealth.status, 200)

    await server.stop()
    assert.equal(server.isStarted, false)
    assert.equal(server.address(), null)

    await server.start()
    const secondAddress = server.address()
    assert.notEqual(secondAddress, null)
    const secondHealth = await fetch(`${secondAddress}/health`)
    assert.equal(secondHealth.status, 200)
  } finally {
    await server.stop()
  }
})

test('PortalApiServer serializes concurrent lifecycle operations', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
  })

  await Promise.all([server.start(), server.start(), server.start()])
  assert.equal(server.status().running, true)

  await Promise.all([server.stop(), server.stop()])
  assert.deepEqual(server.status(), {
    running: false,
    address: null,
    auth: false,
  })

  await Promise.all([server.start(), server.stop()])
  assert.equal(server.status().running, false)

  await server.start()
  await Promise.all([server.stop(), server.start()])
  try {
    assert.equal(server.status().running, true)
    assert.equal((await fetch(`${server.address()}/health`)).status, 200)
  } finally {
    await server.stop()
  }
})

test('PortalApiServer reports an occupied port and can retry after failure', async () => {
  const blocker = await occupyTcpPort()
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: blocker.port,
    token: null,
    handlers: createHandlers([]),
  })

  try {
    await assert.rejects(server.start(), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE')
      assert.equal(
        error.message,
        `HTTP API could not listen on 127.0.0.1:${blocker.port}: address is already in use.`
      )
      assert.ok(error.cause instanceof Error)
      return true
    })
    assert.equal(server.status().running, false)
    assert.equal(server.address(), null)
  } finally {
    await closeTcpServer(blocker.server)
  }

  await server.start()
  try {
    assert.equal((await fetch(`${server.address()}/health`)).status, 200)
  } finally {
    await server.stop()
  }
})

test('listener errors format IPv6 endpoints and preserve unrecognized errors', () => {
  const cause = Object.assign(new Error('denied'), { code: 'EACCES' })
  const normalized = normalizeListenerStartError(cause, 'HTTP API', '::1', 8787)
  assert.ok(normalized instanceof Error)
  assert.equal(
    normalized.message,
    'HTTP API could not listen on [::1]:8787: permission denied.'
  )
  assert.equal((normalized as NodeJS.ErrnoException).code, 'EACCES')
  assert.equal(normalized.cause, cause)

  const other = Object.assign(new Error('network failed'), { code: 'EIO' })
  assert.equal(
    normalizeListenerStartError(other, 'HTTP API', '::1', 8787),
    other
  )
})

test('PortalApiServer supports SSE after a stop and restart', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
    sseHeartbeatMs: 60_000,
  })

  await server.start()
  let reader = await connectSse(server)
  await reader.cancel()
  await server.stop()

  await server.start()
  try {
    reader = await connectSse(server)
    server.eventHub.publish('t-1', {
      type: 'status',
      data: { phase: 'restarted' },
    })
    const event = await reader.read()
    assert.match(new TextDecoder().decode(event.value), /"phase":"restarted"/)
  } finally {
    await reader.cancel().catch(() => {})
    await server.stop()
  }
})

test('PortalApiServer allows non-loopback listeners without authentication', async () => {
  const server = new PortalApiServer({
    host: '0.0.0.0',
    port: 0,
    token: '',
    handlers: createHandlers([]),
  })

  await server.start()
  try {
    assert.deepEqual(server.status(), {
      running: true,
      address: server.address(),
      auth: false,
    })
    const address = server.address()!.replace('0.0.0.0', '127.0.0.1')
    const response = await fetch(`${address}/v1/status`)
    assert.equal(response.status, 200)
  } finally {
    await server.stop()
  }
})

test('PortalApiServer treats whitespace as an enabled token', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: '   ',
    handlers: createHandlers([]),
  })

  await server.start()
  try {
    assert.equal(server.status().auth, true)
    const response = await fetch(`${server.address()}/v1/status`)
    assert.equal(response.status, 401)
  } finally {
    await server.stop()
  }
})

test('PortalApiServer reports unsupported thread reload handlers', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([], false),
  })

  await server.start()
  try {
    const address = server.address()
    assert.notEqual(address, null)
    const response = await fetch(`${address}/v1/threads/t-1/reload`, {
      method: 'POST',
    })
    assert.equal(response.status, 501)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'NOT_SUPPORTED',
        message: 'Internal server error.',
      },
    })
  } finally {
    await server.stop()
  }
})

test('PortalApiServer rejects an empty MCP server request as invalid', async () => {
  const calls: string[] = []
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers(calls),
  })

  await server.start()
  try {
    const address = server.address()
    assert.notEqual(address, null)
    const response = await fetch(`${address}/v1/mcp/servers`, {
      method: 'POST',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request body must be an object.',
      },
    })
    assert.deepEqual(calls, [])
  } finally {
    await server.stop()
  }
})

test('PortalApiServer rejects empty thread create and resume bodies', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
  })

  await server.start()
  try {
    for (const route of ['/v1/threads', '/v1/threads/resume']) {
      const response = await fetch(`${server.address()}${route}`, {
        method: 'POST',
      })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request body must be an object.',
        },
      })
    }
  } finally {
    await server.stop()
  }
})

test('PortalApiServer maps invalid and duplicate MCP configurations', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: {
      ...createHandlers([]),
      addMcpServer: async () => {
        throw new McpConfigError('transport is required')
      },
      setMcpServer: async () => {
        throw new McpDuplicateNameError('local')
      },
    },
  })

  await server.start()
  try {
    const address = server.address()
    const invalid = await fetch(`${address}/v1/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'local' }),
    })
    assert.equal(invalid.status, 400)
    assert.deepEqual(await invalid.json(), {
      error: {
        code: 'INVALID_MCP_CONFIG',
        message: 'transport is required',
      },
    })

    const duplicate = await fetch(`${address}/v1/mcp/servers/local`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { transport: 'streamable-http', url: 'https://example.com' },
      }),
    })
    assert.equal(duplicate.status, 409)
    assert.deepEqual(await duplicate.json(), {
      error: {
        code: 'MCP_ALREADY_EXISTS',
        message: 'MCP server already exists: local',
      },
    })
  } finally {
    await server.stop()
  }
})

test('PortalApiServer broadcasts one thread event to multiple SSE clients', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
  })

  await server.start()
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  try {
    const address = server.address()
    assert.notEqual(address, null)
    const responses = await Promise.all([
      fetch(`${address}/v1/threads/t-1/events`),
      fetch(`${address}/v1/threads/t-1/events`),
    ])
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.notEqual(response.body, null)
      const reader = response.body!.getReader()
      readers.push(reader)
      const connected = await reader.read()
      assert.match(new TextDecoder().decode(connected.value), /: connected/)
    }

    server.eventHub.publish('t-1', {
      type: 'assistant.delta',
      data: { text: 'hello' },
    })

    for (const reader of readers) {
      const event = await reader.read()
      const text = new TextDecoder().decode(event.value)
      assert.match(text, /event: assistant\.delta/)
      assert.match(text, /"threadId":"t-1"/)
      assert.match(text, /"text":"hello"/)
    }

    server.eventHub.publish('t-1', {
      type: 'assistant.reset',
      data: {},
    })

    for (const reader of readers) {
      const event = await reader.read()
      const text = new TextDecoder().decode(event.value)
      assert.match(text, /event: assistant\.reset/)
      assert.match(text, /"threadId":"t-1"/)
    }

    server.eventHub.publish('t-1', {
      type: 'thread.action',
      data: {
        operationId: 'op-reload-1',
        action: 'reload',
        phase: 'completed',
      },
    })

    for (const reader of readers) {
      const event = await reader.read()
      const text = new TextDecoder().decode(event.value)
      assert.match(text, /event: thread\.action/)
      assert.match(text, /"operationId":"op-reload-1"/)
      assert.match(text, /"action":"reload"/)
      assert.match(text, /"phase":"completed"/)
    }
  } finally {
    for (const reader of readers) {
      await reader.cancel().catch(() => {})
    }
    await server.stop()
  }
})

test('ApiEventHub cleans up closed subscribers and releases thread sequences', () => {
  const hub = new ApiEventHub(60_000)
  const response = new FakeSseResponse()
  const remove = hub.subscribe('t-1', response)

  hub.publish('t-1', { type: 'status', data: { phase: 'first' } })
  assert.match(response.writes[1] ?? '', /^id: 1\n/)

  response.destroyed = true
  response.emit('close')
  hub.publish('t-1', { type: 'status', data: { phase: 'ignored' } })
  assert.equal(response.writes.length, 2)

  const replacement = new FakeSseResponse()
  hub.subscribe('t-1', replacement)
  hub.publish('t-1', { type: 'status', data: { phase: 'replacement' } })
  assert.match(replacement.writes[1] ?? '', /^id: 1\n/)

  remove()
  remove()
  hub.close()
  hub.close()
})

test('ApiEventHub publishes thread.closed before ending thread subscribers', () => {
  const hub = new ApiEventHub(60_000)
  const response = new FakeSseResponse()
  hub.subscribe('t-1', response)

  hub.closeThread('t-1', { reason: 'provider_page_closed' })

  assert.match(response.writes[1] ?? '', /event: thread\.closed/)
  assert.match(response.writes[1] ?? '', /"reason":"provider_page_closed"/)
  assert.equal(response.endCalls, 1)

  hub.publish('t-1', { type: 'status', data: { phase: 'ignored' } })
  assert.equal(response.writes.length, 2)

  const replacement = new FakeSseResponse()
  hub.subscribe('t-1', replacement)
  hub.publish('t-1', { type: 'status', data: { phase: 'replacement' } })
  assert.match(replacement.writes[1] ?? '', /^id: 1\n/)
  hub.close()
})

test('ApiEventHub rolls back a subscriber when the connected write fails', () => {
  const hub = new ApiEventHub(60_000)
  const response = new FakeSseResponse()
  response.failWrites = true

  assert.doesNotThrow(() => hub.subscribe('t-1', response))
  assert.equal(response.endCalls, 1)

  response.failWrites = false
  hub.publish('t-1', { type: 'status', data: { phase: 'ignored' } })
  assert.deepEqual(response.writes, [])
  hub.close()
})

test('PortalApiServer removes an SSE subscriber after HTTP cancellation', async () => {
  const server = new PortalApiServer({
    host: '127.0.0.1',
    port: 0,
    token: null,
    handlers: createHandlers([]),
    sseHeartbeatMs: 60_000,
  })

  await server.start()
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  try {
    const first = await fetch(`${server.address()}/v1/threads/t-1/events`)
    const firstReader = first.body!.getReader()
    readers.push(firstReader)
    await firstReader.read()
    await firstReader.cancel()
    await new Promise<void>((resolve) => setImmediate(resolve))

    const replacement = await fetch(`${server.address()}/v1/threads/t-1/events`)
    const replacementReader = replacement.body!.getReader()
    readers.push(replacementReader)
    await replacementReader.read()

    server.eventHub.publish('t-1', {
      type: 'status',
      data: { phase: 'replacement' },
    })
    const event = await replacementReader.read()
    assert.match(new TextDecoder().decode(event.value), /^id: 1\n/m)
  } finally {
    for (const reader of readers) {
      await reader.cancel().catch(() => {})
    }
    await server.stop()
  }
})

async function connectSse(
  server: PortalApiServer
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`${server.address()}/v1/threads/t-1/events`)
  assert.equal(response.status, 200)
  assert.notEqual(response.body, null)
  const reader = response.body!.getReader()
  const connected = await reader.read()
  assert.match(new TextDecoder().decode(connected.value), /: connected/)
  return reader
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
