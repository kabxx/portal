import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import type { AbortOptions } from '../../src/runtime/runtime-cancellation.ts'
import {
  McpConnectionError,
  McpToolOutcomeUnknownError,
  type McpConnection,
  type McpPromptDefinition,
  type McpPromptReadResult,
  type McpResourceDefinition,
  type McpResourceReadResult,
  type McpToolDefinition,
} from '../../src/mcp/mcp-connection.ts'
import { McpLibrary } from '../../src/mcp/mcp-library.ts'
import {
  createThreadMcpSession,
  ThreadMcpSession,
} from '../../src/mcp/thread-mcp-session.ts'
import {
  renderMcpResourceAttachment,
  renderMcpToolResult,
} from '../../src/mcp/mcp-content.ts'

class FakeMcpConnection implements McpConnection {
  public available = true
  public readonly maxOutputChars = 10_000
  public closeCalls = 0
  public callResult: unknown = { content: [{ type: 'text', text: 'done' }] }
  public callError: Error | null = null
  public resources: readonly McpResourceDefinition[] = []
  public resourceResult: McpResourceReadResult = { contents: [] }
  public prompts: readonly McpPromptDefinition[] = []
  public promptResult: McpPromptReadResult = { messages: [] }

  public constructor(
    public readonly name: string,
    private readonly tools: readonly McpToolDefinition[] = []
  ) {}

  public listCachedTools() {
    return this.tools
  }

  public getCachedTool(name: string) {
    return this.tools.find((tool) => tool.name === name) ?? null
  }

  public async callTool(
    _name: string,
    _args: Record<string, unknown>,
    _options: AbortOptions = {}
  ) {
    if (this.callError !== null) {
      throw this.callError
    }
    return this.callResult
  }

  public async listResources(_options: AbortOptions = {}) {
    return this.resources
  }

  public async readResource(_uri: string, _options: AbortOptions = {}) {
    return this.resourceResult
  }

  public async listPrompts(_options: AbortOptions = {}) {
    return this.prompts
  }

  public async getPrompt(
    _name: string,
    _args: Record<string, string>,
    _options: AbortOptions = {}
  ) {
    return this.promptResult
  }

  public async close() {
    this.closeCalls += 1
    this.available = false
  }
}

const ECHO_TOOL: McpToolDefinition = {
  name: 'echo',
  description: 'Echo input.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
}

test('thread MCP startup keeps successful servers and warns for failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-session-'))
  const library = new McpLibrary(path.join(root, 'config.yaml'))
  await library.add('good', {
    transport: 'streamable-http',
    url: 'https://good.example/mcp',
  })
  await library.add('bad', {
    transport: 'streamable-http',
    url: 'https://bad.example/mcp',
  })
  await library.add('disabled', {
    transport: 'stdio',
    command: 'node',
    enabled: false,
  })
  const connected: string[] = []
  const warnings: string[] = []

  try {
    const session = await createThreadMcpSession(library, {
      connector: async (name) => {
        connected.push(name)
        if (name === 'bad') {
          throw new McpConnectionError('connection refused')
        }
        return new FakeMcpConnection(name, [ECHO_TOOL])
      },
      onWarning: async (warning) => {
        warnings.push(warning.markdown)
      },
    })

    assert.deepEqual(connected.sort(), ['bad', 'good'])
    assert.match(session.prompt ?? '', /# MCP Servers/)
    assert.match(session.prompt ?? '', /## good/)
    assert.doesNotMatch(session.prompt ?? '', /bad|disabled/)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /connection refused/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('thread MCP tools use exact lookup and distinguish unknown outcomes', async () => {
  const connection = new FakeMcpConnection('server', [ECHO_TOOL])
  const session = new ThreadMcpSession(new Map([['server', connection]]))

  const definition = session.searchTool('server', 'echo')
  assert.equal(definition.outcome, 'success')
  assert.equal(definition.result.server, 'server')
  assert.equal(definition.result.tool, 'echo')
  assert.deepEqual(definition.result.inputSchema, {
    type: 'object',
    properties: { value: { type: 'string' } },
  })
  assert.match(
    session.searchTool('server', 'missing').displayText,
    /unavailable/i
  )
  assert.equal(
    session.searchTool('server', 'missing').result.message,
    "The requested MCP target is not available in this thread's current session."
  )
  const success = await session.callTool('server', 'echo', {})
  assert.equal(success.outcome, 'success')
  assert.deepEqual(success.result.content, [{ type: 'text', text: 'done' }])

  connection.callResult = {
    isError: true,
    content: [{ type: 'text', text: 'validation failed' }],
  }
  const failed = await session.callTool('server', 'echo', {})
  assert.equal(failed.outcome, 'error')
  assert.equal(failed.result.isError, true)
  assert.deepEqual(failed.result.content, [
    { type: 'text', text: 'validation failed' },
  ])
  assert.match(failed.displayText, /returned an error/i)

  connection.callError = new McpToolOutcomeUnknownError(
    'The MCP request timed out.'
  )
  const unknown = await session.callTool('server', 'echo', {})
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.result.reason, 'The MCP request timed out.')
  assert.equal(unknown.result.retry, false)
  assert.match(unknown.displayText, /Do not retry automatically/)
})

test('resource and prompt attachments are separate Markdown turns with random boundaries', async () => {
  const connection = new FakeMcpConnection('server', [ECHO_TOOL])
  connection.resourceResult = {
    contents: [{ uri: 'file:///notes.txt', text: 'REFERENCE BODY' }],
  }
  connection.promptResult = {
    messages: [
      { role: 'user', content: { type: 'text', text: 'Do the task.' } },
      { role: 'assistant', content: { type: 'text', text: 'Prior reply.' } },
    ],
  }
  const session = new ThreadMcpSession(new Map([['server', connection]]))

  const resource = await session.createResourceAttachment(
    'server',
    'file:///notes.txt'
  )
  const prompt = await session.createPromptAttachment('server', 'review', {
    focus: 'correctness',
  })

  assert.match(resource, /^# MCP Resource Attachment/)
  assert.match(resource, /MCP_RESOURCE_[0-9a-f-]+/)
  assert.match(resource, /REFERENCE BODY/)
  assert.doesNotMatch(resource, /<resource>/)
  assert.match(prompt, /^# MCP Prompt Attachment/)
  assert.match(prompt, /\[USER\]\nDo the task\./)
  assert.match(prompt, /\[ASSISTANT\]\nPrior reply\./)
  assert.doesNotMatch(prompt, /<prompt>/)
})

test('closing a thread MCP session closes each connection once', async () => {
  const first = new FakeMcpConnection('first')
  const second = new FakeMcpConnection('second')
  const session = new ThreadMcpSession(
    new Map([
      ['first', first],
      ['second', second],
    ])
  )

  await session.close()
  await session.close()

  assert.equal(first.closeCalls, 1)
  assert.equal(second.closeCalls, 1)
})

test('each thread MCP session receives independent connections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-isolation-'))
  const library = new McpLibrary(path.join(root, 'config.yaml'))
  await library.add('server', {
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
  })
  const created: FakeMcpConnection[] = []
  const connector = async (name: string) => {
    const connection = new FakeMcpConnection(name, [ECHO_TOOL])
    created.push(connection)
    return connection
  }

  try {
    const first = await createThreadMcpSession(library, { connector })
    const second = await createThreadMcpSession(library, { connector })

    assert.equal(created.length, 2)
    assert.notEqual(created[0], created[1])
    await first.close()
    assert.equal(created[0]?.available, false)
    assert.equal(created[1]?.available, true)
    assert.match(second.prompt ?? '', /"echo"/)
    await second.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP content limits preserve attachment boundaries and exact size caps', () => {
  const attachment = renderMcpResourceAttachment(
    'server',
    'memo://large',
    { contents: [{ uri: 'memo://large', text: 'x'.repeat(2_000) }] },
    600
  )
  const boundary = attachment.match(/MCP_RESOURCE_[0-9a-f-]+/)?.[0]

  assert.equal(attachment.length, 600)
  assert.ok(boundary)
  assert.equal(attachment.split(boundary).length - 1, 2)
  assert.match(attachment, /# MCP Attachment Truncated/)
  const rendered = renderMcpToolResult(
    { content: [{ type: 'text', text: 'x'.repeat(100) }] },
    100
  )
  assert.equal(rendered.isError, false)
  assert.equal(rendered.result.truncated, true)
  assert.ok(JSON.stringify(rendered.result).length <= 100)
})

test('thread MCP startup closes successful connections if warning rendering fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-warning-'))
  const library = new McpLibrary(path.join(root, 'config.yaml'))
  await library.add('good', {
    transport: 'stdio',
    command: 'node',
  })
  await library.add('bad', {
    transport: 'stdio',
    command: 'missing',
  })
  const good = new FakeMcpConnection('good')

  try {
    await assert.rejects(
      createThreadMcpSession(library, {
        connector: async (name) => {
          if (name === 'bad') {
            throw new McpConnectionError('failed')
          }
          return good
        },
        onWarning: async () => {
          throw new Error('UI failed')
        },
      }),
      /UI failed/
    )
    assert.equal(good.closeCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
