import path from 'path'
import { createRequire } from 'node:module'
import { stdin, stdout } from 'process'
import { Command } from 'commander'
import { render } from './vendor/ink.ts'
import { createElement } from 'react'
import { launchBrowser } from './platform/browser-cdp-launcher.ts'
import type { RuntimeCore } from './runtime/runtime-core.ts'
import { createRuntimeFromAdapter } from './runtime/runtime-factory.ts'
import { RunCommandJobManager } from './processes/run-command-job-manager.ts'
import { isAbortError } from './runtime/runtime-cancellation.ts'
import { sleepWithAbortAsync } from './shared/sleep.ts'
import { ThreadManager } from './threads/thread-manager.ts'
import type { ThreadCreationMode } from './threads/thread-creation-mode.ts'
import { ThreadOperationCoordinator } from './threads/thread-operation-coordinator.ts'
import type { ProviderId } from './providers/provider-id.ts'
import type { ResolvedProviderModel } from './providers/provider-model-catalog.ts'
import { ComposerLimitExceededError } from './providers/composer-limit.ts'
import { createThreadStore } from './threads/thread-store.ts'
import { DEFAULT_COMMANDS } from './cli-commands/command-set.ts'
import { CommandRegistry } from './cli-commands/core/command-registry.ts'
import type { CliCommandContext } from './cli-commands/core/command-types.ts'
import { resolveConversationUrl } from './providers/provider-conversation-url.ts'
import {
  renderTimelineEntryToAnsi,
  TerminalScreen,
} from './terminal-ui/terminal-screen.tsx'
import { TerminalTranscriptWriter } from './terminal-ui/terminal-transcript-writer.ts'
import { KeybindingCatalog } from './keybindings/keybinding-catalog.ts'
import { TerminalController } from './terminal-ui/terminal-controller.ts'
import { SkillLibrary } from './skills/skill-library.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from './config/portal-config.ts'
import { loadProjectInstructions } from './instructions/project-instructions.ts'
import {
  PortalMcpServer,
  resolvePortalMcpToken,
} from './mcp-server/mcp-server.ts'
import { McpMessageOperationStore } from './mcp-server/mcp-message-operations.ts'
import {
  ThreadLifecycleService,
  type ThreadLifecycleEvent,
} from './threads/thread-lifecycle-service.ts'
import { ThreadRuntimeRegistry } from './threads/thread-runtime-registry.ts'
import {
  PortalExitError,
  closeLateBrowserLaunchAfterShutdown,
  closeWithTimeout,
  createIdempotentAsyncTask,
  stopMcpForegroundOperation,
  type McpForegroundOperation,
  type StopTarget,
} from './app/app-lifecycle.ts'
import {
  PROVIDERS,
  createAdapterForProvider,
  normalizeProviderId,
} from './app/app-provider-catalog.ts'
import {
  createPortalRuntimeSettings,
  runtimeSetupModeForThreadCreation,
} from './app/app-runtime-settings.ts'
import { createMcpHandlers } from './app/app-mcp-handlers.ts'
import { startThreadReload } from './app/app-thread-reload.ts'
import { createToolServices } from './app/app-spawn-tool-services.ts'
import { createTuiThreadInputHandler } from './app/app-tui-thread-input-handler.ts'
import { resolvePortalDataDirectory } from './platform/portal-data-directory.ts'
import {
  canRunCommandWhileThreadBusy,
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  showPendingThreadTimeline,
} from './app/app-terminal-lifecycle.ts'

export {
  closeLateBrowserLaunchAfterShutdown,
  closeWithTimeout,
  createIdempotentAsyncTask,
  stopMcpForegroundOperation,
  transitionLoginWaitWarning,
  type McpForegroundOperation,
} from './app/app-lifecycle.ts'
export { PROVIDERS } from './app/app-provider-catalog.ts'
export {
  createPortalRuntimeSettings,
  runtimeSetupModeForThreadCreation,
} from './app/app-runtime-settings.ts'
export { inheritSpawnModelSelection } from './app/app-spawn-tool-services.ts'
export {
  canRunCommandWhileThreadBusy,
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  shouldRenderFallbackThreadError,
  showPendingThreadTimeline,
} from './app/app-terminal-lifecycle.ts'

const LOGIN_CHECK_INTERVAL_MS = 1000
const PORTAL_VERSION = readPortalVersion()

function readPortalVersion(): string {
  const packageMetadata: unknown = createRequire(import.meta.url)(
    '../package.json'
  )
  if (
    typeof packageMetadata !== 'object' ||
    packageMetadata === null ||
    !('version' in packageMetadata) ||
    typeof packageMetadata.version !== 'string'
  ) {
    throw new Error('package.json must contain a string version.')
  }
  return packageMetadata.version
}

interface Options {
  browserExecutablePath?: string
  dataDir?: string
}

export interface PortalRunDependencies {
  cwd?: string
  launchBrowser?: typeof launchBrowser
  renderTerminal?: typeof render
  terminalController?: TerminalController
  createProviderAdapter?: typeof createAdapterForProvider
  createRuntime?: typeof createRuntimeFromAdapter
}

function buildProgram() {
  return new Command()
    .name('portal')
    .description(
      'A browser-based agent CLI for working across multiple web AI providers.'
    )
    .version(PORTAL_VERSION)
    .option(
      '--browser-executable-path <path>',
      'path to the browser executable used when launching a browser for CDP'
    )
    .option(
      '--data-dir <path>',
      'directory for config, history, skills, and the browser profile'
    )
    .addHelpText(
      'after',
      [
        '',
        'Commands:',
        '  exec [options] [task]  Run one agent task without starting the TUI',
        '  config [options]       Print the configuration file path',
      ].join('\n')
    )
}

export async function run(
  argv = process.argv,
  dependencies: PortalRunDependencies = {}
): Promise<void> {
  const program = buildProgram()
  program.parse(argv)

  const options = program.opts<Options>()
  const cwd = path.resolve(dependencies.cwd ?? process.cwd())
  const launchBrowserForRun = dependencies.launchBrowser ?? launchBrowser
  const renderTerminal = dependencies.renderTerminal ?? render
  const createProviderAdapter =
    dependencies.createProviderAdapter ?? createAdapterForProvider
  const createRuntime = dependencies.createRuntime ?? createRuntimeFromAdapter
  const dataDirectory = resolvePortalDataDirectory({
    cwd,
    ...(options.dataDir === undefined
      ? {}
      : { dataDirectory: options.dataDir }),
  })
  const configPath = path.join(dataDirectory, 'config.yaml')
  const defaultPortalConfig = createDefaultPortalConfig(dataDirectory)
  const settings = createPortalRuntimeSettings()
  const skillRegistryPath = path.join(dataDirectory, 'state', 'skills.json')
  const portalConfig = await ensurePortalConfig(configPath, defaultPortalConfig)
  const skillLibrary = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath: skillRegistryPath,
  })
  await skillLibrary.initialize()
  const projectInstructions = await loadProjectInstructions({
    cwd,
    enabled: portalConfig.projectInstructions,
  })
  const browserEngine = 'chromium'
  const browserExecutablePath = path.resolve(
    options.browserExecutablePath ?? portalConfig.browser.executablePath
  )
  const browserRemoteDebuggingPort = 0
  const browserProfileDir = path.resolve(portalConfig.browser.profilePath)
  const threadStore = await createThreadStore(
    path.join(dataDirectory, 'threads.db')
  )
  const threadManager = new ThreadManager()
  const threadOperations = new ThreadOperationCoordinator()
  const mcpMessageOperations = new McpMessageOperationStore()
  const mcpForegroundOperations = new Set<McpForegroundOperation>()
  const runCommandJobs = new RunCommandJobManager()
  const commandRegistry = new CommandRegistry(DEFAULT_COMMANDS)
  const ui = dependencies.terminalController ?? new TerminalController()
  ui.bindThreadManager(threadManager)
  const keybindingCatalog = new KeybindingCatalog(
    configPath,
    portalConfig.keybindings,
    (level, message) => {
      if (level === 'warning') {
        ui.renderWarning('/keybinding', message)
      } else {
        ui.renderError('/keybinding', message)
      }
    }
  )
  keybindingCatalog.start()
  let currentOperation: {
    controller: AbortController
    stopTarget: StopTarget | null
    done: Promise<unknown>
  } | null = null
  let browserLaunch: Awaited<ReturnType<typeof launchBrowser>> | null = null
  let browserStartupController: AbortController | null = null
  let browserStartupPromise: ReturnType<typeof launchBrowser> | null = null
  let mcpServer: PortalMcpServer | null = null
  let unsubscribeThreadPageClose: (() => void) | null = null
  let lifecycleForShutdown: ThreadLifecycleService | null = null
  let threadLifecycle!: ThreadLifecycleService
  let exitRequested = false
  const shutdown = createIdempotentAsyncTask(async () => {
    unsubscribeThreadPageClose?.()
    unsubscribeThreadPageClose = null
    keybindingCatalog.stop()
    browserStartupController?.abort()
    await browserStartupPromise?.catch(() => {})
    runCommandJobs.beginShutdown()
    const hasMcpForegroundOperation = mcpForegroundOperations.size > 0
    const mcpStop = mcpServer?.stop().catch(() => {})
    const foregroundOperation = currentOperation
    if (foregroundOperation !== null && !hasMcpForegroundOperation) {
      foregroundOperation.controller.abort()
      await closeWithTimeout(async () => {
        const stopGeneration = Promise.resolve().then(
          async () => await foregroundOperation.stopTarget?.stopGeneration()
        )
        await Promise.allSettled([stopGeneration, foregroundOperation.done])
      })
    }
    if (lifecycleForShutdown === null) {
      await threadOperations.cancelAll()
    } else {
      await lifecycleForShutdown.cancelAll()
    }
    await mcpStop
    await runCommandJobs.stopAll()

    for (const thread of threadManager.listThreads()) {
      await closeWithTimeout(async () => {
        if (lifecycleForShutdown === null) {
          await threadManager.closeThread(thread.id)
        } else {
          await lifecycleForShutdown.close(thread.id, 'shutdown')
        }
      })
    }

    if (browserLaunch !== null) {
      const activeBrowserLaunch = browserLaunch
      browserLaunch = null
      await closeWithTimeout(async () => await activeBrowserLaunch.close())
    }

    threadStore.close()
  })

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

  ui.renderWelcome({
    browserStatus: 'connecting',
    directory: cwd,
    version: PORTAL_VERSION,
  })
  clearTerminalBeforeRender(stdout)

  const transcriptWriter = new TerminalTranscriptWriter(
    renderTimelineEntryToAnsi
  )

  const inkApp = renderTerminal(
    createElement(TerminalScreen, {
      ui,
      commands: commandRegistry.list(),
      providers: PROVIDERS,
      keybindings: keybindingCatalog,
      transcriptWriter,
      onInterrupt: () => {
        const state = ui.getState()
        const mcpForegroundOperation = mcpForegroundOperations
          .values()
          .next().value
        if (mcpForegroundOperation !== undefined) {
          void stopMcpForegroundOperation(mcpForegroundOperation)
          return
        }
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
          void threadLifecycle.cancel(activeThreadId)
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
      incrementalRendering: true,
      exitOnCtrlC: false,
      reserveTrailingLine: false,
      windowsConsoleInput: { mode: 'enabled' },
    }
  )

  ui.setScreenResetter(() => {
    transcriptWriter.reset()
    clearInteractiveTerminal(inkApp, stdout)
  })

  void inkApp.waitUntilExit().then(async () => {
    ui.setScreenResetter(null)
    await requestExit()
  })

  try {
    try {
      const startupController = new AbortController()
      browserStartupController = startupController
      const startupPromise = launchBrowserForRun(
        browserEngine,
        browserExecutablePath,
        browserRemoteDebuggingPort,
        browserProfileDir,
        { signal: startupController.signal }
      )
      browserStartupPromise = startupPromise
      try {
        browserLaunch = await startupPromise
      } finally {
        if (browserStartupController === startupController) {
          browserStartupController = null
          browserStartupPromise = null
        }
      }
      const activeBrowserLaunch = browserLaunch
      void activeBrowserLaunch.disconnected
        .then(async () => {
          if (browserLaunch !== activeBrowserLaunch || exitRequested) {
            return
          }
          try {
            ui.setBrowserConnected(false)
            ui.renderWarning(
              'browser',
              'Browser disconnected. Portal is shutting down.'
            )
          } finally {
            await requestExit()
          }
        })
        .catch((error) => {
          process.exitCode = 1
          try {
            ui.renderError('browser', String(error))
          } catch {
            // The terminal may already be unavailable during shutdown.
          }
        })
    } catch (error) {
      if (exitRequested && isAbortError(error)) {
        return
      }
      ui.setBrowserConnected(false)
      process.exitCode = 1
      const message = String(error)
      try {
        ui.renderError('error', message)
        await inkApp.waitUntilRenderFlush()
      } catch {
        try {
          process.stderr.write(`${message}\n`)
        } catch {
          // The terminal may already be unavailable during shutdown.
        }
      }
      return
    }
    if (exitRequested) {
      const lateBrowserLaunch = browserLaunch
      await closeLateBrowserLaunchAfterShutdown(lateBrowserLaunch, shutdown)
      return
    }
    const context = browserLaunch.context
    const runtimeRegistry = new ThreadRuntimeRegistry<RuntimeCore>()
    const pendingProvision = new Map<
      string,
      ReturnType<typeof showPendingThreadTimeline>
    >()
    const lifecycleObserver = async (event: ThreadLifecycleEvent) => {
      if (event.type !== 'thread.closed' && event.source !== 'tui') {
        return
      }
      if (event.type === 'provision.started') {
        pendingProvision.set(
          event.threadId,
          showPendingThreadTimeline(ui, threadManager, event.threadId)
        )
        ui.setBusy(true)
        return
      }
      if (event.type === 'provision.warning') {
        ui.renderWarning(event.title, [...event.lines])
        return
      }
      if (event.type === 'provision.login_wait') {
        ui.renderWarning('login', `Waiting for ${event.provider} login.`)
        return
      }
      if (event.type === 'thread.ready') {
        pendingProvision.get(event.threadId)?.keep()
        pendingProvision.delete(event.threadId)
        const thread = threadManager.getThread(event.threadId)
        if (
          thread !== null &&
          threadManager.getActiveThread()?.id === thread.id
        ) {
          ui.showThreadTimeline(thread.id)
        }
        ui.renderInfo('thread.create', [
          `Thread ${event.threadId} is ready.`,
          `Conversation URL: ${event.conversationUrl}`,
        ])
        ui.setBusy(false)
        return
      }
      if (event.type === 'thread.history') {
        const thread = threadManager.getThread(event.threadId)
        if (thread !== null) {
          ui.renderConversationHistory(thread, event.history.messages)
          if (event.history.warning !== null) {
            ui.renderWarning('thread.resume', event.history.warning, 'markdown')
          }
        }
        return
      }
      if (event.type === 'provision.finished') {
        pendingProvision.get(event.threadId)?.discard()
        pendingProvision.delete(event.threadId)
        ui.setBusy(false)
        ui.renderWarning('thread.create', event.message)
        return
      }
      if (event.type === 'thread.closed') {
        ui.setThreadBusy(event.threadId, false)
        ui.removeThreadTimeline(event.threadId)
        if (event.reason === 'provider_page_closed') {
          ui.renderWarning(
            'thread',
            `Thread ${event.threadId} was closed because its browser page was closed.`
          )
        }
      }
    }
    threadLifecycle = new ThreadLifecycleService({
      threadManager,
      threadOperations,
      threadStore,
      runtimeRegistry,
      browserProfileDir,
      resolveConversationUrl,
      projectInstructions,
      createAdapter: async ({ provider, conversationUrl, signal }) =>
        await createProviderAdapter(context, provider, conversationUrl, signal),
      createRuntime: async ({
        adapter,
        provider,
        model,
        mode,
        projectInstructions,
        signal,
      }) =>
        await createRuntime(adapter, {
          model,
          setupMode:
            mode === 'resume'
              ? 'skip'
              : runtimeSetupModeForThreadCreation(mode),
          skillLibrary,
          projectInstructions,
          advertiseSpawnTool: settings.spawnDepthLimit > 0,
          workingDirectory: cwd,
          toolServices: createToolServices({
            context,
            provider,
            model,
            skillLibrary,
            projectInstructions,
            runCommandJobs,
            settings,
            currentSpawnDepth: 0,
            workingDirectory: cwd,
          }),
          signal,
        }),
      waitForLogin: async (signal) =>
        await sleepWithAbortAsync(LOGIN_CHECK_INTERVAL_MS, signal),
      observer: { onEvent: lifecycleObserver },
    })
    lifecycleForShutdown = threadLifecycle
    const shouldIgnoreThreadPageClose = () =>
      exitRequested || context.isClosed()
    unsubscribeThreadPageClose = threadManager.onThreadPageClosed(
      (threadId) => {
        void threadLifecycle
          .close(threadId, 'provider_page_closed')
          .catch((error) => {
            if (!shouldIgnoreThreadPageClose()) {
              ui.renderError(
                'thread',
                `Failed to clean up ${threadId} after its browser page closed: ${String(error)}`
              )
            }
          })
      }
    )

    ui.setBrowserConnected(true)

    const submitThreadInput = createTuiThreadInputHandler({
      threadManager,
      threadLifecycle,
      ui,
      runCommandJobs,
      browserProfileDir,
    })
    const mcpHandlers = createMcpHandlers({
      threadManager,
      threadOperations,
      threadLifecycle,
      ui,
      messageOperations: mcpMessageOperations,
      runCommandJobs,
      foregroundOperations: mcpForegroundOperations,
      isForegroundOperationActive: () => currentOperation !== null,
      withCancellableOperation,
    })

    mcpServer = new PortalMcpServer({
      host: portalConfig.mcp.host,
      port: portalConfig.mcp.port,
      token: resolvePortalMcpToken(),
      handlers: mcpHandlers,
      onStop: async () => {
        const foregroundOperations = [...mcpForegroundOperations]
        await Promise.all(
          foregroundOperations.map(
            async (operation) => await stopMcpForegroundOperation(operation)
          )
        )
        await mcpMessageOperations.stopAll()
      },
    })
    const commandContext: CliCommandContext = {
      threadManager,
      threadStore,
      skillLibrary,
      runCommandJobs,
      keybindingCatalog,
      mcpServer,
      ui,
      browserProfileDir,
      providers: PROVIDERS,
      resolveProvider: normalizeProviderId,
      createThread: async (
        provider: ProviderId,
        model: ResolvedProviderModel | null,
        mode: ThreadCreationMode = 'agent'
      ) =>
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          void setStopTarget
          await threadLifecycle.create(
            { provider, model, mode, source: 'tui', activate: true },
            signal
          )
        }),
      resumeThread: async (conversationUrl: string) =>
        await withCancellableOperation(null, async (signal, setStopTarget) => {
          void setStopTarget
          const result = await threadLifecycle.resume(
            { conversationUrl, source: 'tui', activate: true },
            signal
          )
          if (!result.ok && result.failure.code !== 'cancelled') {
            throw new Error(result.failure.message)
          }
        }),
      reloadThread: async (threadId: string) => {
        const result = startThreadReload(threadId, {
          threadManager,
          threadLifecycle,
          ui,
        })
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
          return (await threadLifecycle.close(threadId, 'user')).closed
        } finally {
          if (threadOperations.get(threadId) === null) {
            ui.setThreadBusy(threadId, false)
          }
          if (threadManager.getThread(threadId) === null) {
            ui.removeThreadTimeline(threadId)
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

    while (!exitRequested) {
      const input = (
        await ui.requestInput(
          ui.promptLabel(threadManager),
          'Type a task or enter a slash command.',
          async (candidate) => {
            const normalizedCandidate = candidate.trim()
            if (normalizedCandidate.startsWith('/')) return
            const activeThread = threadManager.getActiveThread()
            if (activeThread === null) return
            const check =
              await activeThread.runtime.preflightInitialInput(
                normalizedCandidate
              )
            if (check.status === 'over_limit') {
              throw new ComposerLimitExceededError(check, 'user')
            }
          }
        )
      ).trim()
      if (exitRequested) {
        await shutdown()
        return
      }
      if (!input) {
        ui.renderWarning(
          'portal',
          'No active thread. Use /thread agent to create one, or /help to see commands.'
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
