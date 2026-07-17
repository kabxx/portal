import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import type { Response } from 'playwright'

import {
  type CapturedFetchEntry,
  createDeferred,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderResponseTimeoutError,
  type ProviderCdpSession,
  type ProviderPage,
  type ProviderTimingOptions,
} from '../../../src/providers/adapters/adapter-base.ts'
import {
  abortable,
  PortalAbortError,
} from '../../../src/runtime/runtime-cancellation.ts'
import {
  createBrowserContextStub,
  createProviderContextStub,
} from '../../helpers/fakes.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('createDeferred preserves an early rejection for a later consumer', async () => {
  const deferred = createDeferred<void>()

  deferred.reject(new Error('early deferred failure'))
  await new Promise<void>((resolve) => setImmediate(resolve))

  await assert.rejects(deferred.promise, /early deferred failure/)
})

class ThrowingInitAdapter extends ProviderAdapter<
  ProviderPage,
  ProviderCdpSession
> {
  protected override async init() {
    await super.init()
    throw new Error('init failed')
  }

  public async restore() {
    return undefined
  }

  public async isLoggedIn() {
    return true
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

class ThrowingAuthInitAdapter extends ProviderAdapter<
  ProviderPage,
  ProviderCdpSession
> {
  protected override async init() {
    await super.init()
    throw new ProviderAdapterError('restore', 'Login required during init.', {
      kind: 'auth',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
    })
  }

  public async restore() {
    return undefined
  }

  public async isLoggedIn() {
    return false
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

class PollingAdapter extends ProviderAdapter<ProviderPage, ProviderCdpSession> {
  public readTimingOptions() {
    return {
      requestStartWarningAfterMs: this.getSubmitRequestStartGraceMs(),
      blockedWarningIntervalMs: this.getSubmitBlockedWarningIntervalMs(),
      responseStartTimeoutMs: this.getSubmitResponseStartTimeoutMs(),
      responseStallTimeoutMs: this.getSubmitResponseStallTimeoutMs(),
      restoreTimeoutMs: this.getRestoreTimeoutMs(),
      historyLoadTimeoutMs: this.getHistoryLoadTimeoutMs(),
      historyPageTimeoutMs: this.getHistoryPageTimeoutMs(),
    }
  }

  public async readHistoryEntries(
    predicate: (entry: CapturedFetchEntry) => boolean
  ) {
    return await this.getCapturedHistoryEntries(predicate)
  }

  public async readHistoryRequestHeaders(
    predicate: (entry: CapturedFetchEntry) => boolean
  ) {
    return await this.getCapturedHistoryRequestHeaders(predicate)
  }

  public async readFetchCount() {
    return await this.getCapturedFetchEntryCount()
  }

  public async readLatestFetchBody(
    startIndex: number,
    predicate: (entry: CapturedFetchEntry) => boolean
  ) {
    return await this.getLatestCapturedFetchBody(startIndex, predicate)
  }

  public runPolling(
    readCurrentText: () => Promise<string | null>,
    intervalMs = 50
  ): () => void {
    return this.startSubmitTextPolling(readCurrentText, intervalMs)
  }

  public async emitStatusSafely(message: string): Promise<void> {
    await this.emitSubmitStatusSafely(message)
  }

  public async clickTestLocator(locator: {
    count: () => Promise<number>
    first: () => {
      isVisible: () => Promise<boolean>
      click: () => Promise<void>
    }
  }): Promise<boolean> {
    return await this.clickLocatorIfReady(locator)
  }

  public async restore() {
    return undefined
  }

  public async isLoggedIn() {
    return true
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

type PageEventListener = ((response: Response) => void) | (() => void)

class CloseAwarePage implements ProviderPage {
  private readonly events = new EventEmitter()
  private closed = false

  public async close(): Promise<void> {
    this.closeExternally()
  }

  public async pause(): Promise<void> {}

  public on(event: 'response', listener: (response: Response) => void): unknown
  public on(event: 'close', listener: () => void): unknown
  public on(event: 'response' | 'close', listener: PageEventListener): unknown {
    return this.events.on(event, listener)
  }

  public off(event: 'response', listener: (response: Response) => void): unknown
  public off(event: 'close', listener: () => void): unknown
  public off(
    event: 'response' | 'close',
    listener: PageEventListener
  ): unknown {
    return this.events.off(event, listener)
  }

  public isClosed(): boolean {
    return this.closed
  }

  public closeExternally(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.events.emit('close')
  }
}

class PageLifecycleAdapter extends ProviderAdapter<CloseAwarePage> {
  public async restore(): Promise<void> {}

  public async isLoggedIn(): Promise<boolean> {
    return true
  }

  public get conversationId(): string | null {
    return null
  }

  public get conversationUrl(): string {
    return 'https://example.com/thread'
  }

  public async changeModel(_model: string): Promise<void> {}

  public async attachText(_text: string): Promise<void> {}

  public async attachFile(_path: string | readonly string[]): Promise<void> {}

  public async attachImage(_path: string | readonly string[]): Promise<void> {}

  public async submit(): Promise<string> {
    return 'READY'
  }
}

class ResponseTimingAdapter extends ProviderAdapter {
  public submitCalls = 0
  public stopCalls = 0
  public activityCalls = 0

  public constructor(
    timings: ProviderTimingOptions,
    private readonly runSubmit: (
      adapter: ResponseTimingAdapter,
      signal?: AbortSignal
    ) => Promise<string>
  ) {
    super(createBrowserContextStub(), { timings })
  }

  public reportActivity(): void {
    this.emitSubmitActivity()
  }

  public reportCapturedEntries(entries: readonly CapturedFetchEntry[]): void {
    this.reportCapturedSubmitActivity(entries)
  }

  protected override emitSubmitActivity(): void {
    this.activityCalls += 1
    super.emitSubmitActivity()
  }

  public async restore() {
    return undefined
  }

  public async isLoggedIn() {
    return true
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

  public override async stopGeneration(): Promise<void> {
    this.stopCalls += 1
  }

  public async submit(options: { signal?: AbortSignal } = {}): Promise<string> {
    this.submitCalls += 1
    this.emitSubmitSent()
    return await this.runSubmit(this, options.signal)
  }
}

function responseTimings(
  responseStartTimeoutMs: number,
  responseStallTimeoutMs: number
): ProviderTimingOptions {
  return {
    requestStartWarningAfterMs: 100,
    blockedWarningIntervalMs: 100,
    responseStartTimeoutMs,
    responseStallTimeoutMs,
    restoreTimeoutMs: 100,
    historyLoadTimeoutMs: 100,
    historyPageTimeoutMs: 100,
  }
}

test('ProviderAdapter uses configured provider timing options', () => {
  const timings = {
    requestStartWarningAfterMs: 1,
    blockedWarningIntervalMs: 2,
    responseStartTimeoutMs: 3,
    responseStallTimeoutMs: 4,
    restoreTimeoutMs: 5,
    historyLoadTimeoutMs: 6,
    historyPageTimeoutMs: 7,
  }
  const adapter = new PollingAdapter(createProviderContextStub({}), {
    timings,
  })

  assert.deepEqual(adapter.readTimingOptions(), timings)
})

test('ProviderAdapter fails and stops generation when initial response activity times out', async () => {
  const adapter = new ResponseTimingAdapter(
    responseTimings(10, 20),
    async (_adapter, signal) =>
      await abortable(new Promise<string>(() => {}), signal)
  )

  await assert.rejects(
    adapter.submitWithResponseTimeout(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderResponseTimeoutError)
      assert.equal(error.detailCode, 'provider_response_start_timeout')
      assert.equal(error.retryable, false)
      return true
    }
  )
  assert.equal(adapter.submitCalls, 1)
  assert.equal(adapter.stopCalls, 1)
})

test('ProviderAdapter switches to stall timeout after non-text response activity', async () => {
  const adapter = new ResponseTimingAdapter(
    responseTimings(50, 10),
    async (current, signal) => {
      setTimeout(() => current.reportActivity(), 5)
      return await abortable(new Promise<string>(() => {}), signal)
    }
  )

  await assert.rejects(
    adapter.submitWithResponseTimeout(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderResponseTimeoutError)
      assert.equal(error.detailCode, 'provider_response_stall_timeout')
      return true
    }
  )
  assert.equal(adapter.stopCalls, 1)
})

test('ProviderAdapter response activity keeps a long stream alive and completion clears the watchdog', async () => {
  const adapter = new ResponseTimingAdapter(
    responseTimings(20, 20),
    async (current) => {
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        current.reportActivity()
      }
      return 'done'
    }
  )

  assert.equal(await adapter.submitWithResponseTimeout(), 'done')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(adapter.stopCalls, 0)
})

test('ProviderAdapter does not count an unchanged captured response snapshot twice', async () => {
  const entry: CapturedFetchEntry = {
    id: 1,
    url: 'https://example.com/provider-response',
    method: 'POST',
    status: 200,
    chunks: [': heartbeat\n\n'],
    done: false,
    error: null,
  }
  const adapter = new ResponseTimingAdapter(
    responseTimings(20, 20),
    async (current) => {
      current.reportCapturedEntries([entry])
      current.reportCapturedEntries([{ ...entry, chunks: [...entry.chunks] }])
      return 'done'
    }
  )

  assert.equal(await adapter.submitWithResponseTimeout(), 'done')
  assert.equal(adapter.activityCalls, 1)
})

test('ProviderAdapter bounds history capture waits with the configured page timeout', async () => {
  const page = {
    addInitScript: async () => undefined,
    evaluate: async () => [],
    close: async () => undefined,
  }
  const adapter = await PollingAdapter.create(
    createProviderContextStub({ newPage: async () => page }),
    {
      timings: {
        requestStartWarningAfterMs: 1,
        blockedWarningIntervalMs: 1,
        responseStartTimeoutMs: 1,
        responseStallTimeoutMs: 1,
        restoreTimeoutMs: 1,
        historyLoadTimeoutMs: 20,
        historyPageTimeoutMs: 5,
      },
    }
  )
  const startedAt = Date.now()

  assert.deepEqual(await adapter.readHistoryEntries(() => true), [])
  assert.ok(Date.now() - startedAt < 200)
  await adapter.close()
})

test('ProviderAdapter.create closes the opened page when init fails', async () => {
  let closeCalls = 0
  const page = {
    close: async () => {
      closeCalls += 1
    },
    pause: async () => {
      return undefined
    },
  }
  const context = createProviderContextStub({
    newPage: async () => page,
  })

  await assert.rejects(ThrowingInitAdapter.create(context), /init failed/)

  assert.equal(closeCalls, 1)
})

test('ProviderAdapter.create keeps the page open for auth init failures', async () => {
  let closeCalls = 0
  const page = {
    close: async () => {
      closeCalls += 1
    },
    pause: async () => {
      return undefined
    },
  }
  const context = createProviderContextStub({
    newPage: async () => page,
  })

  let capturedError: unknown
  try {
    await ThrowingAuthInitAdapter.create(context)
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
  assert.notEqual(capturedError.adapter, null)
  assert.equal(closeCalls, 0)
})

test('ProviderAdapter.stopGeneration is a no-op extension point by default', async () => {
  const adapter = new PollingAdapter(createProviderContextStub({}))

  await adapter.stopGeneration()
})

test('ProviderAdapter clicks only one visible locator without forcing', async () => {
  const adapter = new PollingAdapter(createBrowserContextStub())
  const calls: unknown[] = []
  const createLocator = (
    count: number,
    visible: boolean,
    click: () => Promise<void> = async () => {
      calls.push(undefined)
    }
  ) => ({
    count: async () => count,
    first: () => ({
      isVisible: async () => visible,
      click,
    }),
  })

  assert.equal(await adapter.clickTestLocator(createLocator(0, true)), false)
  assert.equal(await adapter.clickTestLocator(createLocator(2, true)), false)
  assert.equal(await adapter.clickTestLocator(createLocator(1, false)), false)
  assert.equal(await adapter.clickTestLocator(createLocator(1, true)), true)
  assert.equal(calls.length, 1)

  const clickArguments: unknown[][] = []
  assert.equal(
    await adapter.clickTestLocator(
      createLocator(1, true, async (...args: unknown[]) => {
        clickArguments.push(args)
        throw new Error('click failed')
      })
    ),
    false
  )
  assert.deepEqual(clickArguments, [[]])
})

test('ProviderAdapter captures matching Playwright response bodies for history', async () => {
  const emitter = new EventEmitter()
  let responseTextCalls = 0
  const page = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    addInitScript: async () => undefined,
    evaluate: async () => [],
    close: async () => undefined,
  }
  const context = createProviderContextStub({
    newPage: async () => page,
  })
  const adapter = await PollingAdapter.create(context, {
    conversationUrl: 'https://example.com/thread',
  })
  const response = {
    url: () => 'https://example.com/api/history',
    status: () => 200,
    request: () => ({
      method: () => 'GET',
      resourceType: () => 'fetch',
      allHeaders: async () => ({ authorization: 'secret', 'x-client': 'web' }),
    }),
    text: async () => {
      responseTextCalls += 1
      return '{"messages":["hello"]}'
    },
  }
  const predicate = (entry: CapturedFetchEntry) =>
    entry.url.endsWith('/api/history') && entry.status === 200
  const firstPromise = adapter.readHistoryEntries(predicate)
  setTimeout(() => emitter.emit('response', response), 5)
  const first = await firstPromise
  const second = await adapter.readHistoryEntries(predicate)
  const headers = await adapter.readHistoryRequestHeaders(predicate)

  assert.equal(first[0]?.chunks.join(''), '{"messages":["hello"]}')
  assert.equal(second[0]?.chunks.join(''), '{"messages":["hello"]}')
  assert.equal(responseTextCalls, 1)
  assert.deepEqual(headers, {
    authorization: 'secret',
    'x-client': 'web',
  })
  await adapter.close()
})

test('ProviderAdapter reads capture counts and only fetches entries after the start index', async () => {
  const capturedEntries: CapturedFetchEntry[] = [
    {
      id: 1,
      url: 'https://example.com/api/old',
      method: 'GET',
      status: 200,
      chunks: ['old body'],
      done: true,
      error: null,
    },
    {
      id: 2,
      url: 'https://example.com/api/current',
      method: 'GET',
      status: 200,
      chunks: ['current body'],
      done: true,
      error: null,
    },
  ]
  const evaluateArguments: unknown[] = []
  const browserContext = createContext({
    __portalFetchCaptureEntries: capturedEntries,
    __portalGetFetchCaptureEntries: (startIndex = 0) =>
      capturedEntries.slice(startIndex).map((entry) => ({
        ...entry,
        chunks: [...entry.chunks],
      })),
  })
  const page = {
    addInitScript: async () => undefined,
    evaluate: async (expression: unknown, argument?: unknown) => {
      if (typeof expression === 'string') {
        return undefined
      }
      evaluateArguments.push(argument)
      if (typeof expression !== 'function') {
        throw new Error('Expected an evaluate function.')
      }
      const serializedArgument =
        argument === undefined ? 'undefined' : JSON.stringify(argument)
      return runInContext(
        `(${expression.toString()})(${serializedArgument})`,
        browserContext
      ) as unknown
    },
    close: async () => undefined,
  }
  const context = createProviderContextStub({
    newPage: async () => page,
  })
  const adapter = await PollingAdapter.create(context)

  assert.equal(await adapter.readFetchCount(), 2)
  assert.equal(
    await adapter.readLatestFetchBody(1, (entry) =>
      entry.url.endsWith('/api/current')
    ),
    'current body'
  )
  assert.deepEqual(evaluateArguments, [undefined, 1])
  await adapter.close()
})

test('ProviderAdapter captures history bodies through CDP and releases the session', async () => {
  const pageEmitter = new EventEmitter()
  const cdpEmitter = new EventEmitter()
  const sendCalls: Array<{ method: string; params: unknown }> = []
  let detachCalls = 0
  const page = {
    on: pageEmitter.on.bind(pageEmitter),
    off: pageEmitter.off.bind(pageEmitter),
    addInitScript: async () => undefined,
    evaluate: async () => [],
    close: async () => undefined,
  }
  const cdpSession = {
    on: cdpEmitter.on.bind(cdpEmitter),
    send: async (method: string, params: unknown) => {
      sendCalls.push({ method, params })
      return method === 'Network.getResponseBody'
        ? { body: '{"messages":["from-cdp"]}', base64Encoded: false }
        : {}
    },
    detach: async () => {
      detachCalls += 1
    },
  }
  const context = createProviderContextStub({
    newPage: async () => page,
    newCDPSession: async () => cdpSession,
  })
  const adapter = await PollingAdapter.create(context, {
    conversationUrl: 'https://example.com/thread',
  })
  cdpEmitter.emit('Network.requestWillBeSent', {
    requestId: 'request-1',
    request: {
      url: 'https://example.com/api/history',
      method: 'GET',
      headers: { authorization: 'secret' },
    },
  })
  cdpEmitter.emit('Network.responseReceived', {
    requestId: 'request-1',
    response: {
      url: 'https://example.com/api/history',
      status: 200,
    },
  })
  cdpEmitter.emit('Network.loadingFinished', { requestId: 'request-1' })

  const entries = await adapter.readHistoryEntries((entry) =>
    entry.url.endsWith('/api/history')
  )
  assert.equal(entries[0]?.chunks.join(''), '{"messages":["from-cdp"]}')
  assert.ok(
    sendCalls.some(
      ({ method, params }) =>
        method === 'Network.setCacheDisabled' &&
        isRecord(params) &&
        params.cacheDisabled === false
    )
  )

  await adapter.finishHistoryCapture()
  assert.equal(detachCalls, 1)
  await adapter.close()
  assert.equal(detachCalls, 1)
})

test('ProviderAdapter submit text polling ignores abort errors from reporters', async () => {
  const adapter = new PollingAdapter(createProviderContextStub({}))
  adapter.setSubmitTextReporter(async () => {
    throw new PortalAbortError('cancelled polling reporter')
  })

  const stopPolling = adapter.runPolling(async () => 'partial', 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  stopPolling()
})

test('ProviderAdapter safe submit status emission ignores abort errors from reporters', async () => {
  const adapter = new PollingAdapter(createProviderContextStub({}))
  adapter.setSubmitStatusReporter(async () => {
    throw new PortalAbortError('cancelled status reporter')
  })

  await adapter.emitStatusSafely('waiting')
})

test('ProviderAdapter reports one unexpected page close', async () => {
  const page = new CloseAwarePage()
  const adapter = await PageLifecycleAdapter.create(
    createBrowserContextStub(page)
  )
  let closeEvents = 0
  adapter.onUnexpectedPageClose(() => {
    closeEvents += 1
  })

  page.closeExternally()
  page.closeExternally()
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(closeEvents, 1)
})

test('ProviderAdapter reports a page that closed before subscription', async () => {
  const page = new CloseAwarePage()
  const adapter = await PageLifecycleAdapter.create(
    createBrowserContextStub(page)
  )
  page.closeExternally()
  let closeEvents = 0

  adapter.onUnexpectedPageClose(() => {
    closeEvents += 1
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(closeEvents, 1)
})

test('ProviderAdapter suppresses queued and portal-initiated page closes', async () => {
  const externallyClosedPage = new CloseAwarePage()
  const externalAdapter = await PageLifecycleAdapter.create(
    createBrowserContextStub(externallyClosedPage)
  )
  let externalEvents = 0
  const unsubscribe = externalAdapter.onUnexpectedPageClose(() => {
    externalEvents += 1
  })
  externallyClosedPage.closeExternally()
  unsubscribe()

  const portalClosedPage = new CloseAwarePage()
  const portalAdapter = await PageLifecycleAdapter.create(
    createBrowserContextStub(portalClosedPage)
  )
  let portalEvents = 0
  portalAdapter.onUnexpectedPageClose(() => {
    portalEvents += 1
  })
  await portalAdapter.close()
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(externalEvents, 0)
  assert.equal(portalEvents, 0)
})
