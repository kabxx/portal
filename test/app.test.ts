import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GROK_PROVIDER_PROMPT,
  canRunCommandWhileThreadBusy,
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  closeLateBrowserLaunchAfterShutdown,
  closeWithTimeout,
  createIdempotentAsyncTask,
  createPortalRuntimeSettings,
  showPendingThreadTimeline,
  shouldRenderFallbackThreadError,
  stopMcpForegroundOperation,
  transitionLoginWaitWarning,
} from '../src/app.ts'
import { createDefaultAdvancedConfig } from '../src/config/portal-config.ts'
import { TerminalController } from '../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../src/threads/thread-manager.ts'
import { createFakeRuntime } from './helpers/fakes.ts'

test('transitionLoginWaitWarning renders only when entering login wait', () => {
  assert.deepEqual(transitionLoginWaitWarning(false, true), {
    waitingForLogin: true,
    shouldRender: true,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, true), {
    waitingForLogin: true,
    shouldRender: false,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, false), {
    waitingForLogin: false,
    shouldRender: true,
  })
})

test('closeWithTimeout returns when a close operation hangs', async () => {
  await closeWithTimeout(async () => {
    await new Promise(() => {})
  }, 10)
})

test('createIdempotentAsyncTask runs concurrent and later calls once', async () => {
  let calls = 0
  const task = createIdempotentAsyncTask(async () => {
    calls += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  await Promise.all([task(), task(), task()])
  await task()

  assert.equal(calls, 1)
})

test('late browser launch closes after an earlier shutdown', async () => {
  const events: string[] = []
  const shutdown = createIdempotentAsyncTask(async () => {
    events.push('shutdown')
  })
  await shutdown()

  await closeLateBrowserLaunchAfterShutdown(
    {
      close: async () => {
        events.push('browser close')
      },
    },
    shutdown,
    10
  )

  assert.deepEqual(events, ['shutdown', 'browser close'])
})

test('MCP foreground cancellation aborts and calls its stop target once', async () => {
  const controller = new AbortController()
  let stopCalls = 0
  const operation = {
    controller,
    stopTarget: {
      stopGeneration: async () => {
        stopCalls += 1
      },
    },
    done: Promise.resolve(),
    cancellation: null,
  }

  await Promise.all([
    stopMcpForegroundOperation(operation, 100),
    stopMcpForegroundOperation(operation, 100),
  ])

  assert.equal(controller.signal.aborted, true)
  assert.equal(stopCalls, 1)
})

test('createPortalRuntimeSettings converts every advanced section to runtime units', () => {
  const advanced = createDefaultAdvancedConfig()
  advanced.browser = { startupTimeoutSeconds: 11, closeTimeoutSeconds: 12 }
  advanced.provider = {
    requestStartWarningAfterSeconds: 13,
    blockedWarningEverySeconds: 14,
    responseStartTimeoutSeconds: 15,
    responseStallTimeoutSeconds: 16,
    restoreTimeoutSeconds: 17,
    historyLoadTimeoutSeconds: 18,
    historyPageTimeoutSeconds: 19,
  }
  advanced.runtime = {
    initializationAttemptLimit: 19,
    requestAttemptLimit: 20,
    cancelWaitTimeoutSeconds: 21,
    shutdownCloseTimeoutSeconds: 22,
    childRuntimeCloseTimeoutSeconds: 23,
  }
  advanced.command = {
    resultOutputLimitMB: 24,
    stopGraceSeconds: 0.25,
    stopTimeoutSeconds: 26,
  }
  advanced.skillInstall = {
    downloadTimeoutSeconds: 27,
    downloadLimitMB: 28,
    extractedSizeLimitMB: 29,
    fileCountLimit: 30,
    resourceFileCountLimit: 31,
    manifestSizeLimitKB: 32,
    redirectLimit: 33,
  }
  advanced.api = {
    requestBodyLimitKB: 34,
    requestTimeoutSeconds: 35,
    sseHeartbeatSeconds: 36,
  }
  advanced.instructions = {
    codexSizeLimitKB: 37,
    claudeSizeLimitKB: 38,
    fileCountLimit: 39,
    importDepthLimit: 40,
  }
  advanced.hooks = { commandOutputLimitMB: 41 }

  assert.deepEqual(createPortalRuntimeSettings(advanced), {
    browserLaunch: { startupTimeoutMs: 11_000, closeTimeoutMs: 12_000 },
    providerTimings: {
      requestStartWarningAfterMs: 13_000,
      blockedWarningIntervalMs: 14_000,
      responseStartTimeoutMs: 15_000,
      responseStallTimeoutMs: 16_000,
      restoreTimeoutMs: 17_000,
      historyLoadTimeoutMs: 18_000,
      historyPageTimeoutMs: 19_000,
    },
    initializationAttemptLimit: 19,
    requestAttemptLimit: 20,
    cancelWaitTimeoutMs: 21_000,
    shutdownCloseTimeoutMs: 22_000,
    childRuntimeCloseTimeoutMs: 23_000,
    runCommand: {
      maxOutputBufferBytes: 24 * 1024 * 1024,
      terminationGraceMs: 250,
      terminationSettleTimeoutMs: 26_000,
    },
    skillPolicy: {
      downloadTimeoutMs: 27_000,
      maxDownloadBytes: 28 * 1024 * 1024,
      maxExtractedBytes: 29 * 1024 * 1024,
      maxFiles: 30,
      maxResourceFiles: 31,
      maxManifestBytes: 32 * 1024,
      maxRedirects: 33,
    },
    api: {
      bodyLimitBytes: 34 * 1024,
      requestTimeoutMs: 35_000,
      sseHeartbeatMs: 36_000,
    },
    instructionLimits: {
      codexMaxBytes: 37 * 1024,
      claudeMaxBytes: 38 * 1024,
      maxFiles: 39,
      maxImportDepth: 40,
    },
    hookCommandOutputLimitBytes: 41 * 1024 * 1024,
  })
})

test('clearInteractiveTerminal clears only interactive output in order', () => {
  const events: string[] = []
  const inkApp = {
    clear: () => events.push('ink-clear'),
  }
  const output = {
    isTTY: true,
    write: (data: string) => {
      events.push(data)
    },
  }

  clearInteractiveTerminal(inkApp, output)

  assert.deepEqual(events, ['ink-clear', '\u001B[2J\u001B[3J\u001B[H'])

  events.length = 0
  clearInteractiveTerminal(inkApp, { ...output, isTTY: false })
  assert.deepEqual(events, [])
})

test('clearTerminalBeforeRender writes only to an interactive terminal', () => {
  const events: string[] = []
  const output = {
    isTTY: true,
    write: (data: string) => {
      events.push(data)
    },
  }

  clearTerminalBeforeRender(output)
  clearTerminalBeforeRender({ ...output, isTTY: false })

  assert.deepEqual(events, ['\u001B[2J\u001B[3J\u001B[H'])
})

test('Grok provider prompt defines a strict Tool boundary', () => {
  assert.match(GROK_PROVIDER_PROMPT, /^# Grok Tool Boundary/)
  assert.match(GROK_PROVIDER_PROMPT, /The "Tools" section/)
  assert.match(GROK_PROVIDER_PROMPT, /exactly one raw valid <tool>/)
})

test('busy threads allow navigation and queries but reject runtime mutations', () => {
  for (const input of [
    '/help',
    '/thread switch t-2',
    '/thread close t-1',
    '/thread open gemini',
    '/thread status',
    '/mcp list',
    '/mcp resource list',
    '/mcp-server start',
    '/mcp-server status',
    '/mcp-server stop',
    '/skill list',
    '/job',
    '/job stop j-1',
    '/exit',
  ]) {
    assert.equal(canRunCommandWhileThreadBusy(input), true, input)
  }

  for (const input of [
    '/thread capability thinking on',
    '/mcp resource attach server uri',
    '/mcp prompt attach server prompt',
    '/skill add ./skill',
    '/unknown',
    '/thread reload',
  ]) {
    assert.equal(canRunCommandWhileThreadBusy(input), false, input)
  }
})

test('shouldRenderFallbackThreadError avoids duplicate turn errors', () => {
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: false,
      canRetry: false,
    }),
    true
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: true,
      canRetry: false,
    }),
    false
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: false,
      canRetry: true,
    }),
    false
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: true,
      canRetry: true,
    }),
    false
  )
})

test('pending thread initialization uses its own timeline and restores the previous thread on failure', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)
  ui.showThreadTimeline(first.id)
  ui.renderInfo('thread', 'existing a output')

  const pending = showPendingThreadTimeline(ui, manager, 't-pending')
  ui.renderWarning('login wait', 'pending thread warning')
  assert.equal(ui.getState().timeline.at(-1)?.body, 'pending thread warning')

  pending.discard()
  assert.equal(manager.getActiveThread()?.id, first.id)
  assert.equal(ui.getState().timeline.at(-1)?.body, 'existing a output')
  assert.equal(
    ui
      .getState()
      .timeline.some(({ body }) => body === 'pending thread warning'),
    false
  )
})

test('successful pending thread initialization keeps its isolated timeline', () => {
  const manager = new ThreadManager()
  manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)

  const pending = showPendingThreadTimeline(ui, manager, 't-b')
  ui.renderWarning('MCP', 'warning for b')
  const second = manager.addThread({
    id: 't-b',
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  pending.keep()
  ui.showThreadTimeline(second.id)

  assert.equal(ui.getState().timeline.at(-1)?.body, 'warning for b')
})
