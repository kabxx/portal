import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BrowserContext } from 'playwright'

import { PortalApplicationCore } from '../../src/exec/portal-exec-session.ts'
import {
  RunCommandJobManager,
  type RunCommandJobHandle,
} from '../../src/processes/run-command-job-manager.ts'
import { RunCommandPlugin } from '../../src/tools/builtins/run-command-plugin.ts'
import { portalHostTestExtensions } from '../../src/extensions/portal-hooks.ts'
import { createDeferred } from '../../src/providers/adapters/adapter-base.ts'
import { createThreadStore } from '../../src/threads/thread-store.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'
import { createTestProviderExtensions } from '../helpers/provider-endpoint.ts'

test(
  'PortalApplicationCore runs headlessly, persists the final URL, and shuts down resources',
  { timeout: 20_000 },
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-exec-core-'))
    const dataDirectory = path.join(cwd, 'data')
    const readyPath = path.join(cwd, 'job-ready.txt')
    const adapter = createProviderAdapterStub()
    const disconnected = createDeferred<void>()
    let browserCloseCount = 0
    let runtimeCloseCount = 0
    const observed: { job?: RunCommandJobHandle } = {}
    const runCommandPlugin = new RunCommandPlugin({
      jobService: new RunCommandJobManager(),
    })
    let core: PortalApplicationCore | null = null

    try {
      // The three external boundaries are replaced while the real config,
      // Skills, thread lifecycle, SQLite store, and job manager run.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const browserContext = {} as unknown as BrowserContext
      core = await PortalApplicationCore.open(
        {
          cwd,
          dataDirectory,
          provider: 'chatgpt',
          model: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        {
          launchBrowser: async (engine, _executablePath, port, profilePath) => {
            assert.equal(engine, 'chromium')
            assert.equal(port, 0)
            assert.equal(
              profilePath,
              path.join(dataDirectory, 'profiles', 'chromium')
            )
            return {
              context: browserContext,
              disconnected: disconnected.promise,
              close: async () => {
                browserCloseCount += 1
              },
            }
          },
          [portalHostTestExtensions]: [
            ...createTestProviderExtensions(async (_providerId, context) => {
              assert.equal(context.setupMode, 'inline')
              const jobs = runCommandPlugin.jobService
              return createFakeRuntime({
                adapter,
                conversationId: 'portal-exec-test',
                conversationUrl: 'https://chatgpt.com/c/portal-exec-test',
                close: async () => {
                  runtimeCloseCount += 1
                },
                submitUserInput: async (input) => {
                  assert.equal(input, 'inspect portal')
                  observed.job = jobs.start(longRunningCommand(readyPath, cwd))
                  await waitForFile(readyPath)
                  return 'Portal inspected.'
                },
              })
            }),
            runCommandPlugin.registration,
          ],
        }
      )
      assert.equal(
        await core.run('inspect portal', new AbortController().signal),
        'Portal inspected.'
      )
      const startedJob = observed.job
      assert.ok(startedJob !== undefined)
      await core.close()
      await core.close()
      await assert.rejects(
        core.run('after close', new AbortController().signal),
        /exec Surface is closed/
      )

      assert.equal((await startedJob.wait()).terminationReason, 'shutdown')
      assert.equal(runtimeCloseCount, 1)
      assert.equal(browserCloseCount, 1)
      assert.equal(existsSync(path.join(dataDirectory, 'threads.db')), true)

      const store = await createThreadStore(
        path.join(dataDirectory, 'threads.db')
      )
      try {
        const history = await store.list()
        assert.equal(history.length, 1)
        assert.equal(history[0]?.provider, 'chatgpt')
        assert.equal(
          history[0]?.conversationUrl,
          'https://chatgpt.com/c/portal-exec-test'
        )
        assert.equal(history[0]?.title, 'inspect portal')
      } finally {
        store.close()
      }
    } finally {
      disconnected.resolve()
      await core?.close().catch(() => {})
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)

test(
  'PortalApplicationCore fails an exec task when the browser disconnects',
  { timeout: 20_000 },
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-exec-disconnect-'))
    const dataDirectory = path.join(cwd, 'data')
    const adapter = createProviderAdapterStub()
    const disconnected = createDeferred<void>()
    let core: PortalApplicationCore | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const browserContext = {} as unknown as BrowserContext
      core = await PortalApplicationCore.open(
        {
          cwd,
          dataDirectory,
          provider: 'chatgpt',
          model: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        {
          launchBrowser: async () => ({
            context: browserContext,
            disconnected: disconnected.promise,
            close: async () => {},
          }),
          [portalHostTestExtensions]: createTestProviderExtensions(async () =>
            createFakeRuntime({
              adapter,
              submitUserInput: async () => await new Promise<never>(() => {}),
            })
          ),
        }
      )

      const execution = core.run(
        'wait for browser',
        new AbortController().signal
      )
      disconnected.resolve()
      await assert.rejects(
        execution,
        /Browser disconnected while the exec task was running/
      )
    } finally {
      disconnected.resolve()
      await core?.close().catch(() => {})
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)

function longRunningCommand(ready: string, cwd: string) {
  const fixture = path.resolve('test/fixtures/run-command-ready.mjs')
  const invocation = [process.execPath, fixture, ready]
    .map(quoteShellArg)
    .join(' ')
  return {
    command: os.platform() === 'win32' ? `& ${invocation}` : invocation,
    cwd,
    shell:
      os.platform() === 'win32' ? ('powershell' as const) : ('sh' as const),
    timeoutMs: 30_000,
  }
}

function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file: ${filePath}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
