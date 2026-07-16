import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapter,
  type AbortOptions,
  ProviderAdapterError,
} from '../../src/providers/adapters/adapter-base.ts'
import { createRuntimeFromAdapter } from '../../src/runtime/runtime-factory.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SkillLibrary } from '../../src/skills/skill-library.ts'
import { createTestSkill } from '../helpers/skills.ts'
import { McpLibrary } from '../../src/mcp/mcp-library.ts'
import {
  McpConnectionError,
  type McpConnection,
} from '../../src/mcp/mcp-connection.ts'
import { loadProjectInstructions } from '../../src/instructions/project-instructions.ts'
import { createBrowserContextStub } from '../helpers/fakes.ts'

interface FakeAdapterOptions {
  failChangeModel?: boolean
  failSubmit?: boolean
  failSubmitWithAuth?: boolean
  onSubmit?: (options: AbortOptions | undefined) => void
  responses?: string[]
}

class FakeAdapter extends ProviderAdapter {
  public closeCalls = 0
  public attachedTexts: string[] = []
  public submitSignals: Array<AbortSignal | undefined> = []

  public constructor(options: FakeAdapterOptions = {}) {
    super(createBrowserContextStub())
    this.failChangeModel = options.failChangeModel ?? false
    this.failSubmit = options.failSubmit ?? false
    this.failSubmitWithAuth = options.failSubmitWithAuth ?? false
    this.onSubmit = options.onSubmit ?? null
    this.responses = [...(options.responses ?? [])]
  }

  private readonly failChangeModel: boolean
  private readonly failSubmit: boolean
  private readonly failSubmitWithAuth: boolean
  private readonly responses: string[]
  private readonly onSubmit:
    | ((options: AbortOptions | undefined) => void)
    | null

  public async close() {
    this.closeCalls += 1
  }

  public async restore() {
    return undefined
  }

  public async isLoggedIn() {
    return true
  }

  public get conversationId(): string | null {
    return null
  }

  public get conversationUrl(): string {
    return 'https://example.com/thread'
  }

  public async changeModel(_model: string) {
    if (this.failChangeModel) {
      throw new Error('changeModel failed')
    }
  }

  public async attachText(text: string) {
    this.attachedTexts.push(text)
  }

  public async attachFile(_path: string | readonly string[]) {
    return undefined
  }

  public async attachImage(_path: string | readonly string[]) {
    return undefined
  }

  public async submit(options?: AbortOptions): Promise<string> {
    this.submitSignals.push(options?.signal)
    this.onSubmit?.(options)
    if (this.failSubmitWithAuth) {
      throw new ProviderAdapterError('submit', 'Login required during init.', {
        kind: 'auth',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
      })
    }
    if (this.failSubmit) {
      throw new Error('submit failed')
    }
    return this.responses.shift() ?? 'READY'
  }
}

test('createRuntimeFromAdapter closes the adapter when changeModel fails', async () => {
  const adapter = new FakeAdapter({ failChangeModel: true })

  await assert.rejects(
    createRuntimeFromAdapter(adapter, { model: 'gpt-test' }),
    /changeModel failed/
  )

  assert.equal(adapter.closeCalls, 1)
})

test('createRuntimeFromAdapter closes the adapter when runtime init fails', async () => {
  const adapter = new FakeAdapter({ failSubmit: true })

  await assert.rejects(
    createRuntimeFromAdapter(adapter, { model: null }),
    /submit failed/
  )

  assert.equal(adapter.closeCalls, 1)
  assert.equal(adapter.attachedTexts.length, 1)
})

test('createRuntimeFromAdapter keeps the adapter open for auth runtime init failures', async () => {
  const adapter = new FakeAdapter({ failSubmitWithAuth: true })

  let capturedError: unknown
  try {
    await createRuntimeFromAdapter(adapter, { model: null })
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
  assert.equal(capturedError.adapter, adapter)
  assert.equal(adapter.closeCalls, 0)
})

test('createRuntimeFromAdapter can skip the setup handshake for resumed conversations', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, { model: null, skipSetup: true })

  assert.equal(adapter.attachedTexts.length, 0)
  assert.equal(adapter.closeCalls, 0)
})

test('createRuntimeFromAdapter includes provider prompt in setup', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, {
    model: null,
    providerPrompt: '# Provider Boundary\n- Use tools only.',
  })

  assert.match(adapter.attachedTexts[0] ?? '', /# Provider Boundary/)
  assert.ok(
    adapter.attachedTexts[0]!.indexOf('# Provider Boundary') <
      adapter.attachedTexts[0]!.indexOf('# Setup Handshake')
  )
})

test('createRuntimeFromAdapter includes project instructions in setup', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-instructions-')
  )
  try {
    await writeFile(path.join(root, '.git'), '', 'utf8')
    await writeFile(
      path.join(root, 'AGENTS.md'),
      'Factory project rule.',
      'utf8'
    )
    const { instructions } = await loadProjectInstructions({
      cwd: root,
      config: {
        claude: { global: false, local: true },
        codex: { global: false, local: true },
      },
    })
    const adapter = new FakeAdapter()

    await createRuntimeFromAdapter(adapter, {
      model: null,
      projectInstructions: instructions,
    })

    assert.match(adapter.attachedTexts[0] ?? '', /# Project Instructions/)
    assert.match(adapter.attachedTexts[0] ?? '', /Factory project rule\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter includes the spawn tool in setup', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, { model: null })

  assert.match(adapter.attachedTexts[0] ?? '', /### spawn/)
  assert.match(adapter.attachedTexts[0] ?? '', /"prompt"/)
})

test('createRuntimeFromAdapter catalogs enabled skills into setup and load_skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-runtime-skill-'))
  const skillsDirectory = path.join(root, 'data', 'skills')
  await createTestSkill(skillsDirectory, 'runtime-skill', {
    description: 'Use this runtime skill for setup tests.',
    body: '# Runtime skill\n\nSECRET INSTRUCTIONS',
  })
  const skillLibrary = new SkillLibrary({
    skillsDirectory,
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    const enabledAdapter = new FakeAdapter({
      responses: [
        'READY',
        '<tool>{"tool":"load_skill","params":{"name":"runtime-skill"}}</tool>',
        'Skill loaded.',
        'Manual skill loaded.',
      ],
    })
    const enabledRuntime = await createRuntimeFromAdapter(enabledAdapter, {
      model: null,
      skillLibrary,
    })
    assert.deepEqual(enabledRuntime.availableManualSkillNames, [
      'runtime-skill',
    ])
    const enabledPrompt = enabledAdapter.attachedTexts[0] ?? ''
    assert.match(enabledPrompt, /# Skills/)
    assert.match(enabledPrompt, /runtime-skill:/)
    assert.match(enabledPrompt, /### load_skill/)
    assert.match(enabledPrompt, /result\.instructions/)
    assert.doesNotMatch(enabledPrompt, /<skill_content>/)
    assert.doesNotMatch(enabledPrompt, /SECRET INSTRUCTIONS/)
    assert.ok(
      enabledPrompt.indexOf('# Tools') < enabledPrompt.indexOf('# Skills')
    )
    assert.ok(
      enabledPrompt.indexOf('# Skills') <
        enabledPrompt.indexOf('# Runtime Context')
    )

    await enabledRuntime.submitUserInput('Load runtime-skill.')
    const loadedResult = JSON.parse(
      enabledAdapter.attachedTexts[2]!.slice('### Tool Result ###\n'.length)
    ) as {
      tool: string
      outcome: string
      result: Record<string, unknown>
    }
    assert.equal(loadedResult.tool, 'load_skill')
    assert.equal(loadedResult.outcome, 'success')
    assert.equal(loadedResult.result.name, 'runtime-skill')
    assert.deepEqual(loadedResult.result.resources, [])
    assert.match(
      String(loadedResult.result.instructions),
      /SECRET INSTRUCTIONS/
    )

    await enabledRuntime.submitUserInput('$runtime-skill')
    assert.match(enabledAdapter.attachedTexts[3] ?? '', /SECRET INSTRUCTIONS/)
    assert.match(enabledAdapter.attachedTexts[3] ?? '', /## User Task\n\n$/)

    await skillLibrary.disable('runtime-skill')
    const disabledAdapter = new FakeAdapter()
    const disabledRuntime = await createRuntimeFromAdapter(disabledAdapter, {
      model: null,
      skillLibrary,
    })
    assert.deepEqual(disabledRuntime.availableManualSkillNames, [])
    const disabledPrompt = disabledAdapter.attachedTexts[0] ?? ''
    assert.doesNotMatch(disabledPrompt, /# Skills/)
    assert.doesNotMatch(disabledPrompt, /### load_skill/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('load_skill reports files deleted after runtime creation to the model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-runtime-skill-'))
  const skillsDirectory = path.join(root, 'data', 'skills')
  const skillDirectory = await createTestSkill(skillsDirectory, 'deleted-skill')
  const skillLibrary = new SkillLibrary({
    skillsDirectory,
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })
  const adapter = new FakeAdapter({
    responses: [
      'READY',
      '<tool>{"tool":"load_skill","params":{"name":"deleted-skill"}}</tool>',
      'The missing skill was reported.',
    ],
  })

  try {
    const runtime = await createRuntimeFromAdapter(adapter, {
      model: null,
      skillLibrary,
    })
    await rm(skillDirectory, { recursive: true, force: true })
    const toolResults: Array<Record<string, unknown>> = []

    const output = await runtime.submitUserInput('Load deleted-skill.', {
      onToolResult: async (toolResult) => {
        toolResults.push(toolResult.result)
      },
    })

    assert.equal(output, 'The missing skill was reported.')
    assert.equal(toolResults.length, 1)
    assert.match(
      String(toolResults[0]?.message),
      /^Skill files are no longer available or valid: deleted-skill/
    )
    assert.match(
      adapter.attachedTexts[2] ?? '',
      /^### Tool Result ###\n\{[\s\S]*"tool": "load_skill"[\s\S]*"outcome": "error"[\s\S]*Skill files are no longer available or valid: deleted-skill/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter passes abort signal into setup and closes on abort', async () => {
  const controller = new AbortController()
  let submitSignal: AbortSignal | undefined
  const adapter = new FakeAdapter({
    onSubmit: (options) => {
      submitSignal = options?.signal
      assert.equal(submitSignal?.aborted, false)
      controller.abort(new PortalAbortError('cancel setup'))
      throw options?.signal?.reason ?? new Error('missing abort reason')
    },
  })

  await assert.rejects(
    createRuntimeFromAdapter(adapter, {
      model: null,
      signal: controller.signal,
    }),
    PortalAbortError
  )

  assert.equal(adapter.submitSignals[0], submitSignal)
  assert.equal(submitSignal?.aborted, true)
  assert.equal(adapter.closeCalls, 1)
})

test('createRuntimeFromAdapter snapshots MCP names and loads exact tool definitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-runtime-mcp-'))
  const mcpLibrary = new McpLibrary(path.join(root, 'data', 'config.yaml'))
  await mcpLibrary.add('example', {
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
  })
  let connectionCloseCalls = 0
  const connection = {
    name: 'example',
    available: true,
    maxOutputChars: 10_000,
    listCachedTools: () => [
      {
        name: 'echo',
        description: 'Echo a value.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    ],
    getCachedTool: (name: string) =>
      name === 'echo'
        ? {
            name: 'echo',
            description: 'Echo a value.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
            },
          }
        : null,
    callTool: async () => ({ content: [{ type: 'text', text: 'echoed' }] }),
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
    close: async () => {
      connectionCloseCalls += 1
    },
  } satisfies McpConnection
  const adapter = new FakeAdapter({
    responses: [
      'READY',
      '<tool>{"tool":"mcp_search_tool","params":{"server":"example","tool":"echo"}}</tool>',
      'Definition loaded.',
    ],
  })

  try {
    const runtime = await createRuntimeFromAdapter(adapter, {
      model: null,
      mcpLibrary,
      mcpConnector: async () => connection,
    })
    const setup = adapter.attachedTexts[0] ?? ''
    assert.match(setup, /### mcp_search_tool/)
    assert.match(setup, /### mcp_call_tool/)
    assert.match(setup, /# MCP Servers\n\n## example\n- "echo"/)
    assert.doesNotMatch(setup, /Echo a value\./)
    assert.ok(
      setup.indexOf('# MCP Servers') < setup.indexOf('# Runtime Context')
    )

    await runtime.submitUserInput('Load the echo definition.')
    const toolResultMessage = adapter.attachedTexts[2] ?? ''
    const toolResult = JSON.parse(
      toolResultMessage.slice('### Tool Result ###\n'.length)
    ) as {
      tool: string
      outcome: string
      result: Record<string, unknown>
    }
    assert.equal(toolResult.tool, 'mcp_search_tool')
    assert.equal(toolResult.outcome, 'success')
    assert.equal(toolResult.result.server, 'example')
    assert.equal(toolResult.result.tool, 'echo')
    assert.equal(toolResult.result.description, 'Echo a value.')
    assert.deepEqual(toolResult.result.inputSchema, {
      type: 'object',
      properties: { value: { type: 'string' } },
    })

    await runtime.close()
    assert.equal(connectionCloseCalls, 1)
    assert.equal(adapter.closeCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter omits MCP prompt and tools for an empty MCP config', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-mcp-empty-')
  )
  const mcpLibrary = new McpLibrary(path.join(root, 'data', 'config.yaml'))
  const adapter = new FakeAdapter()

  try {
    const runtime = await createRuntimeFromAdapter(adapter, {
      model: null,
      mcpLibrary,
    })
    const setup = adapter.attachedTexts[0] ?? ''

    assert.doesNotMatch(setup, /# MCP Servers/)
    assert.doesNotMatch(setup, /### mcp_search_tool/)
    assert.doesNotMatch(setup, /### mcp_call_tool/)
    await runtime.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter omits MCP prompt and tools when every connection fails', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-mcp-unavailable-')
  )
  const mcpLibrary = new McpLibrary(path.join(root, 'data', 'config.yaml'))
  await mcpLibrary.add('unavailable', {
    transport: 'streamable-http',
    url: 'https://unavailable.example/mcp',
  })
  const adapter = new FakeAdapter()
  const warnings: string[] = []

  try {
    const runtime = await createRuntimeFromAdapter(adapter, {
      model: null,
      mcpLibrary,
      mcpConnector: async () => {
        throw new McpConnectionError('connection refused')
      },
      onMcpWarning: (warning) => {
        warnings.push(warning.markdown)
      },
    })
    const setup = adapter.attachedTexts[0] ?? ''

    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /connection refused/)
    assert.doesNotMatch(setup, /# MCP Servers/)
    assert.doesNotMatch(setup, /### mcp_search_tool/)
    assert.doesNotMatch(setup, /### mcp_call_tool/)
    await runtime.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resumed runtimes reconnect current MCP config without sending setup', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-mcp-resume-')
  )
  const mcpLibrary = new McpLibrary(path.join(root, 'config.yaml'))
  await mcpLibrary.add('current', {
    transport: 'stdio',
    command: 'node',
  })
  let connectorCalls = 0
  const connection = {
    name: 'current',
    available: true,
    maxOutputChars: 10_000,
    listCachedTools: () => [],
    getCachedTool: () => null,
    callTool: async () => ({ content: [] }),
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
    close: async () => {},
  } satisfies McpConnection
  const adapter = new FakeAdapter()

  try {
    const runtime = await createRuntimeFromAdapter(adapter, {
      model: null,
      skipSetup: true,
      mcpLibrary,
      mcpConnector: async () => {
        connectorCalls += 1
        return connection
      },
    })

    assert.equal(connectorCalls, 1)
    assert.equal(adapter.attachedTexts.length, 0)
    assert.ok(runtime.getMcpSession())
    await runtime.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime initialization failure closes its MCP session', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-runtime-mcp-close-')
  )
  const mcpLibrary = new McpLibrary(path.join(root, 'config.yaml'))
  await mcpLibrary.add('server', {
    transport: 'stdio',
    command: 'node',
  })
  let connectionCloseCalls = 0
  const connection = {
    name: 'server',
    available: true,
    maxOutputChars: 10_000,
    listCachedTools: () => [],
    getCachedTool: () => null,
    callTool: async () => ({ content: [] }),
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
    listPrompts: async () => [],
    getPrompt: async () => ({ messages: [] }),
    close: async () => {
      connectionCloseCalls += 1
    },
  } satisfies McpConnection
  const adapter = new FakeAdapter({ failSubmit: true })

  try {
    await assert.rejects(
      createRuntimeFromAdapter(adapter, {
        model: null,
        mcpLibrary,
        mcpConnector: async () => connection,
      }),
      /submit failed/
    )
    assert.equal(connectionCloseCalls, 1)
    assert.equal(adapter.closeCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
