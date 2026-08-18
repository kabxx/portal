import { createElement } from 'react'
import { render } from '../vendor/ink.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import {
  renderTimelineEntryToAnsi,
  TerminalScreen,
} from '../terminal-ui/terminal-screen.tsx'
import { TerminalTranscriptWriter } from '../terminal-ui/terminal-transcript-writer.ts'
import { KeybindingCatalog } from '../keybindings/keybinding-catalog.ts'
import { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  PortalExitError,
  closeWithTimeout,
  createIdempotentAsyncTask,
  type StopTarget,
} from './app-lifecycle.ts'
import {
  createTuiThreadInputHandler,
  noActiveThreadMessage,
} from './app-tui-thread-input-handler.ts'
import {
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  showPendingThreadTimeline,
} from './app-terminal-lifecycle.ts'
import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import {
  surfaceActivationBindings,
  surfaceContributions,
  type SurfaceActivationContext,
  type SurfaceHostEvent,
  type SurfaceInstance,
  type SurfaceThreadLifecycleEvent,
} from '../surfaces/surface-extension.ts'
import type {
  CommandKeybindingService,
  CommandMcpService,
  CommandOutputMessage,
  CommandOutputService,
} from '../cli-commands/core/command-services.ts'
import type { SurfacePortActions } from '../surfaces/surface-port.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from '../config/portal-config.ts'
import { isMcpSurfaceApi } from '../mcp-server/mcp-surface-plugin.ts'

export const TUI_SURFACE_PACKAGE_ID = 'portal.surface.tui'
export const TUI_SURFACE_ID = 'portal.tui'
const TUI_ACTIVATOR_ID = `${TUI_SURFACE_ID}.activator`

interface TuiSurfaceActivationOptions {
  readonly version: string
  readonly mcp?: CommandMcpService
  readonly input: typeof import('node:process').stdin
  readonly output: typeof import('node:process').stdout
  readonly renderTerminal?: typeof render
  readonly terminalController?: TerminalController
}

export function createTuiSurfaceRegistration(): PortalExtensionRegistration {
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: TUI_SURFACE_PACKAGE_ID,
    version: '1.0.0',
    dependencies: Object.freeze([]),
    capabilities: Object.freeze([]),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.contribute(surfaceContributions, {
        id: TUI_SURFACE_ID,
        value: Object.freeze({
          id: TUI_SURFACE_ID,
          label: 'Portal TUI',
          kind: 'interactive',
          sessionIntent: 'interactive',
          activationBindingId: TUI_ACTIVATOR_ID,
        }),
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceActivationBindings, {
        id: TUI_ACTIVATOR_ID,
        targetId: TUI_SURFACE_ID,
        binding: activateTuiSurface,
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

async function activateTuiSurface(
  input: unknown,
  context: SurfaceActivationContext
): Promise<SurfaceInstance> {
  const options = assertTuiOptions(input)
  const config = await ensurePortalConfig(
    context.host.configPath,
    createDefaultPortalConfig(context.host.dataDirectory)
  )
  const ui = options.terminalController ?? new TerminalController()
  const surface = context.port
  ui.bindSurfacePort(surface)
  const keybindings = new KeybindingCatalog(
    context.host.configPath,
    config.keybindings,
    (level, message) => {
      if (level === 'warning') ui.renderWarning('/keybinding', message)
      else ui.renderError('/keybinding', message)
    }
  )
  keybindings.start()
  const commandSession = context.commands.openSession(TUI_SURFACE_ID)
  const commandCompletionSnapshot = context.commands.completionSnapshot()
  context.commands.bindPresentation({
    output: createTuiCommandOutput(ui, surface),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    keybindings: createTuiKeybindingService(keybindings),
    setThreadBusy: (threadId, busy) => ui.setThreadBusy(threadId, busy),
  })

  let currentOperation: {
    controller: AbortController
    stopTarget: StopTarget | null
    done: Promise<unknown>
  } | null = null
  let exitRequested = false
  let inkApp: ReturnType<typeof render> | null = null
  let unsubscribe = () => {}

  const requestExit = () => {
    if (exitRequested) return
    exitRequested = true
    ui.cancelPendingInput(new PortalExitError())
  }
  const stopOperations = async () => {
    const operation = currentOperation
    if (operation === null) return
    operation.controller.abort()
    await closeWithTimeout(async () => {
      const stopGeneration = Promise.resolve().then(
        async () => await operation.stopTarget?.stopGeneration()
      )
      await Promise.all([stopGeneration, operation.done])
    })
  }
  const close = createIdempotentAsyncTask(async () => {
    requestExit()
    const errors: unknown[] = []
    for (const cleanup of [
      stopOperations,
      async () => await commandSession.close(),
      async () => keybindings.stop(),
      async () => {
        unsubscribe()
        unsubscribe = () => {}
      },
      async () => {
        ui.setScreenResetter(null)
        inkApp?.unmount()
        inkApp = null
      },
    ]) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Portal TUI failed to close cleanly.')
    }
  })
  context.scope.defer('TUI instance', close)

  const pendingProvision = new Map<
    string,
    ReturnType<typeof showPendingThreadTimeline>
  >()
  unsubscribe = context.events.subscribe((event) => {
    handleTuiHostEvent(event, {
      ui,
      surface,
      pendingProvision,
      requestExit,
    })
  })
  const stopOnAbort = () => requestExit()
  if (context.signal.aborted) stopOnAbort()
  else context.signal.addEventListener('abort', stopOnAbort, { once: true })

  ui.renderWelcome({
    browserStatus: 'connected',
    directory: context.host.cwd,
    version: options.version,
  })
  clearTerminalBeforeRender(options.output)
  const transcriptWriter = new TerminalTranscriptWriter(
    renderTimelineEntryToAnsi
  )
  const renderTerminal = options.renderTerminal ?? render
  inkApp = renderTerminal(
    createElement(TerminalScreen, {
      ui,
      commandSession,
      commandCompletionSnapshot,
      keybindings,
      transcriptWriter,
      onInterrupt: () => {
        const operation = currentOperation
        if (operation !== null && !operation.controller.signal.aborted) {
          operation.controller.abort()
          void Promise.resolve()
            .then(async () => await operation.stopTarget?.stopGeneration())
            .catch(() => undefined)
          return
        }
        const activeThreadId = surface.getActiveThread()?.id ?? null
        if (
          activeThreadId !== null &&
          surface.operation(activeThreadId) !== null
        ) {
          void surface.cancelThread(activeThreadId)
          return
        }
        if (!ui.getState().busy) requestExit()
      },
    }),
    {
      stdin: options.input,
      stdout: options.output,
      // Keep Ink's rendering mode aligned with the transcript ownership rule
      // in TerminalScreen. Auto-detection also considers CI and can otherwise
      // make Ink non-interactive while the screen has already disabled replay
      // because stdout is a TTY.
      interactive: options.output.isTTY === true,
      incrementalRendering: true,
      exitOnCtrlC: false,
      reserveTrailingLine: false,
      windowsConsoleInput: { mode: 'enabled' },
    }
  )
  ui.setScreenResetter(() => {
    transcriptWriter.reset()
    if (inkApp !== null) clearInteractiveTerminal(inkApp, options.output)
  })
  void inkApp
    .waitUntilExit()
    .then(() => requestExit())
    .catch((error) => {
      ui.renderError('terminal', String(error))
      requestExit()
    })

  const withCancellableOperation = async <T>(
    stopTarget: StopTarget | null,
    runOperation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const previous = currentOperation
    const controller = new AbortController()
    const operation = {
      controller,
      stopTarget,
      done: Promise.resolve() as Promise<unknown>,
    }
    currentOperation = operation
    try {
      const done = Promise.resolve().then(
        async () => await runOperation(controller.signal)
      )
      operation.done = done
      return await done
    } finally {
      if (currentOperation === operation) currentOperation = previous
    }
  }
  const submitThreadInput = createTuiThreadInputHandler({ surface, ui })
  const done = (async () => {
    try {
      while (!exitRequested) {
        const value = (
          await ui.requestInput(
            ui.promptLabel(surface),
            'Type a task or enter a slash command.',
            async (candidate) => {
              const normalized = candidate.trim()
              if (normalized.startsWith('/')) return
              const thread = surface.getActiveThread()
              if (thread !== null)
                await surface.preflightMessage(thread.id, normalized)
            }
          )
        ).trim()
        if (exitRequested) return
        if (value === '') {
          ui.renderWarning('portal', noActiveThreadMessage(surface))
          continue
        }
        try {
          if (!value.startsWith('/')) {
            await submitThreadInput(value)
            continue
          }
          const analysis = commandSession.prepare(value)
          if (analysis.kind !== 'ready') {
            if (analysis.kind === 'unknown' || analysis.kind === 'invalid')
              ui.renderWarning('portal', analysis.diagnostic.message)
            continue
          }
          const activeThread = surface.getActiveThread()
          if (
            activeThread !== null &&
            surface.operation(activeThread.id) !== null &&
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
          const result = await withCancellableOperation(
            null,
            async (signal) =>
              await commandSession.execute(analysis.invocation, {
                signal,
                deadline: Number.POSITIVE_INFINITY,
              })
          )
          ui.setBusy(false)
          if (result.disposition === 'request-stop') return
        } catch (error) {
          ui.setBusy(false)
          if (!isAbortError(error)) ui.renderError('runtime', String(error))
        }
      }
    } catch (error) {
      if (!(error instanceof PortalExitError)) throw error
    } finally {
      context.signal.removeEventListener('abort', stopOnAbort)
    }
  })()
  void done.catch(() => undefined)
  return Object.freeze({ done, close })
}

function handleTuiHostEvent(
  event: SurfaceHostEvent,
  state: {
    readonly ui: TerminalController
    readonly surface: SurfacePortActions
    readonly pendingProvision: Map<
      string,
      ReturnType<typeof showPendingThreadTimeline>
    >
    readonly requestExit: () => void
  }
): void {
  if (event.type === 'runtime.disconnected') {
    state.ui.setBrowserConnected(false)
    state.ui.renderWarning(
      'browser',
      'Browser disconnected. Portal is shutting down.'
    )
    state.requestExit()
    return
  }
  if (event.type === 'thread.cleanup_failed') {
    state.ui.renderError(
      'thread',
      `Failed to clean up ${event.threadId}: ${event.message}`
    )
    return
  }
  if (event.type !== 'thread.lifecycle') return
  handleTuiThreadEvent(event.event, state)
}

function handleTuiThreadEvent(
  event: SurfaceThreadLifecycleEvent,
  state: {
    readonly ui: TerminalController
    readonly surface: SurfacePortActions
    readonly pendingProvision: Map<
      string,
      ReturnType<typeof showPendingThreadTimeline>
    >
  }
): void {
  if (event.type !== 'thread.closed' && event.source !== 'tui') return
  const { ui, surface, pendingProvision } = state
  if (event.type === 'provision.started') {
    pendingProvision.set(
      event.threadId,
      showPendingThreadTimeline(ui, surface, event.threadId)
    )
    ui.setBusy(true)
  } else if (event.type === 'provision.warning') {
    ui.renderWarning(event.title, [...event.lines])
  } else if (event.type === 'provision.login_wait') {
    ui.renderWarning('login', `Waiting for ${event.provider} login.`)
  } else if (event.type === 'thread.ready') {
    pendingProvision.get(event.threadId)?.keep()
    pendingProvision.delete(event.threadId)
    if (surface.getActiveThread()?.id === event.threadId)
      ui.showThreadTimeline(event.threadId)
    ui.renderInfo('thread.create', [
      `Thread ${event.threadId} is ready.`,
      `Conversation URL: ${event.conversationUrl}`,
    ])
    ui.setBusy(false)
  } else if (event.type === 'thread.history') {
    const thread = surface.getThread(event.threadId)
    if (thread !== null) {
      ui.renderConversationHistory(thread, event.history.messages)
      if (event.history.warning !== null)
        ui.renderWarning('thread.resume', event.history.warning, 'markdown')
    }
  } else if (event.type === 'provision.finished') {
    pendingProvision.get(event.threadId)?.discard()
    pendingProvision.delete(event.threadId)
    ui.setBusy(false)
    ui.renderWarning('thread.create', event.message)
  } else {
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

function createTuiCommandOutput(
  ui: TerminalController,
  surface: SurfacePortActions
): CommandOutputService {
  const output: CommandOutputService = {
    write(message: CommandOutputMessage): void {
      const body = message.body
      const format = message.format ?? 'plain'
      const thread =
        message.threadId === undefined
          ? null
          : surface.getThread(message.threadId)
      if (thread !== null) {
        if (message.level === 'warning')
          ui.renderThreadWarning(thread, message.title, body, format)
        else if (message.level === 'error')
          ui.renderThreadError(thread, message.title, body, format)
        else ui.renderThreadInfo(thread, message.title, body, format)
        return
      }
      if (message.level === 'info') ui.renderInfo(message.title, body, format)
      else if (message.level === 'success')
        ui.renderSuccess(message.title, body, format)
      else if (message.level === 'warning')
        ui.renderWarning(message.title, body, format)
      else ui.renderError(message.title, body, format)
    },
    navigate(event): void {
      if (event.kind === 'show-home') ui.showHomeTimeline()
      else if (event.kind === 'show-thread')
        ui.showThreadTimeline(event.threadId)
      else ui.removeThreadTimeline(event.threadId)
    },
  }
  return Object.freeze(output)
}

function createTuiKeybindingService(
  keybindings: KeybindingCatalog
): CommandKeybindingService {
  const service: CommandKeybindingService = {
    reset: async (signal) => {
      throwIfAborted(signal)
      await keybindings.reset()
    },
  }
  return Object.freeze(service)
}

function assertTuiOptions(input: unknown): TuiSurfaceActivationOptions {
  if (
    input === null ||
    typeof input !== 'object' ||
    !('version' in input) ||
    typeof input.version !== 'string' ||
    ('mcp' in input &&
      input.mcp !== undefined &&
      !isMcpSurfaceApi(input.mcp)) ||
    !('input' in input) ||
    !isTerminalInput(input.input) ||
    !('output' in input) ||
    !isTerminalOutput(input.output) ||
    ('renderTerminal' in input &&
      input.renderTerminal !== undefined &&
      !isRenderTerminal(input.renderTerminal)) ||
    ('terminalController' in input &&
      input.terminalController !== undefined &&
      !(input.terminalController instanceof TerminalController))
  ) {
    throw new TypeError('Invalid portal.tui Surface activation options.')
  }
  return {
    version: input.version,
    ...('mcp' in input && isMcpSurfaceApi(input.mcp) ? { mcp: input.mcp } : {}),
    input: input.input,
    output: input.output,
    ...('renderTerminal' in input && isRenderTerminal(input.renderTerminal)
      ? { renderTerminal: input.renderTerminal }
      : {}),
    ...('terminalController' in input &&
    input.terminalController instanceof TerminalController
      ? { terminalController: input.terminalController }
      : {}),
  }
}

function isRenderTerminal(value: unknown): value is typeof render {
  return typeof value === 'function'
}

function isTerminalInput(
  value: unknown
): value is TuiSurfaceActivationOptions['input'] {
  return (
    value !== null &&
    typeof value === 'object' &&
    'on' in value &&
    typeof value.on === 'function'
  )
}

function isTerminalOutput(
  value: unknown
): value is TuiSurfaceActivationOptions['output'] {
  return (
    value !== null &&
    typeof value === 'object' &&
    'write' in value &&
    typeof value.write === 'function'
  )
}
