import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'

import {
  type CapturedFetchEntry,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderResponseTimeoutError,
  type ProviderTimingOptions,
} from '../../../src/providers/adapters/adapter-base.ts'
import {
  abortable,
  PortalAbortError,
} from '../../../src/runtime/runtime-cancellation.ts'

class ThrowingInitAdapter extends ProviderAdapter {
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

class ThrowingAuthInitAdapter extends ProviderAdapter {
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

class PollingAdapter extends ProviderAdapter {
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
    super({} as any, { timings })
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
  const adapter = new PollingAdapter({} as any, { timings })

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
    { newPage: async () => page } as any,
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
  const context = {
    newPage: async () => page,
  }

  await assert.rejects(
    ThrowingInitAdapter.create(context as any),
    /init failed/
  )

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
  const context = {
    newPage: async () => page,
  }

  let capturedError: unknown
  try {
    await ThrowingAuthInitAdapter.create(context as any)
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
  assert.notEqual(capturedError.adapter, null)
  assert.equal(closeCalls, 0)
})

test('ProviderAdapter.stopGeneration is a no-op extension point by default', async () => {
  const adapter = Object.create(ProviderAdapter.prototype) as ProviderAdapter

  await adapter.stopGeneration()
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
  const context = {
    newPage: async () => page,
  }
  const adapter = await PollingAdapter.create(context as any, {
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
      )
    },
    close: async () => undefined,
  }
  const context = {
    newPage: async () => page,
  }
  const adapter = await PollingAdapter.create(context as any)

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
  const context = {
    newPage: async () => page,
    newCDPSession: async () => cdpSession,
  }
  const adapter = await PollingAdapter.create(context as any, {
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
        (params as { cacheDisabled?: boolean }).cacheDisabled === false
    )
  )

  await adapter.finishHistoryCapture()
  assert.equal(detachCalls, 1)
  await adapter.close()
  assert.equal(detachCalls, 1)
})

test('ProviderAdapter submit text polling ignores abort errors from reporters', async () => {
  const adapter = Object.create(PollingAdapter.prototype) as PollingAdapter
  adapter.setSubmitTextReporter(async () => {
    throw new PortalAbortError('cancelled polling reporter')
  })

  const stopPolling = adapter.runPolling(async () => 'partial', 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  stopPolling()
})

test('ProviderAdapter safe submit status emission ignores abort errors from reporters', async () => {
  const adapter = Object.create(PollingAdapter.prototype) as PollingAdapter
  adapter.setSubmitStatusReporter(async () => {
    throw new PortalAbortError('cancelled status reporter')
  })

  await adapter.emitStatusSafely('waiting')
})
