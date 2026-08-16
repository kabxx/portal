import path from 'path'
import { createRequire } from 'node:module'
import { stdin, stdout } from 'process'
import { Command } from 'commander'
import { render } from './vendor/ink.ts'
import { createElement } from 'react'
import { isAbortError } from './runtime/runtime-cancellation.ts'
import { ResourceScope } from './shared/resource-scope.ts'
import {
  createPortalCommandServices,
  portalCommandCompletionSnapshot,
} from './host/portal-command-services.ts'
import {
  renderTimelineEntryToAnsi,
  TerminalScreen,
} from './terminal-ui/terminal-screen.tsx'
import { TerminalTranscriptWriter } from './terminal-ui/terminal-transcript-writer.ts'
import { KeybindingCatalog } from './keybindings/keybinding-catalog.ts'
import { TerminalController } from './terminal-ui/terminal-controller.ts'
import {
  PortalMcpServer,
  resolvePortalMcpToken,
  type PortalMcpServerOptions,
} from './mcp-server/mcp-server.ts'
import { McpMessageOperationStore } from './mcp-server/mcp-message-operations.ts'
import {
  ThreadLifecycleService,
  type ThreadLifecycleEvent,
} from './threads/thread-lifecycle-service.ts'
import { PortalHost, type PortalHostDependencies } from './host/portal-host.ts'
import {
  PortalExitError,
  closeWithTimeout,
  createIdempotentAsyncTask,
  stopMcpForegroundOperation,
  type McpForegroundOperation,
  type StopTarget,
} from './app/app-lifecycle.ts'
import { createMcpHandlers } from './app/app-mcp-handlers.ts'
import { createTuiThreadInputHandler } from './app/app-tui-thread-input-handler.ts'
import { PortalSurfacePort } from './host/portal-surface-port.ts'
import {
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
export { PROVIDERS } from './providers/provider-catalog.ts'
export {
  createPortalRuntimeSettings,
  runtimeSetupModeForThreadCreation,
} from './runtime/runtime-settings.ts'
export { inheritSpawnModelSelection } from './tools/spawn-tool-services.ts'
export {
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  shouldRenderFallbackThreadError,
  showPendingThreadTimeline,
} from './app/app-terminal-lifecycle.ts'

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

export interface PortalRunDependencies extends PortalHostDependencies {
  cwd?: string
  renderTerminal?: typeof render
  terminalController?: TerminalController
  createMcpServer?: (options: PortalMcpServerOptions) => PortalMcpServer
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
  const renderTerminal = dependencies.renderTerminal ?? render
  const host = await PortalHost.prepare(
    {
      profile: 'tui',
      cwd,
      ...(options.dataDir === undefined
        ? {}
        : { dataDirectory: options.dataDir }),
      ...(options.browserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: options.browserExecutablePath }),
    },
    {
      ...(dependencies.launchBrowser === undefined
        ? {}
        : { launchBrowser: dependencies.launchBrowser }),
      ...(dependencies.createProviderAdapter === undefined
        ? {}
        : { createProviderAdapter: dependencies.createProviderAdapter }),
      ...(dependencies.createRuntime === undefined
        ? {}
        : { createRuntime: dependencies.createRuntime }),
    }
  )
  const surfaceScope = new ResourceScope('tui surface', {
    cleanupTimeoutMs: 30_000,
  })
  let keybindingsForCleanup: KeybindingCatalog | null = null
  let inkForCleanup: ReturnType<typeof render> | null = null
  let stopTuiOperationsForCleanup: () => Promise<void> = async () => {}
  surfaceScope.defer('Ink renderer', () => inkForCleanup?.unmount())
  surfaceScope.defer('Portal host', async () => await host.close())
  surfaceScope.defer(
    'TUI operations',
    async () => await stopTuiOperationsForCleanup()
  )
  surfaceScope.defer('keybinding watcher', () => keybindingsForCleanup?.stop())
  try {
    const {
      configPath,
      config: portalConfig,
      threadManager,
      threadOperations,
      runCommandJobs,
    } = host.prepared
    const mcpMessageOperations = new McpMessageOperationStore()
    const mcpForegroundOperations = new Set<McpForegroundOperation>()
    const commandCatalog = host.commandCatalog()
    const ui = dependencies.terminalController ?? new TerminalController()
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
    keybindingsForCleanup = keybindingCatalog
    keybindingCatalog.start()
    const commandSession = host.openCommandSession('tui')
    const commandCompletionSnapshot = portalCommandCompletionSnapshot()
    surfaceScope.defer(
      'Command session',
      async () => await commandSession.close()
    )
    let currentOperation: {
      controller: AbortController
      stopTarget: StopTarget | null
      done: Promise<unknown>
    } | null = null
    let mcpServer: PortalMcpServer | null = null
    let threadLifecycle!: ThreadLifecycleService
    let exitRequested = false
    stopTuiOperationsForCleanup = async () => {
      const hasMcpForegroundOperation = mcpForegroundOperations.size > 0
      const shutdownTasks: Promise<void>[] = []
      if (mcpServer !== null) {
        shutdownTasks.push(mcpServer.stop())
      }
      const foregroundOperation = currentOperation
      if (foregroundOperation !== null && !hasMcpForegroundOperation) {
        foregroundOperation.controller.abort()
        shutdownTasks.push(
          closeWithTimeout(async () => {
            const stopGeneration = Promise.resolve().then(
              async () => await foregroundOperation.stopTarget?.stopGeneration()
            )
            await Promise.allSettled([stopGeneration, foregroundOperation.done])
          })
        )
      }
      const outcomes = await Promise.allSettled(shutdownTasks)
      const errors: unknown[] = []
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          errors.push(outcome.reason)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'Portal TUI operations failed to stop cleanly.'
        )
      }
    }
    const shutdown = createIdempotentAsyncTask(
      async () => await surfaceScope.dispose()
    )

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
        commandSession,
        commandCompletionSnapshot,
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
          const activeThreadId = surfacePort.getActiveThread()?.id ?? null
          if (
            activeThreadId !== null &&
            surfacePort.operation(activeThreadId) !== null
          ) {
            void surfacePort.cancelThread(activeThreadId)
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
    inkForCleanup = inkApp

    ui.setScreenResetter(() => {
      transcriptWriter.reset()
      clearInteractiveTerminal(inkApp, stdout)
    })

    void inkApp
      .waitUntilExit()
      .then(async () => {
        ui.setScreenResetter(null)
        await requestExit()
      })
      .catch(reportPortalShutdownError)

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

    let surfacePort!: PortalSurfacePort
    try {
      await host.start({
        observer: { onEvent: lifecycleObserver },
        onPageCloseCleanupError: (error, threadId) => {
          if (!exitRequested) {
            ui.renderError(
              'thread',
              `Failed to clean up ${threadId} after its browser page closed: ${String(error)}`
            )
          }
        },
      })
      threadLifecycle = host.services.lifecycle
      surfacePort = new PortalSurfacePort({
        threadManager,
        threadLifecycle,
        threadOperations,
        runCommandJobs,
      })
      ui.bindSurfacePort(surfacePort)
      const activeBrowserLaunch = host.services.browser
      void activeBrowserLaunch.disconnected
        .then(async () => {
          if (host.state !== 'ready' || exitRequested) {
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
      await shutdown()
      return
    }
    ui.setBrowserConnected(true)

    const submitThreadInput = createTuiThreadInputHandler({
      surface: surfacePort,
      ui,
    })
    const mcpHandlers = createMcpHandlers({
      surface: surfacePort,
      messageOperations: mcpMessageOperations,
      foregroundOperations: mcpForegroundOperations,
      isForegroundOperationActive: () => currentOperation !== null,
      withCancellableOperation,
    })

    const mcpServerOptions: PortalMcpServerOptions = {
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
    }
    mcpServer =
      dependencies.createMcpServer?.(mcpServerOptions) ??
      new PortalMcpServer(mcpServerOptions)
    host.bindCommandServices(
      createPortalCommandServices(
        {
          started: host.services,
          ui,
          keybindings: keybindingCatalog,
          mcp: mcpServer,
        },
        { list: () => commandCatalog }
      )
    )

    while (!exitRequested) {
      const input = (
        await ui.requestInput(
          ui.promptLabel(surfacePort),
          'Type a task or enter a slash command.',
          async (candidate) => {
            const normalizedCandidate = candidate.trim()
            if (normalizedCandidate.startsWith('/')) return
            const activeThread = surfacePort.getActiveThread()
            if (activeThread === null) return
            await surfacePort.preflightMessage(
              activeThread.id,
              normalizedCandidate
            )
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
          const analysis = commandSession.prepare(input)
          if (analysis.kind !== 'ready') {
            if (analysis.kind === 'unknown' || analysis.kind === 'invalid') {
              ui.renderWarning('portal', analysis.diagnostic.message)
            }
            continue
          }
          const activeThread = surfacePort.getActiveThread()
          if (
            activeThread !== null &&
            surfacePort.operation(activeThread.id) !== null &&
            !commandSession.canExecute(analysis.invocation, {
              threadBusy: true,
            })
          ) {
            ui.renderThreadWarning(
              activeThread,
              'thread',
              `Thread ${activeThread.id} is running; this command cannot run until the current turn finishes.`
            )
            continue
          }
          ui.setBusy(true)
          const commandResult = await (async () => {
            try {
              return await withCancellableOperation(
                null,
                async (signal) =>
                  await commandSession.execute(analysis.invocation, {
                    signal,
                    deadline: Number.POSITIVE_INFINITY,
                  })
              )
            } finally {
              ui.setBusy(false)
            }
          })()
          if (commandResult.disposition === 'request-stop') {
            break
          }
          continue
        }

        await submitThreadInput(input)
      } catch (error) {
        if (!isAbortError(error)) {
          ui.renderError('runtime', String(error))
        }
      }
    }
  } catch (error) {
    if (!(error instanceof PortalExitError)) {
      throw error
    }
  } finally {
    await surfaceScope.dispose().catch(reportPortalShutdownError)
  }
}

function reportPortalShutdownError(error: unknown): void {
  process.exitCode = 1
  try {
    process.stderr.write(`Portal shutdown failed: ${String(error)}\n`)
  } catch {
    // The terminal may already be unavailable during shutdown.
  }
}
