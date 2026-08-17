import { portalCommandDefinitions } from '../../src/cli-commands/builtin-commands.ts'
import { createPortalCommandsRegistration } from '../../src/cli-commands/command-extension.ts'
import type {
  CommandCompletionSnapshot,
  CommandInputAnalysis,
  CommandResult,
} from '../../src/cli-commands/core/command-contracts.ts'
import {
  CommandServiceHost,
  commandServiceRefs,
  type CommandNavigationEvent,
  type CommandOutputMessage,
  type CommandServiceBundle,
  type CommandJobService,
  type CommandSkillService,
} from '../../src/cli-commands/core/command-services.ts'
import {
  commandContributionSpec,
  commandHandlerBindingSpec,
} from '../../src/cli-commands/core/command-plan.ts'
import {
  CommandRuntime,
  type CommandSessionRuntime,
} from '../../src/cli-commands/core/command-runtime.ts'
import { ExtensionTestHost } from '../../src/extensions/extension-test-host.ts'
import { canonicalHookPolicies } from '../../src/extensions/hook-policies.ts'
import { portalBeforeStopSpec } from '../../src/extensions/portal-hooks.ts'
import { portalCommandCompletionSnapshot } from '../../src/host/portal-command-services.ts'
import { RunCommandPlugin } from '../../src/tools/builtins/run-command-plugin.ts'
import { attachmentStoreService } from '../../src/attachments/attachment-contracts.ts'
import { childConversationService } from '../../src/threads/child-conversation-service.ts'
import {
  toolContributionSpec,
  toolHandlerBindingSpec,
} from '../../src/tools/tool-host.ts'
import { commandJobService } from '../../src/cli-commands/core/command-services.ts'
import { createTestProviderHost } from './provider-host.ts'
import { createSkillPluginRegistration } from '../../src/skills/skill-plugin.ts'
import { createSkillCommandRegistration } from '../../src/skills/skill-command-plugin.ts'
import {
  promptSkillService,
  type PromptSkillService,
} from '../../src/skills/skill-services.ts'
import type { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { createPluginsRegistration } from '../../src/bootstrap/plugins-plugin.ts'
import { registerMcpCommand } from '../../src/mcp-server/mcp-command-plugin.ts'

export interface BuiltinCommandTestRuntime {
  readonly host: ExtensionTestHost
  readonly session: CommandSessionRuntime
  readonly completionSnapshot: CommandCompletionSnapshot
  readonly messages: CommandOutputMessage[]
  readonly navigation: CommandNavigationEvent[]
  analyze(input: string): CommandInputAnalysis
  execute(
    input: string,
    options?: {
      readonly signal?: AbortSignal
      readonly deadline?: number
    }
  ): Promise<CommandResult>
  close(): Promise<void>
}

export function createBuiltinCommandTestRuntime(
  overrides: Partial<CommandServiceBundle> & {
    readonly jobs?: CommandJobService
    readonly skills?: CommandSkillService
    readonly plugins?: PluginManager
  } = {}
): BuiltinCommandTestRuntime {
  const { jobs, skills, plugins, ...serviceOverrides } = overrides
  const host = new ExtensionTestHost({
    generation: 'builtin-command-test',
    policies: canonicalHookPolicies,
  })
  for (const ref of commandServiceRefs) {
    host.defineService(ref)
  }
  host.defineService(promptSkillService)
  host.defineContribution(commandContributionSpec)
  host.defineExecutableBinding(commandHandlerBindingSpec)
  host.defineService(childConversationService)
  host.defineService(attachmentStoreService)
  host.defineSurfaceHost({ allowedFeatureServices: [commandJobService] })
  host.defineContribution(toolContributionSpec)
  host.defineExecutableBinding(toolHandlerBindingSpec)
  host.defineHook(portalBeforeStopSpec)

  const serviceHost = new CommandServiceHost()
  const registration = createPortalCommandsRegistration(
    serviceHost,
    portalCommandDefinitions
  )
  host.register(registration.descriptor, registration.module)
  host.register(
    {
      id: 'test.mcp-command',
      version: '1.0.0',
      dependencies: ['portal.commands'],
      capabilities: ['portal.command.mcp.manage'],
    },
    { register: registerMcpCommand }
  )
  const defaultSkills: CommandSkillService = {
    add: async (source) => ({
      skills: [{ name: source, directory: `C:\\skills\\${source}` }],
      warnings: [],
    }),
    list: async () => ({ skills: [], issues: [] }),
    enable: async () => false,
    disable: async () => false,
    remove: async () => ({ removed: false, warnings: [] }),
  }
  const skillService: PromptSkillService = Object.freeze({
    ...(skills ?? defaultSkills),
    snapshot: async () =>
      Object.freeze({ skills: [], projectInstructions: null }),
  })
  const skillRegistration = createSkillPluginRegistration({
    service: skillService,
  })
  host.register(skillRegistration.descriptor, skillRegistration.module)
  const skillCommandRegistration = createSkillCommandRegistration()
  host.register(
    skillCommandRegistration.descriptor,
    skillCommandRegistration.module
  )
  const runCommandPlugin = new RunCommandPlugin(
    jobs === undefined ? {} : { commandService: jobs }
  )
  const runCommandRegistration = runCommandPlugin.registration
  host.register(
    runCommandRegistration.descriptor,
    runCommandRegistration.module
  )
  if (plugins !== undefined) {
    const pluginsRegistration = createPluginsRegistration(plugins)
    host.register(pluginsRegistration.descriptor, pluginsRegistration.module)
  }

  const runtime = new CommandRuntime(host.freeze())
  const session = runtime.openSession(host.rootScope, 'builtin-command-test')
  const completionSnapshot = portalCommandCompletionSnapshot(
    createTestProviderHost()
  )
  const messages: CommandOutputMessage[] = []
  const navigation: CommandNavigationEvent[] = []
  serviceHost.bind({
    output: {
      write: (message) => messages.push(message),
      navigate: (event) => navigation.push(event),
    },
    catalog: { list: () => session.catalog },
    threads: {
      listAgentModes: () => ['agent', 'chat'],
      create: async () => ({ ok: true }),
      list: () => [],
      history: async () => ({ ok: true, entries: [] }),
      resume: async () => ({ ok: true }),
      reloadActive: async () => ({ ok: false, message: 'No active thread.' }),
      switchTo: () => false,
      status: () => null,
      close: async () => ({ ok: false, message: 'No active thread.' }),
      detach: () => null,
      listCapabilities: async () => ({
        ok: false,
        message: 'No active thread. Use /thread agent <provider> first.',
      }),
      executeCapability: async () => ({
        status: 'no-active-thread',
        title: '/thread capability',
        body: 'No active thread. Use /thread agent <provider> first.',
        format: 'plain',
      }),
    },
    providers: {
      list: () => ['chatgpt', 'gemini'],
      resolve: (value) =>
        value === 'chatgpt' || value === 'gemini' ? value : null,
      completionSnapshot: () => completionSnapshot,
    },
    mcp: {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ running: false, address: null, auth: false }),
    },
    keybindings: { reset: async () => undefined },
    ...serviceOverrides,
  })
  return {
    host,
    session,
    completionSnapshot,
    messages,
    navigation,
    analyze(input) {
      return session.analyze(input, completionSnapshot)
    },
    async execute(input, options = {}) {
      const analysis = session.prepare(input)
      if (analysis.kind !== 'ready') {
        throw new Error(
          analysis.kind === 'invalid' || analysis.kind === 'unknown'
            ? analysis.diagnostic.message
            : `Command is not ready: ${analysis.kind}`
        )
      }
      return await session.execute(analysis.invocation, {
        signal: options.signal ?? new AbortController().signal,
        deadline: options.deadline ?? Number.POSITIVE_INFINITY,
      })
    },
    async close() {
      await session.close()
      await host.dispose()
      await runCommandPlugin.close()
    },
  }
}
