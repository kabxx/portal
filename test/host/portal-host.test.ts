import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { BrowserContext } from 'playwright'
import type { ConversationHistoryResult } from '../../src/providers/conversation-history.ts'
import { RuntimeInitializationCleanupError } from '../../src/runtime/runtime-initializer.ts'
import {
  PortalHost,
  PortalHostOperationTimeoutError,
} from '../../src/host/portal-host.ts'
import { createDeferred } from '../../src/providers/adapters/adapter-base.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'

test('PortalHost owns the resolved built-in Command plan and session lifecycle', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-commands-'))
  const dataDirectory = path.join(cwd, 'data')
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      { profile: 'tui', cwd, dataDirectory },
      {
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => undefined,
        }),
      }
    )
    const catalog = host.commandCatalog()
    assert.deepEqual(
      catalog.map(({ primaryName }) => primaryName),
      [
        '/help',
        '/thread',
        '/skill',
        '/mcp',
        '/job',
        '/keybinding',
        '/providers',
        '/exit',
      ]
    )
    assert.equal(Object.isFrozen(catalog), true)

    const session = host.openCommandSession('host-test')
    await host.start()
    const analysis = session.prepare('/exit')
    assert.equal(analysis.kind, 'ready')
    if (analysis.kind !== 'ready') return
    assert.deepEqual(
      await session.execute(analysis.invocation, {
        signal: new AbortController().signal,
        deadline: Number.POSITIVE_INFINITY,
      }),
      { disposition: 'request-stop' }
    )

    await host.close()
    await assert.rejects(
      session.execute(analysis.invocation, {
        signal: new AbortController().signal,
        deadline: Number.POSITIVE_INFINITY,
      })
    )
    assert.throws(
      () => host?.openCommandSession('closed'),
      /unavailable in state "stopped"/
    )
  } finally {
    await host?.close().catch(() => {})
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost prepares without launching a browser and starts once', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-'))
  const dataDirectory = path.join(cwd, 'data')
  const adapter = createProviderAdapterStub()
  const disconnected = createDeferred<void>()
  let launchCount = 0
  let closeCount = 0
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async (_engine, _executable, _port, profile) => {
          launchCount += 1
          assert.equal(
            profile,
            path.join(dataDirectory, 'profiles', 'chromium')
          )
          return {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            context: {
              isClosed: () => false,
            } as unknown as BrowserContext,
            disconnected: disconnected.promise,
            close: async () => {
              closeCount += 1
            },
          }
        },
        createProviderAdapter: async () => adapter,
        createRuntime: async (_adapter, options) => {
          assert.equal(options?.setupMode, 'inline')
          return createFakeRuntime({ adapter })
        },
      }
    )
    assert.equal(host.state, 'resolved')
    assert.equal(launchCount, 0)
    const first = host.start()
    const second = host.start()
    assert.equal(first, second)
    assert.equal((await first).lifecycle, (await second).lifecycle)
    assert.equal(host.state, 'ready')
    assert.equal(launchCount, 1)
    await host.close()
    await host.close()
    assert.equal(host.state, 'stopped')
    assert.equal(closeCount, 1)
    await assert.rejects(host.start(), /cannot start from state "stopped"/)
    assert.throws(() => host.services, /unavailable in state "stopped"/)
  } finally {
    disconnected.resolve()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost closes a browser that resolves after shutdown begins', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-late-'))
  const dataDirectory = path.join(cwd, 'data')
  const launch = createDeferred<{
    context: BrowserContext
    disconnected: Promise<void>
    close(): Promise<void>
  }>()
  const launchStarted = Promise.withResolvers<void>()
  let closeCount = 0
  try {
    const host = await PortalHost.prepare(
      { profile: 'tui', cwd, dataDirectory },
      {
        launchBrowser: async () => {
          launchStarted.resolve()
          return await launch.promise
        },
      }
    )
    const start = host.start()
    await launchStarted.promise
    const close = host.close()
    launch.resolve({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      context: { isClosed: () => false } as unknown as BrowserContext,
      disconnected: new Promise(() => {}),
      close: async () => {
        closeCount += 1
      },
    })
    await assert.rejects(start)
    await close
    assert.equal(closeCount, 1)
    assert.equal(host.state, 'stopped')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost rolls back prepared resources after browser startup fails', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-fail-'))
  const dataDirectory = path.join(cwd, 'data')
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => {
          throw new Error('launch failed')
        },
      }
    )
    await assert.rejects(host.start(), /launch failed/)
    assert.equal(host.state, 'failed')
    await host.close()
    assert.equal(host.state, 'stopped')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost rolls back a browser when startup is aborted after acquisition', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-abort-'))
  const dataDirectory = path.join(cwd, 'data')
  const controller = new AbortController()
  let closeCount = 0
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => {
          controller.abort(new Error('stop startup'))
          return {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            context: { isClosed: () => false } as unknown as BrowserContext,
            disconnected: new Promise(() => {}),
            close: async () => {
              closeCount += 1
            },
          }
        },
      }
    )
    await assert.rejects(
      host.start({ signal: controller.signal }),
      /stop startup/
    )
    assert.equal(closeCount, 1)
    assert.equal(host.state, 'failed')
    await host.close()
    assert.equal(closeCount, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost reports thread cleanup failure after closing later resources', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-cleanup-'))
  const dataDirectory = path.join(cwd, 'data')
  const adapter = createProviderAdapterStub()
  const events: string[] = []
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {
            events.push('browser close')
          },
        }),
        createProviderAdapter: async () => adapter,
        createRuntime: async () =>
          createFakeRuntime({
            adapter,
            close: async () => {
              events.push('runtime close')
              throw new Error('runtime cleanup failed')
            },
          }),
      }
    )
    const services = await host.start()
    const provision = await services.lifecycle.create({
      provider: 'chatgpt',
      model: null,
      mode: 'agent',
      source: 'exec',
    })
    assert.equal(provision.ok, true)
    await assert.rejects(host.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.match(
        String(error.errors[0]),
        /runtime cleanup failed|failed to close cleanly/
      )
      return true
    })
    assert.deepEqual(events, ['runtime close', 'browser close'])
    assert.equal(host.state, 'stopped')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost waits for late provisioning rollback before closing the browser', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-provision-'))
  const dataDirectory = path.join(cwd, 'data')
  const adapter = createProviderAdapterStub()
  const runtimeRequested = Promise.withResolvers<void>()
  const runtimeDeferred = createDeferred<ReturnType<typeof createFakeRuntime>>()
  const events: string[] = []
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {
            events.push('browser close')
          },
        }),
        createProviderAdapter: async () => adapter,
        createRuntime: async () => {
          runtimeRequested.resolve()
          return await runtimeDeferred.promise
        },
      }
    )
    const services = await host.start()
    const provisioning = services.lifecycle.create({
      provider: 'chatgpt',
      model: null,
      mode: 'agent',
      source: 'exec',
    })
    await runtimeRequested.promise
    const closing = host.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(events.length, 0)

    runtimeDeferred.resolve(
      createFakeRuntime({
        adapter,
        close: async () => {
          events.push('runtime close')
        },
      })
    )
    const provision = await provisioning
    await closing

    assert.equal(provision.ok, false)
    assert.deepEqual(events, ['runtime close', 'browser close'])
    assert.deepEqual(services.threadManager.listThreads(), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost closes a late provisioning adapter before the browser', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-adapter-'))
  const dataDirectory = path.join(cwd, 'data')
  const adapter = createProviderAdapterStub()
  const adapterRequested = Promise.withResolvers<void>()
  const adapterDeferred = Promise.withResolvers<typeof adapter>()
  const events: string[] = []
  let createRuntimeCalls = 0
  adapter.close = async () => {
    events.push('adapter close')
  }
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {
            events.push('browser close')
          },
        }),
        createProviderAdapter: async () => {
          adapterRequested.resolve()
          return await adapterDeferred.promise
        },
        createRuntime: async () => {
          createRuntimeCalls += 1
          return createFakeRuntime()
        },
      }
    )
    const services = await host.start()
    const provisioning = services.lifecycle.create({
      provider: 'chatgpt',
      model: null,
      mode: 'agent',
      source: 'exec',
    })
    await adapterRequested.promise
    const closing = host.close()
    adapterDeferred.resolve(adapter)

    const result = await provisioning
    await closing

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.failure.code, 'cancelled')
    assert.equal(createRuntimeCalls, 0)
    assert.deepEqual(events, ['adapter close', 'browser close'])
    assert.deepEqual(services.threadManager.listThreads(), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('PortalHost reports late adapter cleanup failure and still closes the browser', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-adapter-fail-'))
  const dataDirectory = path.join(cwd, 'data')
  const adapter = createProviderAdapterStub()
  const adapterRequested = Promise.withResolvers<void>()
  const adapterDeferred = Promise.withResolvers<typeof adapter>()
  const events: string[] = []
  adapter.close = async () => {
    events.push('adapter close')
    throw new Error('adapter cleanup failed')
  }
  try {
    const host = await PortalHost.prepare(
      { profile: 'exec', cwd, dataDirectory },
      {
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: new Promise(() => {}),
          close: async () => {
            events.push('browser close')
          },
        }),
        createProviderAdapter: async () => {
          adapterRequested.resolve()
          return await adapterDeferred.promise
        },
      }
    )
    const services = await host.start()
    const provisioning = services.lifecycle.create({
      provider: 'chatgpt',
      model: null,
      mode: 'agent',
      source: 'exec',
    })
    await adapterRequested.promise
    const closing = host.close()
    adapterDeferred.resolve(adapter)

    await assert.rejects(provisioning, RuntimeInitializationCleanupError)
    await assert.rejects(closing, AggregateError)
    assert.deepEqual(events, ['adapter close', 'browser close'])
    assert.deepEqual(services.threadManager.listThreads(), [])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test(
  'PortalHost prevents history from committing after provisioning shutdown times out',
  { timeout: 10_000 },
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'portal-host-history-'))
    const dataDirectory = path.join(cwd, 'data')
    const historyStarted = Promise.withResolvers<void>()
    const historyDeferred = Promise.withResolvers<ConversationHistoryResult>()
    const events: string[] = []
    const runtime = createFakeRuntime({
      conversationUrl: 'https://chatgpt.com/c/late-host-history',
      loadHistory: async () => {
        historyStarted.resolve()
        return await historyDeferred.promise
      },
      close: async () => {
        events.push('runtime close')
      },
    })
    try {
      const host = await PortalHost.prepare(
        { profile: 'exec', cwd, dataDirectory },
        {
          launchBrowser: async () => ({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            context: { isClosed: () => false } as unknown as BrowserContext,
            disconnected: new Promise(() => {}),
            close: async () => {
              events.push('browser close')
            },
          }),
          createProviderAdapter: async () => createProviderAdapterStub(),
          createRuntime: async () => runtime,
        }
      )
      const services = await host.start()
      const provisioning = services.lifecycle.resume({
        conversationUrl: runtime.conversationUrl,
        source: 'exec',
      })
      await historyStarted.promise

      await assert.rejects(host.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.ok(
          error.errors.some(
            (candidate) => candidate instanceof PortalHostOperationTimeoutError
          )
        )
        return true
      })
      assert.deepEqual(events, ['browser close'])
      assert.equal(host.state, 'stopped')

      historyDeferred.resolve({
        messages: [],
        complete: true,
        warning: null,
      })
      const result = await provisioning

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.failure.code, 'cancelled')
      assert.deepEqual(events, ['browser close', 'runtime close'])
      assert.deepEqual(services.threadManager.listThreads(), [])
      assert.deepEqual(services.runtimeRegistry.list(), [])
    } finally {
      historyDeferred.resolve({
        messages: [],
        complete: true,
        warning: null,
      })
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)
