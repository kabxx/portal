import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BrowserContext } from 'playwright'

import { run, type PortalRunDependencies } from '../../src/app.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from '../../src/config/portal-config.ts'
import { createDeferred } from '../../src/providers/adapters/adapter-base.ts'
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
      launchBrowser: async () => ({
        context: browserContext,
        disconnected: browserDisconnected.promise,
        close: async () => {
          browserCloseCount += 1
        },
      }),
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
