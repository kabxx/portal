import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BrowserContext } from 'playwright'
import { isValidElement } from 'react'

import { run, type PortalRunDependencies } from '../../src/app.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from '../../src/config/portal-config.ts'
import { createDeferred } from '../../src/providers/adapters/adapter-base.ts'
import {
  PortalMcpServer,
  type PortalMcpServerOptions,
} from '../../src/mcp-server/mcp-server.ts'
import type {
  RunCommandInput,
  RunCommandJobHandle,
  RunCommandJobService,
} from '../../src/processes/run-command-job-manager.ts'
import { getAbortError } from '../../src/runtime/runtime-cancellation.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'

test(
  'run composes local resources and closes them after browser disconnect',
  { timeout: 20_000 },
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-app-run-'))
    const dataDirectory = path.join(cwd, 'portal-state')
    const configPath = path.join(dataDirectory, 'config.yaml')
    const portalConfig = createDefaultPortalConfig(dataDirectory)
    await ensurePortalConfig(configPath, portalConfig)

    const ui = new TerminalController()
    const browserDisconnected = createDeferred<void>()
    const operationStarted = createDeferred<void>()
    const adapter = createProviderAdapterStub()
    const readyPath = path.join(cwd, 'job-ready.txt')
    const observed: {
      runCommandJobs?: RunCommandJobService
      job?: RunCommandJobHandle
    } = {}
    let adapterCloseCount = 0
    let browserCloseCount = 0
    let runtimeCloseCount = 0
    let terminalUnmountCount = 0

    // The launcher boundary is replaced, while the app still composes its real
    // config, stores, thread lifecycle, job manager, and shutdown.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const browserContext = {
      isClosed: () => false,
    } as unknown as BrowserContext
    const inkApp = {
      rerender: () => {},
      unmount: () => {
        terminalUnmountCount += 1
      },
      waitUntilExit: async () => await new Promise<never>(() => {}),
      waitUntilRenderFlush: async () => {},
      cleanup: () => {},
      clear: () => {},
    }

    const dependencies: PortalRunDependencies = {
      cwd,
      terminalController: ui,
      renderTerminal: () => inkApp,
      launchBrowser: async (engine, _executablePath, port, profilePath) => {
        assert.equal(engine, 'chromium')
        assert.equal(port, 0)
        assert.equal(
          profilePath,
          path.join(dataDirectory, 'profiles', 'chromium')
        )
        return {
          context: browserContext,
          disconnected: browserDisconnected.promise,
          close: async () => {
            browserCloseCount += 1
          },
        }
      },
      createProviderAdapter: async () => adapter,
      createRuntime: async (runtimeAdapter, options) => {
        assert.equal(runtimeAdapter, adapter)
        assert.ok(options !== undefined)
        const runCommandJobs = options.toolServices?.runCommandJobs
        assert.ok(runCommandJobs !== undefined)
        observed.runCommandJobs = runCommandJobs
        return createFakeRuntime({
          adapter,
          close: async () => {
            runtimeCloseCount += 1
            await adapter.close()
            adapterCloseCount += 1
          },
          submitUserInput: async (_input, handlers) => {
            assert.ok(handlers !== undefined)
            const startedJob = runCommandJobs.start(
              longRunningCommand(readyPath, cwd)
            )
            observed.job = startedJob
            await waitForJobReady(startedJob, readyPath)
            operationStarted.resolve()
            return await waitForAbort(handlers.signal)
          },
        })
      },
    }

    const runPromise = run(
      [process.execPath, 'portal', '--data-dir', dataDirectory],
      dependencies
    )
    void runPromise.catch(() => {})
    try {
      await waitFor(() => ui.getState().prompt.active, 'thread command prompt')
      assert.equal(ui.submitInput('/thread agent chatgpt'), true)
      await waitFor(
        () => ui.getThreadManager()?.getActiveThread() !== null,
        'thread to become active'
      )

      await waitFor(() => ui.getState().prompt.active, 'thread input prompt')
      assert.equal(ui.submitInput('keep running until shutdown'), true)
      await withTimeout(operationStarted.promise, 'active thread operation')
      const runCommandJobs = observed.runCommandJobs
      assert.ok(runCommandJobs !== undefined)
      assert.equal(runCommandJobs.list().length, 1)

      browserDisconnected.resolve()
      await withTimeout(runPromise, 'Portal shutdown')

      const completedJob = observed.job
      assert.ok(completedJob !== undefined)
      assert.equal((await completedJob.wait()).terminationReason, 'shutdown')
      assert.equal(runCommandJobs.list().length, 0)
      assert.deepEqual(ui.getThreadManager()?.listThreads(), [])
      assert.equal(adapterCloseCount, 1)
      assert.equal(runtimeCloseCount, 1)
      assert.equal(browserCloseCount, 1)
      assert.equal(terminalUnmountCount, 1)
      assert.equal(existsSync(path.join(dataDirectory, 'threads.db')), true)
      assert.equal(existsSync(path.join(cwd, 'data')), false)
    } finally {
      browserDisconnected.resolve()
      if (observed.job !== undefined && observed.runCommandJobs !== undefined) {
        await observed.runCommandJobs.stop(observed.job.id).catch(() => {})
      }
      await withTimeout(runPromise, 'Portal test cleanup').catch(() => {})
      rmSync(cwd, { recursive: true, force: true })
    }

    assert.equal(existsSync(cwd), false)
  }
)

test('run rolls back the prepared host when the TUI surface fails', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-app-surface-fail-'))
  const dataDirectory = path.join(cwd, 'portal-state')
  let browserLaunchCount = 0
  try {
    await assert.rejects(
      run([process.execPath, 'portal', '--data-dir', dataDirectory], {
        cwd,
        terminalController: new TerminalController(),
        renderTerminal: () => {
          throw new Error('render failed')
        },
        launchBrowser: async () => {
          browserLaunchCount += 1
          throw new Error('browser should not launch')
        },
      }),
      /render failed/
    )
    assert.equal(browserLaunchCount, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('run stops an active MCP surface before exiting through /exit', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-app-mcp-exit-'))
  const dataDirectory = path.join(cwd, 'portal-state')
  const ui = new TerminalController()
  let mcpStartCount = 0
  let mcpStopCount = 0
  let browserCloseCount = 0
  let terminalUnmountCount = 0
  class TestPortalMcpServer extends PortalMcpServer {
    public constructor(private readonly testOptions: PortalMcpServerOptions) {
      super(testOptions)
    }

    public override async start(): Promise<void> {
      mcpStartCount += 1
    }

    public override async stop(): Promise<void> {
      mcpStopCount += 1
      await this.testOptions.onStop?.()
    }

    public override status() {
      return {
        running: mcpStartCount > mcpStopCount,
        address: null,
        auth: false,
      }
    }
  }
  const inkApp = {
    rerender: () => {},
    unmount: () => {
      terminalUnmountCount += 1
    },
    waitUntilExit: async () => await new Promise<never>(() => {}),
    waitUntilRenderFlush: async () => {},
    cleanup: () => {},
    clear: () => {},
  }
  try {
    const runPromise = run(
      [process.execPath, 'portal', '--data-dir', dataDirectory],
      {
        cwd,
        terminalController: ui,
        renderTerminal: () => inkApp,
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {
            browserCloseCount += 1
          },
        }),
        createMcpServer: (options: PortalMcpServerOptions) =>
          new TestPortalMcpServer(options),
      }
    )

    await waitFor(() => ui.getState().prompt.active, 'MCP command prompt')
    assert.equal(ui.submitInput('/mcp start'), true)
    await waitFor(
      () => mcpStartCount === 1 && ui.getState().prompt.active,
      'MCP server startup'
    )
    assert.equal(ui.submitInput('/exit'), true)
    await withTimeout(runPromise, 'MCP exit shutdown')

    assert.equal(mcpStopCount, 1)
    assert.equal(browserCloseCount, 1)
    assert.equal(terminalUnmountCount, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a foreground Command owns busy state and Ctrl+C cancellation', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-app-command-cancel-'))
  const dataDirectory = path.join(cwd, 'portal-state')
  const ui = new TerminalController()
  const commandStarted = createDeferred<void>()
  const releaseStart = createDeferred<void>()
  const terminal = { onInterrupt: null as (() => void) | null }
  let runPromise: Promise<void> | null = null
  class PendingPortalMcpServer extends PortalMcpServer {
    public override async start(): Promise<void> {
      commandStarted.resolve()
      await releaseStart.promise
    }

    public override async stop(): Promise<void> {
      releaseStart.resolve()
    }
  }
  const inkApp = {
    rerender: () => {},
    unmount: () => {},
    waitUntilExit: async () => await new Promise<never>(() => {}),
    waitUntilRenderFlush: async () => {},
    cleanup: () => {},
    clear: () => {},
  }
  try {
    runPromise = run(
      [process.execPath, 'portal', '--data-dir', dataDirectory],
      {
        cwd,
        terminalController: ui,
        renderTerminal: (node) => {
          assert.equal(isValidElement(node), true)
          if (isValidElement<{ onInterrupt?: () => void }>(node)) {
            assert.equal(typeof node.props.onInterrupt, 'function')
            if (typeof node.props.onInterrupt === 'function') {
              terminal.onInterrupt = node.props.onInterrupt
            }
          }
          return inkApp
        },
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {},
        }),
        createMcpServer: (options) => new PendingPortalMcpServer(options),
      }
    )

    await waitFor(() => ui.getState().prompt.active, 'Command prompt')
    assert.equal(ui.submitInput('/mcp start'), true)
    await withTimeout(commandStarted.promise, 'MCP Command start')
    await waitFor(() => ui.getState().busy, 'Command foreground busy state')
    const onInterrupt = terminal.onInterrupt
    assert.ok(onInterrupt !== null)
    onInterrupt()
    await waitFor(
      () => !ui.getState().busy && ui.getState().prompt.active,
      'cancelled Command prompt'
    )
    assert.equal(
      ui
        .getState()
        .timeline.some(
          (entry) =>
            entry.welcome === undefined &&
            entry.tone === 'error' &&
            entry.body.includes('abort')
        ),
      false
    )

    assert.equal(ui.submitInput('/exit'), true)
    await withTimeout(runPromise, 'Command cancellation shutdown')
  } finally {
    releaseStart.resolve()
    terminal.onInterrupt?.()
    await new Promise((resolve) => setImmediate(resolve))
    terminal.onInterrupt?.()
    if (runPromise !== null) {
      await withTimeout(runPromise, 'Command test cleanup', 3000).catch(
        () => undefined
      )
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

function longRunningCommand(ready: string, cwd: string): RunCommandInput {
  const fixture = path.resolve('test/fixtures/run-command-ready.mjs')
  const invocation = [process.execPath, fixture, ready]
    .map(quoteShellArg)
    .join(' ')
  return {
    command: os.platform() === 'win32' ? `& ${invocation}` : invocation,
    cwd,
    shell: os.platform() === 'win32' ? 'powershell' : 'sh',
    timeoutMs: 30_000,
  }
}

async function waitForAbort(signal?: AbortSignal): Promise<never> {
  assert.ok(signal !== undefined)
  if (signal.aborted) {
    throw getAbortError(signal)
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(getAbortError(signal)), {
      once: true,
    })
  })
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForJobReady(
  job: RunCommandJobHandle,
  ready: string
): Promise<void> {
  const completion = job.wait()
  const deadline = Date.now() + 10_000
  while (!existsSync(ready)) {
    const settled = await Promise.race([
      completion.then((result) => result),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ])
    if (settled !== null) {
      throw new Error(
        `Job exited before readiness (exit ${String(settled.exitCode)}, stderr bytes ${String(Buffer.byteLength(settled.stderr))}).`
      )
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for job to start.')
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 10_000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
