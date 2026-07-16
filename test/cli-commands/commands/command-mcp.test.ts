import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { McpCommand } from '../../../src/cli-commands/commands/command-mcp.ts'
import { CommandRegistry } from '../../../src/cli-commands/core/command-registry.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import type { McpConnection } from '../../../src/mcp/mcp-connection.ts'
import { McpLibrary } from '../../../src/mcp/mcp-library.ts'
import { ThreadMcpSession } from '../../../src/mcp/thread-mcp-session.ts'
import type { SkillLibrary } from '../../../src/skills/skill-library.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../../../src/threads/thread-manager.ts'
import { ThreadStore } from '../../../src/threads/thread-store.ts'
import { createFakeRuntime } from '../../helpers/fakes.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'
import { parseYamlRecord } from '../../helpers/yaml.ts'

async function createMcpCommandContext(root: string) {
  const ui = new TerminalController()
  const threadManager = new ThreadManager()
  const mcpLibrary = new McpLibrary(path.join(root, 'config.yaml'))
  const registry = new CommandRegistry([McpCommand])
  const submitted: Array<{ input: string; displayInput?: string }> = []
  const context: CliCommandContext = {
    readline: {} as CliCommandContext['readline'],
    threadManager,
    threadStore: new ThreadStore(path.join(root, 'threads.db')),
    skillLibrary: {} as SkillLibrary,
    mcpLibrary,
    ui,
    browserProfileDir: path.join(root, 'profile'),
    providers: [],
    resolveProvider: () => null,
    createThread: async () => {},
    resumeThread: async () => {},
    closeThread: async (threadId) => await threadManager.closeThread(threadId),
    addSkill: async () => {
      throw new Error('not used')
    },
    submitThreadInput: async (input, displayInput) => {
      submitted.push({
        input,
        ...(displayInput !== undefined ? { displayInput } : {}),
      })
    },
    listCommands: () => registry.list(),
  }
  return { context, mcpLibrary, registry, submitted, threadManager, ui }
}

test('McpCommand adds minimal HTTP and stdio server configs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-command-'))
  const { context, registry } = await createMcpCommandContext(root)

  try {
    await registry.execute(
      '/mcp add remote https://example.com/mcp --header "Authorization: Bearer ${env:MCP_TOKEN}"',
      context
    )
    await registry.execute('/mcp add local -- npx -y example-server', context)
    const document = parseYamlRecord(
      await readFile(path.join(root, 'config.yaml'), 'utf8')
    )

    assert.deepEqual(document.mcpServers, {
      local: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'example-server'],
      },
      remote: {
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer ${env:MCP_TOKEN}',
        },
      },
    })
    assert.match(
      latestTimelineEntry(context.ui)?.body ?? '',
      /Added and enabled/
    )
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('McpCommand manages configured servers and renders list state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-manage-'))
  const { context, mcpLibrary, registry } = await createMcpCommandContext(root)

  try {
    await registry.execute('/mcp list', context)
    assert.equal(
      latestTimelineEntry(context.ui)?.body,
      'No MCP servers configured.'
    )

    await registry.execute('/mcp add remote https://example.com/mcp', context)
    await registry.execute('/mcp disable remote', context)
    assert.match(
      latestTimelineEntry(context.ui)?.body ?? '',
      /Disabled remote for new threads/
    )
    assert.equal((await mcpLibrary.list()).servers[0]?.enabled, false)

    await registry.execute('/mcp list', context)
    assert.match(
      latestTimelineEntry(context.ui)?.body ?? '',
      /remote\s+streamable-http/
    )

    await registry.execute('/mcp enable remote', context)
    assert.match(
      latestTimelineEntry(context.ui)?.body ?? '',
      /Enabled remote for new threads/
    )
    assert.equal((await mcpLibrary.list()).servers[0]?.enabled, true)

    await registry.execute('/mcp remove remote', context)
    assert.match(latestTimelineEntry(context.ui)?.body ?? '', /Removed remote/)
    assert.deepEqual((await mcpLibrary.list()).servers, [])
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('McpCommand validates management arguments and HTTP headers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-validation-'))
  const { context, registry } = await createMcpCommandContext(root)

  async function expectMessage(input: string, pattern: RegExp) {
    await registry.execute(input, context)
    assert.match(latestTimelineEntry(context.ui)?.body ?? '', pattern)
  }

  try {
    await expectMessage('/mcp', /Subcommands:/)
    await expectMessage('/mcp unknown', /Unknown MCP subcommand/)
    await expectMessage('/mcp add', /Usage: \/mcp add/)
    await expectMessage('/mcp add remote', /Missing HTTP MCP URL/)
    await expectMessage('/mcp add local --', /Missing stdio command/)
    await expectMessage(
      '/mcp add remote https://example.com --unknown',
      /Unknown HTTP MCP option/
    )
    await expectMessage(
      '/mcp add remote https://example.com --header invalid',
      /--header requires "Name: value"/
    )
    await expectMessage(
      '/mcp add remote https://example.com --header "X-Test: one" --header "x-test: two"',
      /Duplicate HTTP header/
    )
    await expectMessage('/mcp enable', /Usage: \/mcp enable/)
    await expectMessage('/mcp disable missing', /Unknown MCP server/)
    await expectMessage('/mcp remove', /Usage: \/mcp remove/)
    await expectMessage('/mcp remove missing', /Unknown MCP server/)
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('McpCommand requires an active thread and configured MCP session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-session-'))
  const { context, registry, threadManager } =
    await createMcpCommandContext(root)

  try {
    await registry.execute('/mcp resource list', context)
    assert.equal(latestTimelineEntry(context.ui)?.body, 'No active thread.')

    threadManager.addThread({
      id: threadManager.createThreadId(),
      provider: 'chatgpt',
      runtime: createFakeRuntime(),
      createdAt: Date.now(),
    })

    await registry.execute('/mcp prompt list', context)
    assert.equal(
      latestTimelineEntry(context.ui)?.body,
      'MCP is not configured in this runtime.'
    )
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('McpCommand validates resource and prompt attachment arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-arguments-'))
  const { context, registry, threadManager } =
    await createMcpCommandContext(root)
  const session = new ThreadMcpSession(new Map())
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ mcpSession: session }),
    createdAt: Date.now(),
  })

  async function expectMessage(input: string, pattern: RegExp) {
    await registry.execute(input, context)
    assert.match(latestTimelineEntry(context.ui)?.body ?? '', pattern)
  }

  try {
    await expectMessage('/mcp resource', /Usage: \/mcp resource/)
    await expectMessage('/mcp resource attach server', /Usage:/)
    await expectMessage('/mcp prompt', /Usage: \/mcp prompt/)
    await expectMessage('/mcp prompt attach server', /Usage:/)
    await expectMessage(
      '/mcp prompt attach server review not-json',
      /Unexpected token/
    )
    await expectMessage(
      '/mcp prompt attach server review []',
      /Prompt arguments must be a JSON object/
    )
    await expectMessage(
      '/mcp prompt attach server review {"focus":1}',
      /Prompt argument focus must be a string/
    )
    await expectMessage('/mcp resource list', /No MCP resources found/)
    await expectMessage('/mcp prompt list', /No MCP prompts found/)
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('McpCommand attaches prompt and resource content as separate thread inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-attach-'))
  const { context, registry, submitted, threadManager } =
    await createMcpCommandContext(root)
  const connection = {
    name: 'server',
    available: true,
    maxOutputChars: 10_000,
    listCachedTools: () => [],
    getCachedTool: () => null,
    callTool: async () => ({ content: [] }),
    listResources: async () => [],
    readResource: async () => ({
      contents: [{ uri: 'memo://one', text: 'RESOURCE TEXT' }],
    }),
    listPrompts: async () => [],
    getPrompt: async () => ({
      messages: [
        { role: 'user', content: { type: 'text', text: 'Review this.' } },
      ],
    }),
    close: async () => {},
  } satisfies McpConnection
  const session = new ThreadMcpSession(new Map([['server', connection]]))
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ mcpSession: session }),
    createdAt: Date.now(),
  })

  try {
    await registry.execute(
      '/mcp prompt attach server review {"focus":"correctness"}',
      context
    )
    await registry.execute('/mcp resource attach server memo://one', context)

    assert.equal(submitted.length, 2)
    assert.match(submitted[0]?.input ?? '', /^# MCP Prompt Attachment/)
    assert.match(submitted[0]?.input ?? '', /"focus": "correctness"/)
    assert.equal(submitted[0]?.displayInput, '/mcp prompt attach server review')
    assert.match(submitted[1]?.input ?? '', /^# MCP Resource Attachment/)
    assert.match(submitted[1]?.input ?? '', /RESOURCE TEXT/)
    assert.equal(context.ui.getState().busy, false)
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})
