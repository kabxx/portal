import test from 'node:test'
import assert from 'node:assert/strict'

import type { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import {
  ProviderAdapter,
  ProviderAdapterError,
} from '../../src/providers/adapters/adapter-base.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import { initializeRuntimeWithLoginWait } from '../../src/runtime/runtime-initializer.ts'
import {
  createBrowserContextStub,
  createFakeRuntime,
} from '../helpers/fakes.ts'

class FakeAdapter extends ProviderAdapter {
  public restoreCalls = 0
  public closeCalls = 0
  public loggedIn = false
  public restoreSignals: Array<AbortSignal | undefined> = []

  public constructor(private readonly events: string[] = []) {
    super(createBrowserContextStub())
  }

  public override async close() {
    this.closeCalls += 1
  }

  public async restore(options: { signal?: AbortSignal } = {}) {
    this.restoreCalls += 1
    this.restoreSignals.push(options.signal)
    this.events.push('restore')
  }

  public async isLoggedIn() {
    return this.loggedIn
  }

  public get conversationId(): string | null {
    return null
  }

  public get conversationUrl(): string {
    return 'https://example.com/thread'
  }

  public async changeModel(_model: string) {
    return undefined
  }

  public async attachText(_text: string) {
    return undefined
  }

  public async attachFile(_path: string | readonly string[]) {
    return undefined
  }

  public async attachImage(_path: string | readonly string[]) {
    return undefined
  }

  public async submit(): Promise<string> {
    return 'READY'
  }
}

test('initializeRuntimeWithLoginWait reuses the same adapter and restores before retrying after login wait', async () => {
  const events: string[] = []
  const adapter = new FakeAdapter(events)
  let createAdapterCalls = 0
  let createRuntimeCalls = 0
  const runtime = createFakeRuntime()

  const resolvedRuntime = await initializeRuntimeWithLoginWait({
    provider: 'chatgpt',
    browserProfileDir: 'C:\\profiles\\chrome',
    threadId: 't-1',
    createAdapter: async () => {
      createAdapterCalls += 1
      events.push('createAdapter')
      return adapter
    },
    createRuntime: async (currentAdapter): Promise<RuntimeCore> => {
      createRuntimeCalls += 1
      events.push('createRuntime')
      if (!adapter.loggedIn) {
        throw new ProviderAdapterError('restore', 'Login required.', {
          kind: 'auth',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          adapter: currentAdapter,
        })
      }
      return runtime
    },
    onWarning: async (plan) => {
      events.push(`warning:${plan.title}`)
    },
    onLoginWait: async () => {
      events.push('loginWait')
    },
    waitForLogin: async () => {
      events.push('waitForLogin')
      adapter.loggedIn = true
    },
  })

  assert.equal(resolvedRuntime, runtime)
  assert.equal(createAdapterCalls, 1)
  assert.equal(createRuntimeCalls, 2)
  assert.equal(adapter.restoreCalls, 1)
  assert.equal(adapter.closeCalls, 0)
  assert.deepEqual(events, [
    'createAdapter',
    'createRuntime',
    'warning:login required',
    'loginWait',
    'waitForLogin',
    'restore',
    'createRuntime',
  ])
})

test('initializeRuntimeWithLoginWait closes the pending adapter when a later non-login error stops initialization', async () => {
  const adapter = new FakeAdapter()
  let phase: 'auth' | 'fatal' = 'auth'

  await assert.rejects(
    initializeRuntimeWithLoginWait({
      provider: 'chatgpt',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-1',
      createAdapter: async () => adapter,
      createRuntime: async (currentAdapter) => {
        if (phase === 'auth') {
          phase = 'fatal'
          throw new ProviderAdapterError('restore', 'Login required.', {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            adapter: currentAdapter,
          })
        }
        throw new Error('fatal init error')
      },
      onWarning: async () => {
        return undefined
      },
      onLoginWait: async () => {
        return undefined
      },
      waitForLogin: async () => {
        adapter.loggedIn = true
        return undefined
      },
    }),
    /fatal init error/
  )

  assert.equal(adapter.restoreCalls, 1)
  assert.equal(adapter.closeCalls, 1)
})

test('initializeRuntimeWithLoginWait propagates abort without recovery warnings', async () => {
  const adapter = new FakeAdapter()
  let warningCalls = 0

  await assert.rejects(
    initializeRuntimeWithLoginWait({
      provider: 'chatgpt',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-1',
      createAdapter: async () => adapter,
      createRuntime: async () => {
        throw new PortalAbortError('cancel init')
      },
      onWarning: async () => {
        warningCalls += 1
      },
      onLoginWait: async () => {
        return undefined
      },
      waitForLogin: async () => {
        return undefined
      },
    }),
    PortalAbortError
  )

  assert.equal(warningCalls, 0)
})

test('initializeRuntimeWithLoginWait passes abort signal to pending adapter restore', async () => {
  const adapter = new FakeAdapter()
  const controller = new AbortController()
  let phase: 'auth' | 'ready' = 'auth'

  const runtime = await initializeRuntimeWithLoginWait({
    provider: 'chatgpt',
    browserProfileDir: 'C:\\profiles\\chrome',
    threadId: 't-1',
    createAdapter: async () => adapter,
    createRuntime: async (currentAdapter): Promise<RuntimeCore> => {
      if (phase === 'auth') {
        phase = 'ready'
        throw new ProviderAdapterError('restore', 'Login required.', {
          kind: 'auth',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          adapter: currentAdapter,
        })
      }
      return createFakeRuntime()
    },
    onWarning: async () => {
      return undefined
    },
    onLoginWait: async () => {
      return undefined
    },
    waitForLogin: async () => {
      adapter.loggedIn = true
    },
    signal: controller.signal,
  })

  assert.ok(runtime)
  assert.equal(adapter.restoreSignals[0], controller.signal)
})

test('initializeRuntimeWithLoginWait propagates abort from pending adapter restore without warning', async () => {
  const adapter = new FakeAdapter()
  const controller = new AbortController()
  let warningCalls = 0
  let phase: 'auth' | 'aborted' = 'auth'
  adapter.restore = async (options: { signal?: AbortSignal } = {}) => {
    adapter.restoreCalls += 1
    adapter.restoreSignals.push(options.signal)
    throw new PortalAbortError('cancel restore')
  }

  await assert.rejects(
    initializeRuntimeWithLoginWait({
      provider: 'chatgpt',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-1',
      createAdapter: async () => adapter,
      createRuntime: async (currentAdapter) => {
        if (phase === 'auth') {
          phase = 'aborted'
          throw new ProviderAdapterError('restore', 'Login required.', {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            adapter: currentAdapter,
          })
        }
        return createFakeRuntime()
      },
      onWarning: async () => {
        warningCalls += 1
      },
      onLoginWait: async () => {
        return undefined
      },
      waitForLogin: async () => {
        adapter.loggedIn = true
      },
      signal: controller.signal,
    }),
    PortalAbortError
  )

  assert.equal(warningCalls, 1)
  assert.equal(adapter.restoreCalls, 1)
  assert.equal(adapter.restoreSignals[0], controller.signal)
})

test('initializeRuntimeWithLoginWait automatically retries transient initialization errors', async () => {
  const events: string[] = []
  const runtime = createFakeRuntime()
  let createAdapterCalls = 0
  let createRuntimeCalls = 0
  const adapters: FakeAdapter[] = []

  const resolvedRuntime = await initializeRuntimeWithLoginWait({
    provider: 'chatgpt',
    browserProfileDir: 'C:\\profiles\\chrome',
    threadId: 't-1',
    createAdapter: async () => {
      createAdapterCalls += 1
      events.push(`createAdapter:${createAdapterCalls}`)
      const adapter = new FakeAdapter(events)
      adapter.loggedIn = true
      adapters.push(adapter)
      return adapter
    },
    createRuntime: async () => {
      createRuntimeCalls += 1
      events.push(`createRuntime:${createRuntimeCalls}`)
      if (createRuntimeCalls === 1) {
        throw new ProviderAdapterError('restore', 'Temporary page issue.', {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
        })
      }
      return runtime
    },
    onWarning: async (plan) => {
      events.push(`warning:${plan.title}`)
    },
    onLoginWait: async () => {
      events.push('loginWait')
    },
    waitForLogin: async () => {
      events.push('waitForLogin')
    },
  })

  assert.equal(resolvedRuntime, runtime)
  assert.equal(createAdapterCalls, 2)
  assert.equal(createRuntimeCalls, 2)
  assert.equal(adapters[0]?.closeCalls, 1)
  assert.equal(adapters[1]?.closeCalls, 0)
  assert.deepEqual(events, [
    'createAdapter:1',
    'createRuntime:1',
    'warning:temporary runtime issue',
    'createAdapter:2',
    'createRuntime:2',
  ])
})

test('initializeRuntimeWithLoginWait returns null after automatic initialization retries are exhausted', async () => {
  const events: string[] = []
  let adapter: FakeAdapter | null = null

  const resolvedRuntime = await initializeRuntimeWithLoginWait({
    provider: 'chatgpt',
    browserProfileDir: 'C:\\profiles\\chrome',
    threadId: 't-1',
    createAdapter: async () => {
      events.push('createAdapter')
      adapter = new FakeAdapter(events)
      adapter.loggedIn = true
      return adapter
    },
    createRuntime: async () => {
      events.push('createRuntime')
      throw new ProviderAdapterError('restore', 'Temporary page issue.', {
        kind: 'transient',
        recovery: 'restore',
        retryable: true,
        maxAttempts: 2,
      })
    },
    onWarning: async (plan) => {
      events.push(`warning:${plan.title}`)
    },
    onLoginWait: async () => {
      events.push('loginWait')
    },
    waitForLogin: async () => {
      events.push('waitForLogin')
    },
    maxRetryAttempts: 2,
  })

  assert.equal(resolvedRuntime, null)
  assert.equal((adapter as FakeAdapter | null)?.closeCalls, 1)
  assert.deepEqual(events, [
    'createAdapter',
    'createRuntime',
    'warning:temporary runtime issue',
    'createAdapter',
    'createRuntime',
    'warning:temporary runtime issue',
  ])
})
