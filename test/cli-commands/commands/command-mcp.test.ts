import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parse as parseYaml } from 'yaml'

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
    const document = parseYaml(
      await readFile(path.join(root, 'config.yaml'), 'utf8')
    )

    assert.deepEqual(document.mcp, {
      connectionStrategy: 'per-thread',
      servers: {
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
  } finally {
    context.threadStore.close()
    await rm(root, { recursive: true, force: true })
  }
})
