import path from 'path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { stdin, stdout } from 'process'
import { Command } from 'commander'
import { render } from 'ink'
import { createElement } from 'react'
import { launchBrowser } from './platform/browser-cdp-launcher.ts'
import type { RuntimeCore } from './runtime/runtime-core.ts'
import { createRuntimeFromAdapter } from './runtime/runtime-factory.ts'
import {
  type ProviderAdapter,
  isProviderAdapterError,
} from './providers/adapters/adapter-base.ts'
import { ChatGPTAdapter } from './providers/adapters/adapter-chatgpt.ts'
import { GeminiAdapter } from './providers/adapters/adapter-gemini.ts'
import { DeepSeekAdapter } from './providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from './providers/adapters/adapter-doubao.ts'
import { GrokAdapter } from './providers/adapters/adapter-grok.ts'
import { GlmAdapter } from './providers/adapters/adapter-glm.ts'
import {
  buildRuntimeRecoveryPlan,
  tryRestoreRuntimeForRecovery,
} from './runtime/runtime-recovery.ts'
import type { ToolServices } from './tools/core/tool-definition.ts'
import { initializeRuntimeWithLoginWait } from './runtime/runtime-initializer.ts'
import { isAbortError, throwIfAborted } from './runtime/runtime-cancellation.ts'
import { sleepWithAbortAsync } from './shared/sleep.ts'
import { ThreadManager } from './threads/thread-manager.ts'
import {
  ThreadCloseTimeoutError,
  ThreadOperationCoordinator,
  type ThreadOperationHandle,
} from './threads/thread-operation-coordinator.ts'
import type { ProviderId } from './providers/provider-id.ts'
import {
  buildThreadHistoryTitle,
  createThreadStore,
} from './threads/thread-store.ts'
import { DEFAULT_COMMANDS } from './cli-commands/command-set.ts'
import {
  CommandRegistry,
  tokenizeCommandInput,
} from './cli-commands/core/command-registry.ts'
import type { CliCommandContext } from './cli-commands/core/command-types.ts'
import {
  executeProviderCapability,
  listProviderCapabilityStates,
} from './cli-commands/commands/command-thread-capability.ts'
import { resolveConversationUrl } from './providers/provider-conversation-url.ts'
import { TerminalScreen } from './terminal-ui/terminal-screen.tsx'
import { TerminalController } from './terminal-ui/terminal-controller.ts'
import { SkillLibrary } from './skills/skill-library.ts'
import { McpLibrary } from './mcp/mcp-library.ts'
import type { McpServerConfig } from './mcp/mcp-config.ts'
import type { ConversationHistoryResult } from './providers/conversation-history.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  type PortalAgentInstructionsConfig,
} from './config/portal-config.ts'
import {
  loadProjectInstructions,
  type ProjectInstructionWarning,
  type ProjectInstructions,
} from './instructions/project-instructions.ts'
import {
  ApiHttpError,
  PortalApiServer,
  type ApiHandlers,
} from './api/api-server.ts'

const LOGIN_CHECK_INTERVAL_MS = 1000
const CLEAR_TERMINAL_ESCAPE = '\u001B[2J\u001B[3J\u001B[H'
const PORTAL_VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version

export function clearTerminalBeforeRender(output: {
  isTTY?: boolean
  write: (data: string) => unknown
}): void {
  if (output.isTTY === true) {
    output.write(CLEAR_TERMINAL_ESCAPE)
  }
}

export function clearInteractiveTerminal(
  inkApp: { clear: () => void },
  output: { isTTY?: boolean; write: (data: string) => unknown }
): void {
  if (output.isTTY !== true) {
    return
  }
  inkApp.clear()
  output.write(CLEAR_TERMINAL_ESCAPE)
}

export function canRunCommandWhileThreadBusy(input: string): boolean {
  const [command, subcommand, action] = tokenizeCommandInput(input)
  if (command === '/help' || command === '/providers' || command === '/exit') {
    return true
  }
  if (command === '/thread') {
    return (
      subcommand === undefined ||
      [
        'open',
        'list',
        'history',
        'resume',
        'switch',
        'status',
        'close',
        'detach',
      ].includes(subcommand)
    )
  }
  if (command === '/skill') {
    return subcommand === undefined || subcommand === 'list'
  }
  if (command === '/mcp') {
    return (
      subcommand === undefined ||
      subcommand === 'list' ||
      ((subcommand === 'resource' || subcommand === 'prompt') &&
        action === 'list')
    )
  }
  return false
}

export const GROK_PROVIDER_PROMPT = [
  `# Grok Tool Boundary (Strict Enforcement)`,
  `- These rules remain active after the READY handshake and apply to every later assistant response in this conversation.`,
  `- For Grok, this section overrides any more permissive wording in the Tools section, including permission to add text before a tool call.`,
  `- The "Tools" section is the complete and exclusive list of operations available outside this chat. A tool exists only when that section explicitly lists it and defines its invocation protocol.`,
  `- Mandatory local-path decision order: whenever a user message contains a local path or refers to a user-local resource, inspect every listed tool's description and input schema before composing any natural-language answer. Grok's inability to open that path directly is irrelevant to this decision.`,
  `- If a listed tool's description covers the requested action and its schema accepts the required input, that tool matches and you MUST invoke it. You may report that the path is inaccessible only after an actual tool result reports failure, or when no listed tool contract covers the action.`,
  `- Listed tools are real operations supplied by the surrounding runtime. When the task requires an operation outside this chat and a listed tool directly performs it, YOU must invoke that tool yourself in your current assistant response through its declared protocol. Do not ask the user, the runtime, or another agent to invoke it for you.`,
  `- A natural-language response without the required invocation is invalid in that case. Describing, simulating, promising, or claiming an invocation does not invoke anything.`,
  `- Mandatory tool output contract: when such an invocation is required, your response MUST contain exactly one raw valid <tool>...</tool> block and nothing else. Its first non-whitespace characters must be <tool>, and the response must end with </tool>. Do not add acknowledgement, explanation, status, promises, waiting text, or Markdown fences.`,
  `- The raw block is the invocation request, not an example or description. Replace the invocation format's placeholders with the exact listed tool name and schema-valid parameters. If your response has no valid raw block, you did not call a tool.`,
  `- Mandatory pre-send check: if your draft says or implies "I cannot access the local path", "please upload it", "please wait", "I am trying", or "the tool was used" while a listed tool matches, discard the entire draft and replace it with the required raw tool block.`,
  `- Before sending any response for a user-local action, verify that either the response is the required invocation or an actual Tool Result already proves that no listed tool can complete it. Never send an unverified limitation or simulated progress message.`,
  `- Tools execute through the surrounding runtime, outside Grok's environment. Pass user-provided local paths according to the selected tool's schema. Never remap them into a Grok-native path or infer that a tool lacks access because Grok's own sandbox lacks access.`,
  `- Never claim that an action was attempted, completed, or verified unless the runtime has returned the corresponding result or observation.`,
  `- Do not ask the user to upload, copy, paste, run, or perform an action manually when a listed tool can perform it.`,
  `- Grok-native features, including its sandbox, artifacts, workspace, uploaded-file workspace, browser tools, and internal filesystem, are unavailable for user-local or external actions and MUST NOT be invoked, relied on, simulated, or used as fallback.`,
  `- This prohibition applies even when a Grok-native feature is visible, suggested, appears usable, or claims access. Grok-native paths such as /home/workdir/artifacts and results produced only inside Grok's environment are not user-local results.`,
  `- The only exception is an exact tool listed under "Tools" with its invocation protocol. Similar names, UI visibility, or implicit availability are not exceptions.`,
  `- If a listed tool is unavailable or fails, use another listed tool or report the limitation. Never substitute a Grok-native feature and never invent an invocation or result.`,
].join('\n')

interface Options {
  browserName?: string
  browserExecutablePath?: string
  browserRemoteDebuggingPort?: string
}

const PROVIDERS: ProviderId[] = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
]
const SHUTDOWN_CLOSE_TIMEOUT_MS = 3000

interface StopTarget {
  stopGeneration(): Promise<void>
}

interface PendingThreadHistoryEntry {
  provider: ProviderId
  conversationUrl: string
  createdAt: number
}

class PortalExitError extends Error {
  constructor() {
    super('Portal is exiting.')
    this.name = 'PortalExitError'
  }
}

export async function closeWithTimeout(
  close: () => Promise<void>,
  timeoutMs = SHUTDOWN_CLOSE_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } catch {
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

export function transitionLoginWaitWarning(
  waitingForLogin: boolean,
  requiresLogin: boolean
): { waitingForLogin: boolean; shouldRender: boolean } {
  return {
    waitingForLogin: requiresLogin,
    shouldRender: !requiresLogin || !waitingForLogin,
  }
}

function buildProgram() {
  return new Command()
    .name('portal')
    .description(
      'A browser-based agent CLI for working across multiple web AI providers.'
    )
    .version(PORTAL_VERSION)
    .option(
      '--browser-name <name>',
      'browser to use (chromium-based browsers like chromium, chrome, or edge)'
    )
    .option(
      '--browser-executable-path <path>',
      'path to the browser executable used when launching a browser for CDP'
    )
    .option(
      '--browser-remote-debugging-port <port>',
      'remote debugging port used when launching the browser and connecting over CDP'
    )
}

function normalizeProviderId(value: string): ProviderId | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const aliases: Record<string, ProviderId> = {
    chatgpt: 'chatgpt',
    gpt: 'chatgpt',
    gemini: 'gemini',
    deepseek: 'deepseek',
    doubao: 'doubao',
    grok: 'grok',
    glm: 'glm',
  }

  return aliases[normalized] ?? null
}

function redactMcpConfig(config: McpServerConfig): Record<string, unknown> {
  const record = config as McpServerConfig & {
    headers?: Record<string, string>
    env?: Record<string, string>
  }
  const { headers, env, ...safe } = record
  return {
    ...safe,
    ...(headers === undefined ? {} : { hasHeaders: true }),
    ...(env === undefined ? {} : { hasEnv: true }),
  }
}

function getProviderPrompt(provider: ProviderId): string | null {
  return provider === 'grok' ? GROK_PROVIDER_PROMPT : null
}

async function createProjectInstructions(
  config: PortalAgentInstructionsConfig,
  onWarning: (warning: ProjectInstructionWarning) => void | Promise<void>
): Promise<ProjectInstructions> {
  const loaded = await loadProjectInstructions({
    cwd: process.cwd(),
    config,
  })
  for (const warning of loaded.warnings) {
    await onWarning(warning)
  }
  return loaded.instructions
}

function formatInstructionWarning(
  warning: ProjectInstructionWarning
): string[] {
  return [
    warning.message,
    ...(warning.path === undefined ? [] : [`source: ${warning.path}`]),
  ]
}

function createToolServices({
  context,
  provider,
  model,
  skillLibrary,
  mcpLibrary,
  projectInstructions,
}: {
  context: import('playwright').BrowserContext
  provider: ProviderId
  model: string | null
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  projectInstructions: ProjectInstructions
}): ToolServices {
  return {
    spawnTask: async (
      { prompt, provider: requestedProvider },
      options = {}
    ) => {
      const spawnProvider =
        requestedProvider === undefined
          ? provider
          : normalizeProviderId(requestedProvider)
      if (spawnProvider === null) {
        return `[ERROR] Unsupported spawn provider: ${requestedProvider}`
      }
      const spawnOptions = {
        context,
        provider: spawnProvider,
        model: spawnProvider === provider ? model : null,
        prompt,
        skillLibrary,
        mcpLibrary,
        projectInstructions: projectInstructions.fork(),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }
      return await runSpawnTask(spawnOptions)
    },
  }
}

async function runSpawnTask({
  context,
  provider,
  model,
  prompt,
  skillLibrary,
  mcpLibrary,
  projectInstructions,
  signal,
}: {
  context: import('playwright').BrowserContext
  provider: ProviderId
  model: string | null
  prompt: string
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  projectInstructions: ProjectInstructions
  signal?: AbortSignal
}): Promise<string> {
  let adapter: ProviderAdapter | null = null
  let runtime: RuntimeCore | null = null
  try {
    throwIfAborted(signal)
    adapter = await createAdapterForProvider(context, provider, null, signal)
    runtime = await createRuntimeFromAdapter(adapter, {
      model,
      providerPrompt: getProviderPrompt(provider),
      skillLibrary,
      mcpLibrary,
      projectInstructions,
      toolServices: createToolServices({
        context,
        provider,
        model,
        skillLibrary,
        mcpLibrary,
        projectInstructions,
      }),
      signal,
    })
    throwIfAborted(signal)
    const output = await runtime.submitUserInput(prompt, {
      ...(signal !== undefined ? { signal } : {}),
    })
    return JSON.stringify(
      {
        provider,
        conversationUrl: runtime.conversationUrl,
        output,
      },
      null,
      2
    )
  } finally {
    if (runtime !== null) {
      await runtime.close().catch(() => {})
    } else {
      await adapter?.close().catch(() => {})
    }
  }
}

async function createAdapterForProvider(
  context: import('playwright').BrowserContext,
  provider: ProviderId,
  conversationUrl: string | null = null,
  signal?: AbortSignal
): Promise<ProviderAdapter> {
  switch (provider) {
    case 'chatgpt':
      return await ChatGPTAdapter.create(context, { conversationUrl, signal })
    case 'gemini':
      return await GeminiAdapter.create(context, { conversationUrl, signal })
    case 'deepseek':
      return await DeepSeekAdapter.create(context, { conversationUrl, signal })
    case 'doubao':
      return await DoubaoAdapter.create(context, { conversationUrl, signal })
    case 'grok':
      return await GrokAdapter.create(context, { conversationUrl, signal })
    case 'glm':
      return await GlmAdapter.create(context, { conversationUrl, signal })
  }
}

export function showPendingThreadTimeline(
  ui: TerminalController,
  threadManager: ThreadManager,
  threadId: string
): { keep(): void; discard(): void } {
  const previousThreadId = threadManager.getActiveThread()?.id ?? null
  let settled = false
  ui.showThreadTimeline(threadId)

  return {
    keep() {
      settled = true
    },
    discard() {
      if (settled) {
        return
      }
      settled = true
      ui.removeThreadTimeline(threadId)
      if (
        previousThreadId !== null &&
        threadManager.getThread(previousThreadId) !== null
      ) {
        ui.showThreadTimeline(previousThreadId)
      } else {
        ui.showHomeTimeline()
      }
    },
  }
}

async function openThread(
  ui: TerminalController,
  threadManager: ThreadManager,
  skillLibrary: SkillLibrary,
  mcpLibrary: McpLibrary,
  instructionConfig: PortalAgentInstructionsConfig,
  context: import('playwright').BrowserContext,
  provider: ProviderId,
  model: string | null,
  browserProfileDir: string,
  signal?: AbortSignal,
  onStopTarget?: (target: StopTarget | null) => void
): Promise<PendingThreadHistoryEntry | null> {
  const threadId = threadManager.createThreadId()
  const pendingTimeline = showPendingThreadTimeline(ui, threadManager, threadId)
  let waitingForLogin = false
  ui.setBusy(true)

  try {
    throwIfAborted(signal)
    const projectInstructions = await createProjectInstructions(
      instructionConfig,
      (warning) => {
        ui.renderWarning('instructions', formatInstructionWarning(warning))
      }
    )
    throwIfAborted(signal)
    const runtime = await initializeRuntimeWithLoginWait({
      provider,
      browserProfileDir,
      threadId,
      createAdapter: async () => {
        const adapter = await createAdapterForProvider(
          context,
          provider,
          null,
          signal
        )
        onStopTarget?.(adapter)
        return adapter
      },
      createRuntime: async (adapter) =>
        await createRuntimeFromAdapter(adapter, {
          model,
          providerPrompt: getProviderPrompt(provider),
          skillLibrary,
          mcpLibrary,
          projectInstructions,
          onMcpWarning: async (warning) => {
            ui.renderWarning('MCP', warning.markdown, 'markdown')
          },
          toolServices: createToolServices({
            context,
            provider,
            model,
            skillLibrary,
            mcpLibrary,
            projectInstructions,
          }),
          signal,
        }),
      onWarning: async (plan) => {
        const transition = transitionLoginWaitWarning(
          waitingForLogin,
          plan.requiresLogin
        )
        waitingForLogin = transition.waitingForLogin
        if (transition.shouldRender) {
          ui.renderWarning(plan.title, plan.lines)
        }
      },
      onLoginWait: async () => {
        waitingForLogin = true
      },
      waitForLogin: async () => {
        await sleepWithAbortAsync(LOGIN_CHECK_INTERVAL_MS, signal)
      },
      signal,
    })
    if (signal?.aborted) {
      await runtime?.close().catch(() => {})
      throwIfAborted(signal)
    }
    onStopTarget?.(runtime)
    if (runtime === null) {
      pendingTimeline.discard()
      ui.renderWarning('thread', [
        `Could not open ${provider}.`,
        'No thread was created. Check the browser page, then run /thread open again.',
      ])
      return null
    }

    const thread = threadManager.addThread({
      id: threadId,
      provider,
      runtime,
      createdAt: Date.now(),
    })
    pendingTimeline.keep()
    waitingForLogin = false
    ui.showThreadTimeline(thread.id)
    ui.renderInfo('/thread open', [
      `Thread ${threadId} is ready.`,
      `Conversation URL: ${runtime.conversationUrl}`,
    ])
    return {
      provider,
      conversationUrl: runtime.conversationUrl,
      createdAt: thread.createdAt,
    }
  } catch (error) {
    if (isAbortError(error)) {
      pendingTimeline.discard()
      ui.renderWarning('/thread open', `Cancelled opening ${provider}.`)
      return null
    }
    throw error
  } finally {
    pendingTimeline.discard()
    ui.setBusy(false)
  }
}

async function resumeThread(
  ui: TerminalController,
  threadManager: ThreadManager,
  skillLibrary: SkillLibrary,
  mcpLibrary: McpLibrary,
  instructionConfig: PortalAgentInstructionsConfig,
  context: import('playwright').BrowserContext,
  conversationUrl: string,
  browserProfileDir: string,
  signal?: AbortSignal,
  onStopTarget?: (target: StopTarget | null) => void
): Promise<PendingThreadHistoryEntry | null> {
  const resolved = resolveConversationUrl(conversationUrl)
  if (resolved === null) {
    ui.renderWarning(
      '/thread resume',
      `Unsupported conversation URL: ${conversationUrl}`
    )
    return null
  }

  const threadId = threadManager.createThreadId()
  const pendingTimeline = showPendingThreadTimeline(ui, threadManager, threadId)
  const provider = resolved.provider
  let waitingForLogin = false
  ui.setBusy(true)

  try {
    throwIfAborted(signal)
    const projectInstructions = await createProjectInstructions(
      instructionConfig,
      (warning) => {
        ui.renderWarning('instructions', formatInstructionWarning(warning))
      }
    )
    throwIfAborted(signal)
    const runtime = await initializeRuntimeWithLoginWait({
      provider,
      browserProfileDir,
      threadId,
      createAdapter: async () => {
        const adapter = await createAdapterForProvider(
          context,
          provider,
          resolved.conversationUrl,
          signal
        )
        onStopTarget?.(adapter)
        return adapter
      },
      createRuntime: async (adapter) =>
        await createRuntimeFromAdapter(adapter, {
          model: null,
          providerPrompt: getProviderPrompt(provider),
          skillLibrary,
          mcpLibrary,
          onMcpWarning: async (warning) => {
            ui.renderWarning('MCP', warning.markdown, 'markdown')
          },
          toolServices: createToolServices({
            context,
            provider,
            model: null,
            skillLibrary,
            mcpLibrary,
            projectInstructions,
          }),
          skipSetup: true,
          signal,
        }),
      onWarning: async (plan) => {
        const transition = transitionLoginWaitWarning(
          waitingForLogin,
          plan.requiresLogin
        )
        waitingForLogin = transition.waitingForLogin
        if (transition.shouldRender) {
          ui.renderWarning(plan.title, plan.lines)
        }
      },
      onLoginWait: async () => {
        waitingForLogin = true
      },
      waitForLogin: async () => {
        await sleepWithAbortAsync(LOGIN_CHECK_INTERVAL_MS, signal)
      },
      signal,
    })
    if (signal?.aborted) {
      await runtime?.close().catch(() => {})
      throwIfAborted(signal)
    }
    onStopTarget?.(runtime)
    if (runtime === null) {
      pendingTimeline.discard()
      ui.renderWarning('/thread resume', [
        'Could not resume this conversation.',
        'No thread was created. Check the browser page or URL, then run /thread resume again.',
      ])
      return null
    }

    const thread = threadManager.addThread({
      id: threadId,
      provider,
      runtime,
      createdAt: Date.now(),
    })
    pendingTimeline.keep()
    waitingForLogin = false
    ui.showThreadTimeline(thread.id)
    ui.renderInfo(
      '/thread resume',
      [
        `Thread ${threadId} is ready.`,
        `Provider: ${provider}`,
        `Conversation URL: ${runtime.conversationUrl}`,
      ].join('\n')
    )
    let history: ConversationHistoryResult
    try {
      history = await runtime.loadHistory({ signal })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      history = {
        messages: [],
        complete: false,
        warning: `Could not load remote conversation history: ${String(error)}`,
      }
    }
    ui.renderConversationHistory(thread, history.messages)
    if (history.warning !== null) {
      ui.renderWarning('/thread resume', history.warning, 'markdown')
    }
    return {
      provider,
      conversationUrl: runtime.conversationUrl,
      createdAt: thread.createdAt,
    }
  } catch (error) {
    if (isAbortError(error)) {
      pendingTimeline.discard()
      ui.renderWarning('/thread resume', 'Cancelled resuming conversation.')
      return null
    }
    throw error
  } finally {
    pendingTimeline.discard()
    ui.setBusy(false)
  }
}

export async function run(argv = process.argv): Promise<void> {
  const program = buildProgram()
  program.parse(argv)

  const options = program.opts<Options>()
  const dataDirectory = path.join(process.cwd(), 'data')
  const configPath = path.join(dataDirectory, 'config.yaml')
  const skillLibrary = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath: configPath,
  })
  await skillLibrary.initialize()
  const portalConfig = await ensurePortalConfig(
    configPath,
    createDefaultPortalConfig(dataDirectory)
  )
  const browserName = options.browserName ?? portalConfig.browser.name
  const browserExecutablePath = path.resolve(
    options.browserExecutablePath ?? portalConfig.browser.executablePath
  )
  const browserRemoteDebuggingPort =
    options.browserRemoteDebuggingPort === undefined
      ? portalConfig.browser.remoteDebuggingPort
      : Number(options.browserRemoteDebuggingPort)
  if (
    !Number.isSafeInteger(browserRemoteDebuggingPort) ||
    browserRemoteDebuggingPort <= 0 ||
    browserRemoteDebuggingPort > 65_535
  ) {
    throw new Error(
      `Invalid browser remote debugging port: ${browserRemoteDebuggingPort}`
    )
  }
  const browserProfileDir = path.resolve(portalConfig.browser.profilePath)
  const mcpLibrary = new McpLibrary(configPath)
  await mcpLibrary.initialize()
  const threadStore = await createThreadStore(
    path.join(dataDirectory, 'threads.db')
  )
  const threadManager = new ThreadManager()
  const threadOperations = new ThreadOperationCoordinator()
  const commandRegistry = new CommandRegistry(DEFAULT_COMMANDS)
  const ui = new TerminalController()
  ui.bindThreadManager(threadManager)
  let currentOperation: {
    controller: AbortController
    stopTarget: StopTarget | null
    done: Promise<unknown>
  } | null = null
  let browserLaunch: Awaited<ReturnType<typeof launchBrowser>> | null = null
  let apiServer: PortalApiServer | null = null
  let exitRequested = false
  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  const shutdown = async () => {
    if (shutdownPromise !== null) {
      return await shutdownPromise
    }

    shutdownPromise = (async () => {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      try {
        if (apiServer !== null) {
          await apiServer.stop().catch(() => {})
        }
        const foregroundOperation = currentOperation
        if (foregroundOperation !== null) {
          foregroundOperation.controller.abort()
          const stopGeneration = Promise.resolve().then(
            async () => await foregroundOperation.stopTarget?.stopGeneration()
          )
          await Promise.allSettled([stopGeneration, foregroundOperation.done])
        }
        await threadOperations.cancelAll()

        for (const thread of threadManager.listThreads()) {
          await closeWithTimeout(async () => await thread.runtime.close())
        }

        if (browserLaunch !== null) {
          const activeBrowserLaunch = browserLaunch
          browserLaunch = null
          await closeWithTimeout(async () => await activeBrowserLaunch.close())
        }

        threadStore.close()
      } finally {
        shuttingDown = false
        shutdownPromise = null
      }
    })()

    return await shutdownPromise
  }

  const requestExit = async () => {
    if (exitRequested) {
      return
    }

    exitRequested = true
    ui.cancelPendingInput(new PortalExitError())
    await shutdown()
  }

  const withCancellableOperation = async <T>(
    stopTarget: StopTarget | null,
    runOperation: (
      signal: AbortSignal,
      setStopTarget: (target: StopTarget | null) => void
    ) => Promise<T>
  ): Promise<T> => {
    const previousOperation = currentOperation
    const controller = new AbortController()
    const operation = {
      controller,
      stopTarget,
      done: Promise.resolve() as Promise<unknown>,
    }
    currentOperation = operation
    const setStopTarget = (target: StopTarget | null) => {
      if (currentOperation?.controller === controller) {
        currentOperation.stopTarget = target
      }
    }
    try {
      const done = Promise.resolve().then(
        async () => await runOperation(controller.signal, setStopTarget)
      )
      operation.done = done
      return await done
    } finally {
      if (currentOperation?.controller === controller) {
        currentOperation = previousOperation
      }
    }
  }

  const submitThreadInput = async (
    input: string,
    displayInput = input
  ): Promise<void> => {
    const activeThread = threadManager.getActiveThread()
    if (activeThread === null) {
      ui.renderWarning(
        'portal',
        'No active thread. Use /thread open to create one, or /help to see commands.'
      )
      return
    }

    const startResult = threadOperations.tryStart(
      activeThread.id,
      activeThread.runtime,
      async ({ signal }) => {
        try {
          while (true) {
            try {
              await threadManager.submitThreadInput(activeThread.id, input, {
                signal,
                onAssistantStream: async (message) => {
                  throwIfAborted(signal)
                  ui.renderAssistantStream(activeThread, message)
                },
                onManualSkill: async (name) => {
                  throwIfAborted(signal)
                  ui.renderThreadInfo(
                    activeThread,
                    'skill',
                    `Using skill: ${name}`
                  )
                },
                onInstructionWarning: async (warning) => {
                  throwIfAborted(signal)
                  ui.renderThreadWarning(
                    activeThread,
                    'instructions',
                    formatInstructionWarning(warning)
                  )
                },
                onToolProgress: (event, toolCall) => {
                  if (
                    signal.aborted ||
                    (toolCall?.tool !== 'run_command' &&
                      toolCall?.tool !== 'spawn')
                  ) {
                    return
                  }
                  ui.renderToolProgress(activeThread, toolCall.tool, event)
                },
                onTurnItem: async (item) => {
                  throwIfAborted(signal)
                  if (item.kind === 'assistant_text') {
                    ui.renderAssistantMessage(activeThread, item.text)
                    return
                  }
                  if (item.kind === 'tool_call') {
                    ui.setThreadLastToolName(activeThread.id, item.toolName)
                    ui.renderToolCall(
                      activeThread,
                      item.toolName,
                      item.rawPayload
                    )
                    return
                  }
                  if (item.kind === 'tool_result') {
                    ui.setThreadLastToolName(activeThread.id, item.toolName)
                    ui.renderToolResult(
                      activeThread,
                      item.toolName,
                      item.outcome,
                      item.result,
                      item.displayText
                    )
                    return
                  }
                  if (item.kind === 'status') {
                    ui.renderThreadWarning(activeThread, 'thread', item.text)
                    return
                  }
                  if (item.kind === 'error') {
                    ui.renderThreadError(activeThread, 'thread', item.text)
                  }
                },
              })
              await threadStore.touch({
                provider: activeThread.provider,
                conversationUrl: activeThread.runtime.conversationUrl,
                title: null,
              })
              await threadStore.setTitleIfEmpty({
                conversationUrl: activeThread.runtime.conversationUrl,
                title: buildThreadHistoryTitle(displayInput),
              })
              break
            } catch (error) {
              if (isAbortError(error)) {
                ui.commitLiveAssistant(activeThread)
                ui.renderThreadWarning(
                  activeThread,
                  'thread',
                  'Cancelled current message.'
                )
                break
              }
              const plan = buildRuntimeRecoveryPlan(error, {
                provider: activeThread.provider,
                browserProfileDir,
                threadId: activeThread.id,
              })
              ui.renderThreadWarning(activeThread, plan.title, plan.lines)
              if (!plan.canRetry) {
                ui.renderThreadError(activeThread, 'error', String(error))
                break
              }
              await tryRestoreRuntimeForRecovery(error, async () => {
                await activeThread.runtime.restore()
              })
              break
            }
          }
        } catch (error) {
          ui.renderThreadError(activeThread, 'runtime', String(error))
        } finally {
          ui.clearLiveCommand(activeThread)
          ui.setThreadBusy(activeThread.id, false)
        }
      }
    )

    if (!startResult.accepted) {
      ui.renderThreadWarning(
        activeThread,
        'thread',
        startResult.reason === 'closing'
          ? `Thread ${activeThread.id} is closing.`
          : `Thread ${activeThread.id} is already running.`
      )
      return
    }

    ui.renderUserMessage(activeThread, displayInput)
    ui.setThreadBusy(activeThread.id, true)
    void startResult.operation.done.catch((error) => {
      if (!isAbortError(error)) {
        ui.renderThreadError(activeThread, 'runtime', String(error))
      }
    })
  }

  ui.renderWelcome({
    browserStatus: 'connecting',
    directory: process.cwd(),
    version: PORTAL_VERSION,
  })
  clearTerminalBeforeRender(stdout)

  const inkApp = render(
    createElement(TerminalScreen, {
      ui,
      commands: commandRegistry.list(),
      onInterrupt: () => {
        const state = ui.getState()
        if (
          currentOperation !== null &&
          !currentOperation.controller.signal.aborted
        ) {
          const operation = currentOperation
          operation.controller.abort()
          void Promise.resolve()
            .then(async () => await operation.stopTarget?.stopGeneration())
            .catch(() => {})
          return
        }
        const activeThreadId = threadManager.getActiveThread()?.id ?? null
        if (
          activeThreadId !== null &&
          threadOperations.get(activeThreadId) !== null
        ) {
          void threadOperations.cancel(activeThreadId)
          return
        }
        if (!state.busy) {
          void requestExit()
          return
        }

        return
      },
    }),
    {
      stdin,
      stdout,
      exitOnCtrlC: false,
      reserveTrailingLine: false,
    }
  )

  ui.setScreenResetter(() => clearInteractiveTerminal(inkApp, stdout))

  void inkApp.waitUntilExit().then(async () => {
    ui.setScreenResetter(null)
    await requestExit()
  })

  try {
    try {
      browserLaunch = await launchBrowser(
        browserName,
        browserExecutablePath,
        browserRemoteDebuggingPort,
        browserProfileDir
      )
    } catch (error) {
      ui.setBrowserConnected(false)
      ui.renderError('error', String(error))
      process.exitCode = 1
      return
    }
    if (exitRequested) {
      await shutdown()
      return
    }
    const context = browserLaunch.context

    ui.setBrowserConnected(true)

    const getApiThread = (threadId: string) => {
      const thread = threadManager.getThread(threadId)
      if (thread === null) {
        throw new ApiHttpError(
          404,
          'THREAD_NOT_FOUND',
          `Unknown thread: ${threadId}`
        )
      }
      return thread
    }

    const toApiThread = (threadId: string) => {
      const thread = getApiThread(threadId)
      return {
        id: thread.id,
        provider: thread.provider,
        title: thread.title,
        conversationUrl: thread.runtime.conversationUrl,
        busy: threadOperations.get(thread.id) !== null,
        active: threadManager.getActiveThread()?.id === thread.id,
        turnCount: thread.turnCount,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }
    }

    const publishApiEvent = (
      threadId: string,
      type: Parameters<PortalApiServer['eventHub']['publish']>[1]['type'],
      data: Record<string, unknown> = {}
    ) => {
      apiServer!.eventHub.publish(threadId, { type, data })
    }

    type ThreadReloadStartResult =
      | {
          accepted: true
          operationId: string
          operation: ThreadOperationHandle
        }
      | {
          accepted: false
          reason: 'not_found' | 'busy'
        }

    const startThreadReload = (threadId: string): ThreadReloadStartResult => {
      const thread = threadManager.getThread(threadId)
      if (thread === null) {
        return { accepted: false, reason: 'not_found' }
      }

      const operationId = randomUUID()
      const startResult = threadOperations.tryStart(
        threadId,
        null,
        async ({ signal }) => {
          try {
            throwIfAborted(signal)
            publishApiEvent(threadId, 'thread.action', {
              operationId,
              action: 'reload',
              phase: 'started',
            })
            await thread.runtime.restore({ signal })
            throwIfAborted(signal)
            ui.renderThreadInfo(
              thread,
              'thread reload',
              'Provider page reloaded.'
            )
            publishApiEvent(threadId, 'thread.action', {
              operationId,
              action: 'reload',
              phase: 'completed',
            })
          } catch (error) {
            const cancelled = isAbortError(error)
            const message =
              error instanceof Error ? error.message : String(error)
            publishApiEvent(threadId, 'thread.action', {
              operationId,
              action: 'reload',
              phase: cancelled ? 'cancelled' : 'failed',
              ...(cancelled ? {} : { message }),
            })
            if (!cancelled) {
              ui.renderThreadWarning(thread, 'thread reload', message)
            }
            throw error
          } finally {
            ui.setThreadBusy(threadId, false)
          }
        }
      )

      if (!startResult.accepted) {
        return { accepted: false, reason: 'busy' }
      }
      ui.setThreadBusy(threadId, true)
      return {
        accepted: true,
        operationId,
        operation: startResult.operation,
      }
    }

    const startApiMessage = async (threadId: string, input: string) => {
      const thread = getApiThread(threadId)
      let lastAssistantStream = ''
      const startResult = threadOperations.tryStart(
        threadId,
        thread.runtime,
        async ({ signal }) => {
          try {
            throwIfAborted(signal)
            publishApiEvent(threadId, 'message.started', { input })
            const result = await threadManager.submitThreadInput(
              threadId,
              input,
              {
                signal,
                onAssistantStream: async (message) => {
                  const delta = message.startsWith(lastAssistantStream)
                    ? message.slice(lastAssistantStream.length)
                    : message
                  lastAssistantStream = message
                  publishApiEvent(threadId, 'assistant.delta', {
                    text: delta,
                  })
                  ui.renderAssistantStream(thread, message)
                },
                onManualSkill: async (name) => {
                  publishApiEvent(threadId, 'status', {
                    message: `Using skill: ${name}`,
                  })
                  ui.renderThreadInfo(thread, 'skill', `Using skill: ${name}`)
                },
                onToolProgress: (event, toolCall) => {
                  publishApiEvent(threadId, 'tool.output', {
                    tool: toolCall?.tool ?? 'unknown',
                    event,
                  })
                },
                onTurnItem: async (item) => {
                  if (item.kind === 'assistant_text') {
                    lastAssistantStream = ''
                    publishApiEvent(threadId, 'assistant.message', {
                      text: item.text,
                    })
                    ui.renderAssistantMessage(thread, item.text)
                  } else if (item.kind === 'tool_call') {
                    publishApiEvent(threadId, 'tool.started', {
                      tool: item.toolName,
                      payload: item.rawPayload,
                    })
                    ui.renderToolCall(thread, item.toolName, item.rawPayload)
                  } else if (item.kind === 'tool_result') {
                    publishApiEvent(threadId, 'tool.completed', {
                      tool: item.toolName,
                      outcome: item.outcome,
                      result: item.result,
                      ...(item.displayText === undefined
                        ? {}
                        : { displayText: item.displayText }),
                    })
                    ui.renderToolResult(
                      thread,
                      item.toolName,
                      item.outcome,
                      item.result,
                      item.displayText
                    )
                  } else if (item.kind === 'status') {
                    publishApiEvent(threadId, 'status', { message: item.text })
                    ui.renderThreadWarning(thread, 'thread', item.text)
                  } else if (item.kind === 'error') {
                    ui.renderThreadError(thread, 'thread', item.text)
                  }
                },
              }
            )
            await threadStore.touch({
              provider: thread.provider,
              conversationUrl: thread.runtime.conversationUrl,
              title: null,
            })
            await threadStore.setTitleIfEmpty({
              conversationUrl: thread.runtime.conversationUrl,
              title: buildThreadHistoryTitle(input),
            })
            publishApiEvent(threadId, 'message.completed', {
              assistant: result?.assistant ?? '',
            })
          } catch (error) {
            if (isAbortError(error)) {
              publishApiEvent(threadId, 'message.cancelled')
            } else {
              publishApiEvent(threadId, 'message.failed', {
                message: error instanceof Error ? error.message : String(error),
              })
            }
            throw error
          } finally {
            ui.clearLiveCommand(thread)
            ui.setThreadBusy(thread.id, false)
          }
        }
      )

      if (!startResult.accepted) {
        throw new ApiHttpError(
          409,
          'THREAD_BUSY',
          `Thread ${threadId} already has an active operation.`
        )
      }
      ui.renderUserMessage(thread, input)
      ui.setThreadBusy(thread.id, true)
      void startResult.operation.done.catch(() => {})
      return {
        accepted: true,
        status: 'busy',
        threadId,
      }
    }

    const apiHandlers: ApiHandlers = {
      status: () => ({
        browserConnected: browserLaunch !== null,
        activeThreadId: threadManager.getActiveThread()?.id ?? null,
        busy: threadOperations.list().length > 0,
        server: apiServer!.status(),
      }),
      providers: () => [...PROVIDERS],
      listThreads: () =>
        threadManager.listThreads().map(({ id }) => toApiThread(id)),
      getThread: (threadId) => toApiThread(threadId),
      createThread: async (input) => {
        if (currentOperation !== null) {
          throw new ApiHttpError(
            409,
            'OPERATION_BUSY',
            'Another foreground operation is already running.'
          )
        }
        const providerValue = input.provider
        if (typeof providerValue !== 'string') {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'provider is required.'
          )
        }
        const provider = normalizeProviderId(providerValue)
        if (provider === null) {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            `Unsupported provider: ${providerValue}`
          )
        }
        const model = input.model
        if (
          model !== undefined &&
          model !== null &&
          typeof model !== 'string'
        ) {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'model must be a string or null.'
          )
        }
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          const historyEntry = await openThread(
            ui,
            threadManager,
            skillLibrary,
            mcpLibrary,
            portalConfig.agentInstructions,
            context,
            provider,
            model === undefined ? null : model,
            browserProfileDir,
            signal,
            setStopTarget
          )
          if (historyEntry === null) {
            throw new ApiHttpError(
              502,
              'THREAD_OPEN_FAILED',
              'Could not open the provider thread.'
            )
          }
          await threadStore.touch({
            provider: historyEntry.provider,
            conversationUrl: historyEntry.conversationUrl,
            title: null,
            createdAt: historyEntry.createdAt,
          })
        })
        const active = threadManager.getActiveThread()
        if (active === null) {
          throw new ApiHttpError(
            500,
            'INTERNAL_ERROR',
            'Thread was created but is unavailable.'
          )
        }
        return toApiThread(active.id)
      },
      resumeThread: async (input) => {
        if (currentOperation !== null) {
          throw new ApiHttpError(
            409,
            'OPERATION_BUSY',
            'Another foreground operation is already running.'
          )
        }
        if (
          typeof input.conversationUrl !== 'string' ||
          input.conversationUrl.trim() === ''
        ) {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'conversationUrl is required.'
          )
        }
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          const historyEntry = await resumeThread(
            ui,
            threadManager,
            skillLibrary,
            mcpLibrary,
            portalConfig.agentInstructions,
            context,
            input.conversationUrl as string,
            browserProfileDir,
            signal,
            setStopTarget
          )
          if (historyEntry === null) {
            throw new ApiHttpError(
              502,
              'THREAD_RESUME_FAILED',
              'Could not resume the conversation.'
            )
          }
          await threadStore.touch({
            provider: historyEntry.provider,
            conversationUrl: historyEntry.conversationUrl,
            title: null,
            createdAt: historyEntry.createdAt,
          })
        })
        const active = threadManager.getActiveThread()
        if (active === null) {
          throw new ApiHttpError(
            500,
            'INTERNAL_ERROR',
            'Thread was resumed but is unavailable.'
          )
        }
        return toApiThread(active.id)
      },
      closeThread: async (threadId) => {
        getApiThread(threadId)
        ui.setThreadBusy(threadId, true)
        try {
          const closed = await threadOperations.close(
            threadId,
            async () => await threadManager.closeThread(threadId)
          )
          if (!closed) {
            throw new ApiHttpError(
              404,
              'THREAD_NOT_FOUND',
              `Unknown thread: ${threadId}`
            )
          }
          return { closed: true, threadId }
        } catch (error) {
          if (error instanceof ThreadCloseTimeoutError) {
            throw new ApiHttpError(409, 'THREAD_CLOSE_TIMEOUT', error.message)
          }
          throw error
        } finally {
          if (threadOperations.get(threadId) === null) {
            ui.setThreadBusy(threadId, false)
          }
        }
      },
      submitMessage: startApiMessage,
      reloadThread: async (threadId) => {
        const result = startThreadReload(threadId)
        if (!result.accepted) {
          if (result.reason === 'not_found') {
            throw new ApiHttpError(
              404,
              'THREAD_NOT_FOUND',
              `Unknown thread: ${threadId}`
            )
          }
          throw new ApiHttpError(
            409,
            'THREAD_BUSY',
            `Thread ${threadId} already has an active operation.`
          )
        }
        void result.operation.done.catch(() => {})
        return {
          accepted: true,
          status: 'busy',
          operationId: result.operationId,
          action: 'reload',
          threadId,
        }
      },
      cancelMessage: async (threadId) => {
        getApiThread(threadId)
        const running = threadOperations.get(threadId) !== null
        await threadOperations.cancel(threadId)
        return { cancelled: running, threadId }
      },
      activateSkill: async (threadId, name) => {
        const skills = await skillLibrary.list()
        const skill = skills.skills.find((item) => item.name === name)
        if (skill === undefined || !skill.enabled) {
          throw new ApiHttpError(
            404,
            'SKILL_NOT_AVAILABLE',
            `Skill is not enabled: ${name}`
          )
        }
        return await startApiMessage(threadId, `$${name}`)
      },
      listCapabilities: async (threadId) => {
        const thread = getApiThread(threadId)
        return {
          provider: thread.provider,
          capabilities: await listProviderCapabilityStates(
            thread.provider,
            thread.runtime
          ),
        }
      },
      setCapability: async (threadId, name, state) => {
        const thread = getApiThread(threadId)
        const isToggleProvider =
          thread.provider === 'deepseek' || thread.provider === 'glm'
        if (isToggleProvider && state !== 'on' && state !== 'off') {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'Toggle capability state must be on or off.'
          )
        }
        if (!isToggleProvider && state !== 'selected' && state !== 'on') {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'Action capability state must be selected or on.'
          )
        }
        const args = isToggleProvider ? [state] : []
        const execution = await executeProviderCapability(
          thread.provider,
          thread.runtime,
          name,
          args
        )
        if (execution.status !== 'ok') {
          throw new ApiHttpError(400, 'CAPABILITY_ERROR', execution.result.body)
        }
        return { name, state: execution.result.body }
      },
      clearCapability: async (threadId, name) => {
        const thread = getApiThread(threadId)
        const isToggleProvider =
          thread.provider === 'deepseek' || thread.provider === 'glm'
        const execution = await executeProviderCapability(
          thread.provider,
          thread.runtime,
          isToggleProvider ? name : 'none',
          isToggleProvider ? ['off'] : []
        )
        if (execution.status !== 'ok') {
          throw new ApiHttpError(400, 'CAPABILITY_ERROR', execution.result.body)
        }
        return { name, cleared: true }
      },
      listSkills: async () => await skillLibrary.list(),
      addSkill: async (input) => {
        if (typeof input.source !== 'string' || input.source.trim() === '') {
          throw new ApiHttpError(400, 'INVALID_REQUEST', 'source is required.')
        }
        const registryUrl = input.registryUrl
        if (registryUrl !== undefined && typeof registryUrl !== 'string') {
          throw new ApiHttpError(
            400,
            'INVALID_REQUEST',
            'registryUrl must be a string.'
          )
        }
        return await skillLibrary.add(
          input.source,
          registryUrl === undefined ? {} : { registryUrl }
        )
      },
      setSkillEnabled: async (name, enabled) => {
        const changed = enabled
          ? await skillLibrary.enable(name)
          : await skillLibrary.disable(name)
        if (!changed) {
          throw new ApiHttpError(
            404,
            'SKILL_NOT_FOUND',
            `Unknown skill: ${name}`
          )
        }
        return { name, enabled }
      },
      removeSkill: async (name) => {
        if (!(await skillLibrary.remove(name))) {
          throw new ApiHttpError(
            404,
            'SKILL_NOT_FOUND',
            `Unknown skill: ${name}`
          )
        }
        return { removed: true, name }
      },
      listMcpServers: async () => {
        const result = await mcpLibrary.list()
        return {
          issues: result.issues,
          servers: result.servers.map(({ name, enabled, config }) => ({
            name,
            enabled,
            config: redactMcpConfig(config),
          })),
        }
      },
      addMcpServer: async (name, config) => {
        await mcpLibrary.add(name, config as McpServerConfig)
        return { name, added: true }
      },
      setMcpServer: async (name, config) => {
        await mcpLibrary.set(name, config as McpServerConfig)
        return { name, updated: true }
      },
      removeMcpServer: async (name) => {
        if (!(await mcpLibrary.remove(name))) {
          throw new ApiHttpError(
            404,
            'MCP_NOT_FOUND',
            `Unknown MCP server: ${name}`
          )
        }
        return { removed: true, name }
      },
      setMcpServerEnabled: async (name, enabled) => {
        const changed = enabled
          ? await mcpLibrary.enable(name)
          : await mcpLibrary.disable(name)
        if (!changed) {
          throw new ApiHttpError(
            404,
            'MCP_NOT_FOUND',
            `Unknown MCP server: ${name}`
          )
        }
        return { name, enabled }
      },
      listMcpResources: async (threadId, server) => {
        const session = getApiThread(threadId).runtime.getMcpSession()
        if (session === null) {
          return { items: [], issues: [] }
        }
        return await session.listResources(server)
      },
      listMcpPrompts: async (threadId, server) => {
        const session = getApiThread(threadId).runtime.getMcpSession()
        if (session === null) {
          return { items: [], issues: [] }
        }
        return await session.listPrompts(server)
      },
    }

    apiServer = new PortalApiServer({
      host: portalConfig.api.host,
      port: portalConfig.api.port,
      token: portalConfig.api.token,
      handlers: apiHandlers,
    })

    const commandContext: CliCommandContext = {
      readline: {} as CliCommandContext['readline'],
      threadManager,
      threadStore,
      skillLibrary,
      mcpLibrary,
      api: apiServer,
      ui,
      browserProfileDir,
      providers: PROVIDERS,
      resolveProvider: normalizeProviderId,
      createThread: async (provider: ProviderId, model: string | null) =>
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          const historyEntry = await openThread(
            ui,
            threadManager,
            skillLibrary,
            mcpLibrary,
            portalConfig.agentInstructions,
            context,
            provider,
            model,
            browserProfileDir,
            signal,
            setStopTarget
          )
          if (historyEntry !== null) {
            await threadStore.touch({
              provider: historyEntry.provider,
              conversationUrl: historyEntry.conversationUrl,
              title: null,
              createdAt: historyEntry.createdAt,
            })
          }
        }),
      resumeThread: async (conversationUrl: string) =>
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          const historyEntry = await resumeThread(
            ui,
            threadManager,
            skillLibrary,
            mcpLibrary,
            portalConfig.agentInstructions,
            context,
            conversationUrl,
            browserProfileDir,
            signal,
            setStopTarget
          )
          if (historyEntry !== null) {
            await threadStore.touch({
              provider: historyEntry.provider,
              conversationUrl: historyEntry.conversationUrl,
              title: null,
              createdAt: historyEntry.createdAt,
            })
          }
        }),
      reloadThread: async (threadId: string) => {
        const result = startThreadReload(threadId)
        if (!result.accepted) {
          throw new Error(
            result.reason === 'not_found'
              ? `Unknown thread: ${threadId}`
              : `Thread ${threadId} already has an active operation.`
          )
        }
        void result.operation.done.catch(() => {})
      },
      closeThread: async (threadId: string) => {
        if (threadManager.getThread(threadId) === null) {
          return false
        }
        ui.setThreadBusy(threadId, true)
        try {
          return await threadOperations.close(threadId, async () => {
            return await threadManager.closeThread(threadId)
          })
        } finally {
          if (threadOperations.get(threadId) === null) {
            ui.setThreadBusy(threadId, false)
          }
        }
      },
      addSkill: async (source, options = {}) =>
        await withCancellableOperation(
          null,
          async (signal) =>
            await skillLibrary.add(source, { ...options, signal })
        ),
      submitThreadInput,
      listCommands: () => commandRegistry.list(),
    }

    while (true) {
      const input = (
        await ui.requestInput(
          ui.promptLabel(threadManager),
          'Type a task or enter a slash command.'
        )
      ).trim()
      if (exitRequested) {
        await shutdown()
        return
      }
      if (!input) {
        ui.renderWarning(
          'portal',
          'No active thread. Use /thread open to create one, or /help to see commands.'
        )
        continue
      }

      try {
        if (input.startsWith('/')) {
          const activeThread = threadManager.getActiveThread()
          if (
            activeThread !== null &&
            threadOperations.get(activeThread.id) !== null &&
            !canRunCommandWhileThreadBusy(input)
          ) {
            ui.renderThreadWarning(
              activeThread,
              'thread',
              `Thread ${activeThread.id} is running; this command cannot run until the current turn finishes.`
            )
            continue
          }
          const commandResult = await commandRegistry.execute(
            input,
            commandContext
          )
          if (commandResult === null) {
            ui.renderWarning('portal', [
              `Unknown command: ${input.split(/\s+/)[0]}`,
              'Use /help to see available commands.',
            ])
            continue
          }
          if (!commandResult.continue) {
            break
          }
          continue
        }

        await submitThreadInput(input)
      } catch (error) {
        ui.renderError('runtime', String(error))
      }
    }
  } catch (error) {
    if (!(error instanceof PortalExitError)) {
      throw error
    }
  } finally {
    await shutdown()
    inkApp.unmount()
  }
}
