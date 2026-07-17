import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { ThreadCommand } from '../../../src/cli-commands/commands/command-thread.ts'
import { isToggleCapabilityProvider } from '../../../src/cli-commands/commands/command-thread-capability.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { ThreadManager } from '../../../src/threads/thread-manager.ts'
import type { ProviderId } from '../../../src/providers/provider-id.ts'
import { ThreadStore } from '../../../src/threads/thread-store.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../../helpers/fakes.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'
import type { SkillLibrary } from '../../../src/skills/skill-library.ts'
import type { McpLibrary } from '../../../src/mcp/mcp-library.ts'

type ToggleCapability = 'thinking' | 'search' | 'advanced_search' | 'web_search'
type ToggleState = 'on' | 'off'
type ActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

interface CapabilityAdapterOverrides {
  hasToggleCapability?: (capability: ToggleCapability) => Promise<boolean>
  getToggleState?: (capability: ToggleCapability) => Promise<ToggleState>
  setToggleState?: (
    capability: ToggleCapability,
    state: ToggleState
  ) => Promise<ToggleState>
  listActionCapabilities?: () => Promise<
    Array<{ name: string; state: ActionCapabilityState }>
  >
  selectActionCapability?: (name: string) => Promise<ActionCapabilityState>
  clearActionCapability?: () => Promise<void>
}

function createCapabilityAdapter(
  overrides: CapabilityAdapterOverrides
): ReturnType<typeof createProviderAdapterStub> {
  const adapter = createProviderAdapterStub()
  Object.assign(adapter, overrides)
  return adapter
}

async function executeCapability(
  context: CliCommandContext,
  args: readonly string[]
) {
  return await ThreadCommand.execute(context, ['capability', ...args])
}

function createCommandContext() {
  const ui = new TerminalController()
  const threadManager = new ThreadManager()
  const storagePath = path.join(
    os.tmpdir(),
    `portal-cap-${process.pid}-${Date.now()}-${Math.random()}.db`
  )
  const context: CliCommandContext = {
    threadManager,
    threadStore: new ThreadStore(storagePath),
    skillLibrary: {} as SkillLibrary,
    mcpLibrary: {} as McpLibrary,
    ui,
    browserProfileDir: 'C:\\profiles\\chrome',
    providers: [
      'chatgpt',
      'claude',
      'gemini',
      'deepseek',
      'doubao',
      'grok',
      'glm',
    ],
    resolveProvider: (value) => {
      const normalized = value.trim().toLowerCase()
      return context.providers.includes(normalized as ProviderId)
        ? (normalized as ProviderId)
        : null
    },
    createThread: async () => {
      return undefined
    },
    resumeThread: async () => {
      return undefined
    },
    closeThread: async (threadId) => await threadManager.closeThread(threadId),
    addSkill: async () => {
      throw new Error('not used in capability command tests')
    },
    submitThreadInput: async () => {},
    listCommands: () => [ThreadCommand],
  }

  return { context, threadManager, ui }
}

test('ThreadCommand capability warns when there is no active thread', async () => {
  const { context, ui } = createCommandContext()

  const result = await executeCapability(context, [])

  assert.equal(result.continue, true)
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread capability',
    body: 'No active thread. Use /thread open <provider> first.',
    format: 'plain',
  })
})

test('ThreadCommand capability lists an empty capability set for the active provider', async () => {
  const { context, threadManager, ui } = createCommandContext()
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter: createProviderAdapterStub() }),
    createdAt: 1,
  })

  const result = await executeCapability(context, [])

  assert.equal(result.continue, true)
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread capability',
    body: 'No capabilities available for chatgpt.',
    format: 'plain',
  })
})

test('ThreadCommand capability lists ChatGPT one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_create', state: 'available' },
      { name: 'web_search', state: 'available' },
      { name: 'deep_research', state: 'available' },
      { name: 'openai_platform', state: 'available' },
    ],
    selectActionCapability: async () => 'selected',
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])

  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: chatgpt',
      '',
      'Capabilities:',
      '  image_create     available',
      '  web_search       available',
      '  deep_research    available',
      '  openai_platform  available',
      '',
      'Usage:',
      '  /thread capability <capability>',
    ].join('\n'),
    format: 'plain',
  })
})

test('ThreadCommand capability selects ChatGPT one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const selectedCapabilities: string[] = []
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'web_search', state: 'available' },
    ],
    selectActionCapability: async (name: string) => {
      selectedCapabilities.push(name)
      return 'selected'
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['web_search'])

  assert.deepEqual(selectedCapabilities, ['web_search'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'chatgpt.web_search: selected',
    format: 'plain',
  })
})

test('ThreadCommand capability lists DeepSeek capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async () => true,
    getToggleState: async () => 'off',
    setToggleState: async (_name, state) => state,
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  const result = await executeCapability(context, [])

  assert.equal(result.continue, true)
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: deepseek',
      '',
      'Capabilities:',
      '  thinking  off',
      '  search    off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n'),
    format: 'plain',
  })
})

test('ThreadCommand capability executes DeepSeek toggle capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async () => true,
    getToggleState: async (name: string) => {
      return name === 'search' ? 'on' : 'off'
    },
    setToggleState: async (_name, state) => state,
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['search', 'status'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'deepseek.search: on',
    format: 'plain',
  })

  await executeCapability(context, ['thinking', 'on'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'deepseek.thinking: on',
    format: 'plain',
  })
})

test('ThreadCommand capability lists and executes Claude web_search toggle', async () => {
  const { context, threadManager, ui } = createCommandContext()
  let state: 'on' | 'off' = 'off'
  const setCalls: string[] = []
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async (name: string) => name === 'web_search',
    getToggleState: async () => state,
    setToggleState: async (_name: string, target: 'on' | 'off') => {
      setCalls.push(target)
      state = target
      return state
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'claude',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  assert.equal(isToggleCapabilityProvider('claude'), true)
  await executeCapability(context, [])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: claude',
      '',
      'Capabilities:',
      '  web_search  off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n'),
    format: 'plain',
  })

  await executeCapability(context, ['web_search', 'status'])
  assert.equal(latestTimelineEntry(ui)?.body, 'claude.web_search: off')
  await executeCapability(context, ['web_search', 'on'])
  assert.equal(latestTimelineEntry(ui)?.body, 'claude.web_search: on')
  await executeCapability(context, ['web_search', 'off'])
  assert.equal(latestTimelineEntry(ui)?.body, 'claude.web_search: off')
  assert.deepEqual(setCalls, ['on', 'off'])
})

test('ThreadCommand capability handles unavailable Claude web_search adapters', async () => {
  const unavailable = createCommandContext()
  unavailable.threadManager.addThread({
    id: unavailable.threadManager.createThreadId(),
    provider: 'claude',
    runtime: createFakeRuntime({
      adapter: createCapabilityAdapter({
        hasToggleCapability: async () => false,
        getToggleState: async () => 'off',
        setToggleState: async () => 'off',
      }),
    }),
    createdAt: 1,
  })

  await executeCapability(unavailable.context, ['web_search', 'status'])
  assert.equal(
    latestTimelineEntry(unavailable.ui)?.body,
    'Capability not available for claude: web_search'
  )

  const missing = createCommandContext()
  missing.threadManager.addThread({
    id: missing.threadManager.createThreadId(),
    provider: 'claude',
    runtime: createFakeRuntime({ adapter: createProviderAdapterStub() }),
    createdAt: 1,
  })
  await executeCapability(missing.context, ['web_search', 'status'])
  assert.equal(
    latestTimelineEntry(missing.ui)?.body,
    'The active Claude runtime does not support this capability.'
  )
})

test('ThreadCommand capability lists and executes GLM toggle capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const states: Record<string, 'on' | 'off'> = {
    thinking: 'on',
    search: 'off',
    advanced_search: 'off',
  }
  const setCalls: Array<{ name: string; state: string }> = []
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async () => true,
    getToggleState: async (name) => states[name] ?? 'off',
    setToggleState: async (name: string, state: 'on' | 'off') => {
      setCalls.push({ name, state })
      states[name] = state
      return state
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'glm',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: glm',
      '',
      'Capabilities:',
      '  thinking         on',
      '  search           off',
      '  advanced_search  off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n'),
    format: 'plain',
  })

  await executeCapability(context, ['thinking', 'status'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'glm.thinking: on',
    format: 'plain',
  })

  await executeCapability(context, ['advanced_search', 'status'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'glm.advanced_search: off',
    format: 'plain',
  })

  await executeCapability(context, ['search', 'on'])
  await executeCapability(context, ['advanced_search', 'on'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'glm.advanced_search: on',
    format: 'plain',
  })
  await executeCapability(context, ['advanced_search', 'off'])
  await executeCapability(context, ['thinking', 'off'])
  assert.deepEqual(setCalls, [
    { name: 'search', state: 'on' },
    { name: 'advanced_search', state: 'on' },
    { name: 'advanced_search', state: 'off' },
    { name: 'thinking', state: 'off' },
  ])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'glm.thinking: off',
    format: 'plain',
  })
})

test('ThreadCommand capability hides unavailable DeepSeek search capability', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async (name: string) => name === 'thinking',
    getToggleState: async () => 'off',
    setToggleState: async (_name, state) => state,
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: deepseek',
      '',
      'Capabilities:',
      '  thinking  off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n'),
    format: 'plain',
  })

  await executeCapability(context, ['search', 'status'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread capability',
    body: 'Capability not available for deepseek: search',
    format: 'plain',
  })
})

test('ThreadCommand capability rechecks DeepSeek capability availability each time', async () => {
  const { context, threadManager, ui } = createCommandContext()
  let searchAvailable = false
  const adapter: CapabilityAdapterOverrides = {
    hasToggleCapability: async (name: string) =>
      name === 'thinking' || searchAvailable,
    getToggleState: async () => 'off',
    setToggleState: async (_name, state) => state,
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])
  assert.deepEqual(
    ui.getState().timeline.at(-1)?.body,
    [
      'Provider: deepseek',
      '',
      'Capabilities:',
      '  thinking  off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n')
  )

  searchAvailable = true
  await executeCapability(context, [])
  assert.deepEqual(
    ui.getState().timeline.at(-1)?.body,
    [
      'Provider: deepseek',
      '',
      'Capabilities:',
      '  thinking  off',
      '  search    off',
      '',
      'Usage:',
      '  /thread capability <capability> <on|off|status>',
    ].join('\n')
  )
})

test('ThreadCommand capability lists Doubao one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'deep_research', state: 'available' },
      { name: 'translate', state: 'available' },
      { name: 'ppt_generation', state: 'available' },
      { name: 'meeting_record', state: 'disabled' },
    ],
    selectActionCapability: async () => 'selected',
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'doubao',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])

  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: doubao',
      '',
      'Capabilities:',
      '  deep_research   available',
      '  translate       available',
      '  ppt_generation  available',
      '  meeting_record  disabled',
      '',
      'Usage:',
      '  /thread capability <capability>',
    ].join('\n'),
    format: 'plain',
  })
})

test('ThreadCommand capability lists Gemini one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_create', state: 'available' },
      { name: 'canvas', state: 'disabled' },
    ],
    selectActionCapability: async () => 'selected',
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, [])

  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'info',
    label: '/thread capability',
    body: [
      'Provider: gemini',
      '',
      'Capabilities:',
      '  image_create  available',
      '  canvas        disabled',
      '',
      'Usage:',
      '  /thread capability <capability>',
    ].join('\n'),
    format: 'plain',
  })
})

test('ThreadCommand capability selects Gemini one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const selectedCapabilities: string[] = []
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_create', state: 'available' },
    ],
    selectActionCapability: async (name: string) => {
      selectedCapabilities.push(name)
      return 'selected'
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['image_create'])

  assert.deepEqual(selectedCapabilities, ['image_create'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'gemini.image_create: selected',
    format: 'plain',
  })
})

test('ThreadCommand capability clears Gemini one-shot capabilities with none', async () => {
  const { context, threadManager, ui } = createCommandContext()
  let clearCount = 0
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_create', state: 'available' },
    ],
    selectActionCapability: async () => 'selected',
    clearActionCapability: async () => {
      clearCount += 1
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['none'])

  assert.equal(clearCount, 1)
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'gemini.none: cleared',
    format: 'plain',
  })
})

test('ThreadCommand capability selects Doubao one-shot capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const selectedCapabilities: string[] = []
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_generation', state: 'available' },
    ],
    selectActionCapability: async (name: string) => {
      selectedCapabilities.push(name)
      return 'selected'
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'doubao',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['image_generation'])

  assert.deepEqual(selectedCapabilities, ['image_generation'])
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'doubao.image_generation: selected',
    format: 'plain',
  })
})

test('ThreadCommand capability clears Doubao one-shot capabilities with none', async () => {
  const { context, threadManager, ui } = createCommandContext()
  let clearCount = 0
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'image_generation', state: 'available' },
    ],
    selectActionCapability: async () => 'selected',
    clearActionCapability: async () => {
      clearCount += 1
    },
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'doubao',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['none'])

  assert.equal(clearCount, 1)
  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'success',
    label: '/thread capability',
    body: 'doubao.none: cleared',
    format: 'plain',
  })
})

test('ThreadCommand capability rejects disabled Doubao capabilities', async () => {
  const { context, threadManager, ui } = createCommandContext()
  const adapter: CapabilityAdapterOverrides = {
    listActionCapabilities: async () => [
      { name: 'meeting_record', state: 'disabled' },
    ],
    selectActionCapability: async (name: string) =>
      name === 'meeting_record' ? 'disabled' : 'selected',
  }
  threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'doubao',
    runtime: createFakeRuntime({ adapter: createCapabilityAdapter(adapter) }),
    createdAt: 1,
  })

  await executeCapability(context, ['meeting_record'])

  assert.deepEqual(latestTimelineEntry(ui), {
    tone: 'warning',
    label: '/thread capability',
    body: 'Doubao capability is disabled: meeting_record',
    format: 'plain',
  })
})
