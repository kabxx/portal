import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapter,
  type AbortOptions,
  ProviderAdapterError,
} from '../../src/providers/adapters/adapter-base.ts'
import {
  createRuntimeFromAdapter as createProductionRuntimeFromAdapter,
  type RuntimeFactoryOptions,
} from '../../src/runtime/runtime-factory.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SkillLibrary } from '../../src/skills/skill-library.ts'
import { createTestSkill } from '../helpers/skills.ts'
import { loadProjectInstructions } from '../../src/instructions/project-instructions.ts'
import { createBrowserContextStub } from '../helpers/fakes.ts'
import { PORTAL_ACTION_PROTOCOL } from '../../src/providers/portal-action-protocol.ts'
import { createTestToolHost } from '../helpers/tool-host.ts'
import {
  buildPortalAgentPrompt,
  buildPortalChatPrompt,
} from '../../src/prompts/portal-prompt-plugin.ts'
import type { AgentSession } from '../../src/agents/agent-extension.ts'
import type { PromptSkillMetadata } from '../../src/skills/skill-services.ts'

type TestRuntimeFactoryOptions = Omit<
  RuntimeFactoryOptions,
  'toolHost' | 'createAgentSession'
> &
  Partial<Pick<RuntimeFactoryOptions, 'toolHost' | 'createAgentSession'>> & {
    setupMode?: 'full' | 'handshake' | 'inline' | 'skip'
    skills?: readonly PromptSkillMetadata[]
    projectInstructions?: string | null
  }

async function createRuntimeFromAdapter(
  adapter: ProviderAdapter,
  options: TestRuntimeFactoryOptions
) {
  const {
    toolHost,
    setupMode = 'full',
    skills = [],
    projectInstructions = null,
    createAgentSession,
    ...runtimeOptions
  } = options
  return await createProductionRuntimeFromAdapter(adapter, {
    ...runtimeOptions,
    toolHost: toolHost ?? createTestToolHost(adapter, []),
    createAgentSession:
      createAgentSession ??
      (async ({ tools, textToolProtocol }) =>
        createTestAgentSession({
          setupMode,
          skills,
          projectInstructions,
          workingDirectory: runtimeOptions.workingDirectory ?? process.cwd(),
          tools,
          textToolProtocol,
        })),
  })
}

function createTestAgentSession(options: {
  readonly setupMode: 'full' | 'handshake' | 'inline' | 'skip'
  readonly skills: readonly PromptSkillMetadata[]
  readonly projectInstructions: string | null
  readonly workingDirectory: string
  readonly tools: string | null
  readonly textToolProtocol: RuntimeFactoryOptions['textToolProtocol']
}): AgentSession | null {
  if (options.setupMode === 'skip') return null
  const promptRequest = {
    tools: options.tools,
    textToolProtocol: options.textToolProtocol ?? null,
    workingDirectory: options.workingDirectory,
  }
  const render = (task?: string) =>
    options.setupMode === 'handshake'
      ? buildPortalChatPrompt(options.workingDirectory, task)
      : buildPortalAgentPrompt({
          request: promptRequest,
          skills: options.skills,
          projectInstructions: options.projectInstructions,
          ...(task === undefined ? {} : { task }),
        })
  let inlinePending = options.setupMode === 'inline'
  return {
    initialization:
      options.setupMode === 'inline' ? null : { prompt: render() },
    previewInput: async (input) => (inlinePending ? render(input) : input),
    prepareInput: async (input) => {
      if (!inlinePending) return input
      inlinePending = false
      return render(input)
    },
  }
}

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
    ((options: AbortOptions | undefined) => void) | null

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

  public async changeModel(
    _model: Parameters<ProviderAdapter['changeModel']>[0]
  ) {
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

test('createRuntimeFromAdapter leaves adapter cleanup to its caller when changeModel fails', async () => {
  const adapter = new FakeAdapter({ failChangeModel: true })

  await assert.rejects(
    createRuntimeFromAdapter(adapter, {
      model: { key: 'gpt-test', option: null },
    }),
    /changeModel failed/
  )

  assert.equal(adapter.closeCalls, 0)
})

test('createRuntimeFromAdapter leaves adapter cleanup to its caller when runtime init fails', async () => {
  const adapter = new FakeAdapter({ failSubmit: true })

  await assert.rejects(
    createRuntimeFromAdapter(adapter, { model: null }),
    /submit failed/
  )

  assert.equal(adapter.closeCalls, 0)
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

  await createRuntimeFromAdapter(adapter, {
    model: null,
    setupMode: 'skip',
  })

  assert.equal(adapter.attachedTexts.length, 0)
  assert.equal(adapter.closeCalls, 0)
})

test('createRuntimeFromAdapter can inline setup with the first task', async () => {
  const adapter = new FakeAdapter({ responses: ['Completed.'] })
  const runtime = await createRuntimeFromAdapter(adapter, {
    model: null,
    setupMode: 'inline',
  })

  assert.deepEqual(adapter.attachedTexts, [])
  assert.equal(await runtime.submitUserInput('Do the task.'), 'Completed.')
  assert.equal(adapter.attachedTexts.length, 1)
  assert.match(adapter.attachedTexts[0] ?? '', /^# Portal Prompt/m)
  assert.match(adapter.attachedTexts[0] ?? '', /## Task\n\nDo the task\./)
  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /## Initialization/)
})

test('createRuntimeFromAdapter can send only the setup handshake for chat threads', async () => {
  const adapter = new FakeAdapter({ responses: ['ready - complete'] })

  await createRuntimeFromAdapter(adapter, {
    model: null,
    setupMode: 'handshake',
  })

  assert.deepEqual(adapter.attachedTexts, [
    buildPortalChatPrompt(process.cwd()),
  ])
})

test('createRuntimeFromAdapter keeps the default tool setup compact', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, {
    model: null,
    workingDirectory: 'C:\\Users\\portal\\workspace',
  })

  const setup = adapter.attachedTexts[0] ?? ''
  assert.ok(setup.length <= 1_400, `setup is ${setup.length} characters`)
  assert.doesNotMatch(setup, /Examples?:|```/)
})

test('generic Runtime does not inject a product Tool catalog', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, { model: null })

  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /## Tool Protocol/)
  assert.doesNotMatch(
    adapter.attachedTexts[0] ?? '',
    /## Portal Action Protocol/
  )
})

test('Runtime preserves an API Provider decision to use no text Tool protocol', async () => {
  const adapter = new FakeAdapter()
  let selectedProtocol: RuntimeFactoryOptions['textToolProtocol'] = undefined

  await createRuntimeFromAdapter(adapter, {
    model: null,
    textToolProtocol: null,
    createAgentSession: async ({ textToolProtocol }) => {
      selectedProtocol = textToolProtocol
      return null
    },
  })

  assert.equal(selectedProtocol, null)
  assert.deepEqual(adapter.attachedTexts, [])
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
    const instructions = await loadProjectInstructions({
      cwd: root,
      enabled: true,
    })
    const adapter = new FakeAdapter()

    await createRuntimeFromAdapter(adapter, {
      model: null,
      projectInstructions: instructions.prompt,
    })

    assert.match(adapter.attachedTexts[0] ?? '', /# Project Instructions/)
    assert.match(adapter.attachedTexts[0] ?? '', /Factory project rule\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter does not advertise an unregistered spawn tool', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, { model: null })

  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /### spawn/)
})

test('createRuntimeFromAdapter can omit the spawn tool from setup', async () => {
  const adapter = new FakeAdapter()

  await createRuntimeFromAdapter(adapter, {
    model: null,
    advertiseSpawnTool: false,
  })

  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /### spawn/)
  assert.doesNotMatch(adapter.attachedTexts[0] ?? '', /### run_command/)
})

test('a spawn absent from the graph remains unavailable for stale calls', async () => {
  const adapter = new FakeAdapter({
    responses: [
      'READY',
      '<action name="spawn">{"prompt":"stale call"}</action>',
      'Stopped at the configured depth.',
    ],
  })
  const runtime = await createRuntimeFromAdapter(adapter, {
    model: null,
    advertiseSpawnTool: false,
    textToolProtocol: PORTAL_ACTION_PROTOCOL,
  })

  const output = await runtime.submitUserInput('Continue an older context.')

  assert.equal(output, 'Stopped at the configured depth.')
  assert.match(adapter.attachedTexts.at(-1) ?? '', /Tool not found: spawn/)
})

test('createRuntimeFromAdapter catalogs enabled skill metadata and paths', async () => {
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
    const enabledSkills = (await skillLibrary.createCatalogSnapshot())
      .setupSkills
    const enabledAdapter = new FakeAdapter()
    await createRuntimeFromAdapter(enabledAdapter, {
      model: null,
      skills: enabledSkills,
    })
    const enabledPrompt = enabledAdapter.attachedTexts[0] ?? ''
    assert.match(enabledPrompt, /## Skills/)
    assert.match(enabledPrompt, /### runtime-skill/)
    assert.ok(
      enabledPrompt.includes(
        `Path: ${JSON.stringify(path.join(skillsDirectory, 'runtime-skill', 'SKILL.md'))}`
      )
    )
    assert.doesNotMatch(enabledPrompt, /### load_skill/)
    assert.match(
      enabledPrompt,
      /Description: Use this runtime skill for setup tests\./
    )
    assert.doesNotMatch(enabledPrompt, /SECRET INSTRUCTIONS/)
    assert.ok(
      enabledPrompt.indexOf('## Tools') < enabledPrompt.indexOf('## Skills')
    )
    assert.ok(
      enabledPrompt.indexOf('## Skills') < enabledPrompt.indexOf('## Runtime')
    )

    await skillLibrary.disable('runtime-skill')
    const disabledSkills = (await skillLibrary.createCatalogSnapshot())
      .setupSkills
    const disabledAdapter = new FakeAdapter()
    await createRuntimeFromAdapter(disabledAdapter, {
      model: null,
      skills: disabledSkills,
    })
    const disabledPrompt = disabledAdapter.attachedTexts[0] ?? ''
    assert.doesNotMatch(disabledPrompt, /## Skills/)
    assert.doesNotMatch(disabledPrompt, /### load_skill/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('createRuntimeFromAdapter passes abort signal into setup and leaves cleanup to its caller', async () => {
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
  assert.equal(adapter.closeCalls, 0)
})
