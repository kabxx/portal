import type { CliCommandContext } from '../../src/cli-commands/core/command-types.ts'
import { McpLibrary } from '../../src/mcp/mcp-library.ts'
import type { ProviderId } from '../../src/providers/provider-id.ts'
import { SkillLibrary } from '../../src/skills/skill-library.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { ThreadStore } from '../../src/threads/thread-store.ts'

export const TEST_PROVIDER_IDS = [
  'chatgpt',
  'claude',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
] as const satisfies readonly ProviderId[]

export interface CliCommandContextFixture {
  context: CliCommandContext
  cleanup: () => void
}

export function isProviderId(value: string): value is ProviderId {
  return TEST_PROVIDER_IDS.some((provider) => provider === value)
}

export function createCliCommandContext(
  overrides: Partial<CliCommandContext> = {}
): CliCommandContextFixture {
  const threadManager = overrides.threadManager ?? new ThreadManager()
  const threadStore = overrides.threadStore ?? new ThreadStore(':memory:')
  const skillLibrary =
    overrides.skillLibrary ??
    new SkillLibrary({
      skillsDirectory: 'test-data/skills',
      tempDirectory: 'test-data/temp/skill-install',
      registryPath: 'test-data/config.yaml',
    })
  const mcpLibrary =
    overrides.mcpLibrary ?? new McpLibrary('test-data/config.yaml')
  const ui = overrides.ui ?? new TerminalController()

  const context: CliCommandContext = {
    threadManager,
    threadStore,
    skillLibrary,
    mcpLibrary,
    ui,
    browserProfileDir: 'test-data/browser-profile',
    providers: TEST_PROVIDER_IDS,
    resolveProvider: (value) => {
      const normalized = value.trim().toLowerCase()
      return isProviderId(normalized) ? normalized : null
    },
    createThread: async () => {},
    resumeThread: async () => {},
    closeThread: async (threadId) => await threadManager.closeThread(threadId),
    addSkill: async (source, options) =>
      await skillLibrary.add(source, options),
    submitThreadInput: async () => {},
    listCommands: () => [],
    ...overrides,
  }

  return {
    context,
    cleanup: () => context.threadStore.close(),
  }
}
