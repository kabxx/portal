import { builtinCommandDefinitions } from '../../src/cli-commands/builtin-commands.ts'
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
import { portalCommandCompletionSnapshot } from '../../src/host/portal-command-services.ts'
import { testPolicies } from '../extensions/extension-test-fixtures.ts'

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
  overrides: Partial<CommandServiceBundle> = {}
): BuiltinCommandTestRuntime {
  const host = new ExtensionTestHost({
    generation: 'builtin-command-test',
    policies: testPolicies,
  })
  for (const ref of commandServiceRefs) {
    host.defineService(ref)
  }
  host.defineContribution(commandContributionSpec)
  host.defineExecutableBinding(commandHandlerBindingSpec)

  const serviceHost = new CommandServiceHost()
  const registration = createPortalCommandsRegistration(
    serviceHost,
    builtinCommandDefinitions
  )
  host.register(registration.descriptor, registration.module)

  const runtime = new CommandRuntime(host.freeze())
  const session = runtime.openSession(host.rootScope, 'builtin-command-test')
  const completionSnapshot = portalCommandCompletionSnapshot()
  const messages: CommandOutputMessage[] = []
  const navigation: CommandNavigationEvent[] = []
  serviceHost.bind({
    output: {
      write: (message) => messages.push(message),
      navigate: (event) => navigation.push(event),
    },
    catalog: { list: () => session.catalog },
    threads: {
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
    skills: {
      add: async (source) => ({
        skills: [{ name: source, directory: `C:\\skills\\${source}` }],
        warnings: [],
      }),
      list: async () => ({ skills: [], issues: [] }),
      enable: async () => false,
      disable: async () => false,
      remove: async () => ({ removed: false, warnings: [] }),
    },
    mcp: {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ running: false, address: null, auth: false }),
    },
    jobs: {
      list: () => [],
      stop: async () => 'not-found',
    },
    keybindings: { reset: async () => undefined },
    ...overrides,
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
    },
  }
}
