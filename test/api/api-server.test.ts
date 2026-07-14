import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApiHttpError,
  PortalApiServer,
  type ApiHandlers,
} from '../../src/api/api-server.ts'

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
    addSkill: async (input) => input,
    setSkillEnabled: async (name, enabled) => ({ name, enabled }),
    removeSkill: async (name) => ({ name, removed: true }),
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

    const unauthorized = await fetch(`${address}/v1/status`)
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), {
      error: { code: 'AUTH_INVALID', message: 'Invalid API token.' },
    })

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
