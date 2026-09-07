import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  ProviderResponseTimeoutError,
  createDeferred,
  type CapturedFetchEntry,
} from '../../../src/providers/adapters/adapter-base.ts'
import { QwenAdapter } from '../../../src/providers/adapters/adapter-qwen.ts'
import { joinCssLocatorCandidates } from '../../../src/providers/ui/provider-ui.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const QWEN_COMPLETION_URL = 'https://chat.qwen.ai/api/v2/chat/completions'
const QWEN_LOCATORS = {
  modelTrigger: [
    '#qwen-chat-header-left [role="button"][aria-haspopup="listbox"]',
  ],
  modelListbox: ['[role="listbox"]'],
  modelItem: ['[role="option"]'],
  capabilityTrigger: ['.mode-select-open[role="button"]'],
  capabilityMenu: ['.mode-select-dropdown [role="menu"]'],
  capabilityItem: [':scope > [role="menuitem"][data-menu-id]'],
  selectedCapability: ['.mode-select-current-mode'],
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) throw new Error('Expected a JSON object.')
  return parsed
}

type QwenAdapterHarness = Pick<QwenAdapter, keyof QwenAdapter> & {
  page: unknown
  conversationIdVal: string | null
  pendingText: string
  getCapturedFetchEntryCount: () => Promise<number>
  getCapturedFetchEntries: (
    startIndex?: number
  ) => Promise<CapturedFetchEntry[]>
  getSubmitRequestStartGraceMs: () => number
  getSubmitResponseTimeoutMs: () => number | null
  getSubmitResponseStartTimeoutMs: () => number
  getSubmitResponseStallTimeoutMs: () => number
  getHistoryLoadTimeoutMs: () => number
}

function createTestQwenAdapter(cdpSession?: unknown): QwenAdapterHarness {
  const adapter = new QwenAdapter(createBrowserContextStub())
  if (cdpSession !== undefined) {
    Reflect.set(adapter, 'context', {
      newPage: async () => {
        throw new Error('The test injects its page directly.')
      },
      newCDPSession: async () => cdpSession,
    })
  }
  return Object.assign(adapter, {
    page: undefined,
    conversationIdVal: 'chat-1',
    pendingText: '',
    getCapturedFetchEntryCount: async () => 0,
    getCapturedFetchEntries: async () => [],
    getSubmitRequestStartGraceMs: () => 5,
    getSubmitResponseTimeoutMs: () => 2_000,
    getSubmitResponseStartTimeoutMs: () => 500,
    getSubmitResponseStallTimeoutMs: () => 500,
    getHistoryLoadTimeoutMs: () => 500,
  })
}

test('QwenAdapter associates a rewritten request body by its user message id', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({
    ownedRequestContent: 'The browser rewrote the submitted text.',
  })
  adapter.page = page

  await adapter.attachText('Portal request')
  const response = await adapter.submit()

  assert.equal(response, 'Qwen answer')
  assert.equal(adapter.conversationId, 'chat-1')
  assert.equal(adapter.pendingText, '')
  assert.equal(page.listenerCount('request'), 0)
  assert.equal(page.listenerCount('requestfailed'), 0)
  assert.equal(page.listenerCount('response'), 0)
  assert.equal(page.listenerCount('close'), 0)
})

test('QwenAdapter accepts one bodyless post-dispatch request without text matching', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ ownedRequestBody: null })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter prefers an identified request over a bodyless candidate', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.page = createSubmitPage({
    extraRequests: [
      {
        requestBody: null,
        responseText: 'background answer',
        responseParentId: 'background-user',
      },
    ],
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
  assert.equal(emitted.includes('background answer'), false)
})

test('QwenAdapter fails closed for multiple bodyless post-dispatch requests', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.page = createSubmitPage({
    ownedRequestBody: null,
    extraRequests: [
      {
        requestBody: null,
        responseText: 'unsafe answer',
        responseParentId: 'background-user',
      },
    ],
  })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_ownership_ambiguous'
    )
  })
  assert.deepEqual(emitted, [])
})

test('QwenAdapter ignores a pre-dispatch Playwright request', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({
    preDispatchRequest: { userMessageId: 'old-user' },
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter accepts one bodyless captured request without text matching', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getCapturedFetchEntries = async () => [
    createCompletionEntry(1, createResponseBody(), { userMessageId: null }),
  ]
  adapter.page = createSubmitPage({ omitRequest: true })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter ignores a pre-dispatch captured request', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getCapturedFetchEntries = async () => [
    createCompletionEntry(1, createResponseBody({ text: 'old answer' }), {
      userMessageId: 'old-user',
      startedAt: 0,
    }),
  ]
  adapter.page = createSubmitPage()
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter treats repeated same-id requests as one logical submission', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.page = createSubmitPage({
    extraRequests: [
      {
        userMessageId: 'user-1',
        responseText: 'retry answer',
        responseParentId: 'user-1',
      },
    ],
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
  assert.equal(emitted.includes('retry answer'), false)
})

test('QwenAdapter adopts a same-id retry after ownership settles', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({
    requestFailed: true,
    onOwnedRequest: (rawBody) => {
      const retry = createRequest('browser retry', 'user-1', rawBody)
      setTimeout(() => {
        page.emit('request', retry)
        page.emit(
          'response',
          createResponse(retry, true, {
            responseText: 'retry answer',
            responseParentId: 'user-1',
          })
        )
      }, 150)
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'retry answer')
})

test('QwenAdapter lets a same-id retry recover from an HTTP failure', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({
    responseStatus: 503,
    onOwnedRequest: (rawBody) => {
      const retry = createRequest('browser retry', 'user-1', rawBody)
      setTimeout(() => {
        page.emit('request', retry)
        page.emit(
          'response',
          createResponse(retry, true, {
            responseText: 'retry answer',
            responseParentId: 'user-1',
          })
        )
      }, 150)
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'retry answer')
})

test('QwenAdapter accepts a same-id retry after the old fixed grace window', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getSubmitResponseStartTimeoutMs = () => 1_000
  adapter.getSubmitResponseStallTimeoutMs = () => 900
  adapter.stopGeneration = async () => {}
  const page = createSubmitPage({
    requestFailed: true,
    onOwnedRequest: (rawBody) => {
      const retry = createRequest('late browser retry', 'user-1', rawBody)
      setTimeout(() => {
        page.emit('request', retry)
        page.emit(
          'response',
          createResponse(retry, true, {
            responseText: 'late retry answer',
            responseParentId: 'user-1',
          })
        )
      }, 650)
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submitWithResponseTimeout(), 'late retry answer')
})

test('QwenAdapter refreshes the response watchdog when a same-id retry starts', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getSubmitResponseStartTimeoutMs = () => 500
  adapter.getSubmitResponseStallTimeoutMs = () => 180
  adapter.stopGeneration = async () => {}
  const page = createSubmitPage({
    requestFailed: true,
    onOwnedRequest: (rawBody) => {
      const retry = createRequest('browser retry', 'user-1', rawBody)
      setTimeout(() => {
        page.emit('request', retry)
      }, 130)
      setTimeout(() => {
        page.emit(
          'response',
          createResponse(retry, true, {
            responseText: 'retry after old deadline',
            responseParentId: 'user-1',
          })
        )
      }, 220)
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  assert.equal(
    await adapter.submitWithResponseTimeout(),
    'retry after old deadline'
  )
})

test(
  'QwenAdapter lets an owned captured retry outlive the failed live attempt deadline',
  { timeout: 3_000 },
  async () => {
    const adapter = createTestQwenAdapter()
    adapter.getSubmitResponseStartTimeoutMs = () => 500
    adapter.getSubmitResponseStallTimeoutMs = () => 180
    adapter.stopGeneration = async () => {}
    const chunks = [
      ...Array.from({ length: 4 }, () => ': provider keepalive\n\n'),
      ...createStreamingResponseChunks(),
    ]
    const startedAt = Date.now()
    adapter.getCapturedFetchEntries = async () => {
      const elapsed = Date.now() - startedAt
      if (elapsed < 130) return []
      const count = Math.min(
        chunks.length,
        1 + Math.floor((elapsed - 130) / 70)
      )
      return [
        createCompletionEntry(1, chunks.slice(0, count).join(''), {
          chunks: chunks.slice(0, count),
          done: count === chunks.length,
        }),
      ]
    }
    adapter.page = createSubmitPage({ responseStatus: 503 })
    await adapter.attachText('Portal request')

    assert.equal(await adapter.submitWithResponseTimeout(), 'Qwen answer')
  }
)

test(
  'QwenAdapter lets an owned CDP retry outlive the failed live attempt deadline',
  { timeout: 3_000 },
  async () => {
    const chunks = [
      ...Array.from({ length: 4 }, () => ': provider keepalive\n\n'),
      ...createStreamingResponseChunks(),
    ]
    const cdp = Object.assign(new EventEmitter(), {
      send: async (method: string) =>
        method === 'Network.streamResourceContent'
          ? { bufferedData: Buffer.from(chunks[0]!).toString('base64') }
          : {},
      detach: async () => {},
    })
    const adapter = createTestQwenAdapter(cdp)
    adapter.getSubmitResponseStartTimeoutMs = () => 500
    adapter.getSubmitResponseStallTimeoutMs = () => 180
    adapter.stopGeneration = async () => {}
    adapter.page = createSubmitPage({
      responseStatus: 503,
      onOwnedRequest: (rawBody) => {
        setTimeout(() => {
          cdp.emit('Network.requestWillBeSent', {
            requestId: 'cdp-retry',
            request: {
              method: 'POST',
              url: QWEN_COMPLETION_URL,
              postData: rawBody,
            },
          })
          cdp.emit('Network.responseReceived', {
            requestId: 'cdp-retry',
            response: { status: 200 },
          })
          chunks.slice(1).forEach((chunk, index) => {
            setTimeout(
              () => {
                cdp.emit('Network.dataReceived', {
                  requestId: 'cdp-retry',
                  data: Buffer.from(chunk).toString('base64'),
                })
              },
              (index + 1) * 70
            )
          })
        }, 130)
      },
    })
    await adapter.attachText('Portal request')

    assert.equal(await adapter.submitWithResponseTimeout(), 'Qwen answer')
  }
)

test('QwenAdapter fails closed when a different id appears after ownership settles', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  const holdResponse = createDeferred<void>()
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  const page = createSubmitPage({
    responseTextReady: holdResponse.promise,
    onOwnedRequest: () => {
      const other = createRequest('another request', 'different-user')
      setTimeout(() => {
        page.emit('request', other)
        page.emit(
          'response',
          createResponse(other, true, {
            responseText: 'unsafe answer',
            responseParentId: 'different-user',
          })
        )
      }, 150)
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_ownership_ambiguous'
    )
  })
  assert.deepEqual(emitted, [])
})

test(
  'QwenAdapter interrupts a blocked capture scan when ownership becomes ambiguous',
  { timeout: 2_000 },
  async () => {
    const adapter = createTestQwenAdapter()
    const emitted: string[] = []
    const scanStarted = createDeferred<void>()
    const releaseScan = createDeferred<CapturedFetchEntry[]>()
    const safetyController = new AbortController()
    adapter.setSubmitTextReporter((text) => {
      emitted.push(text)
    })
    adapter.getCapturedFetchEntries = async () => {
      scanStarted.resolve()
      return await releaseScan.promise
    }
    const page = createSubmitPage({ omitResponse: true })
    adapter.page = page
    await adapter.attachText('Portal request')
    const pending = adapter.submit({ signal: safetyController.signal })
    await scanStarted.promise
    page.emit('request', createRequest('another request', 'different-user'))
    const safetyTimer = setTimeout(() => safetyController.abort(), 500)

    try {
      await assert.rejects(pending, (error: unknown) => {
        return (
          error instanceof ProviderAdapterError &&
          error.detailCode === 'qwen_response_ownership_ambiguous'
        )
      })
    } finally {
      clearTimeout(safetyTimer)
      releaseScan.resolve([])
    }
    assert.deepEqual(emitted, [])
  }
)

test(
  'QwenAdapter propagates cancellation during a post-response capture scan without emitting text',
  { timeout: 2_000 },
  async () => {
    const adapter = createTestQwenAdapter()
    const emitted: string[] = []
    const scanStarted = createDeferred<void>()
    const releaseScan = createDeferred<CapturedFetchEntry[]>()
    const controller = new AbortController()
    let blockScans = false
    adapter.setSubmitTextReporter((text) => {
      emitted.push(text)
    })
    adapter.getCapturedFetchEntries = async () => {
      if (!blockScans) return []
      scanStarted.resolve()
      return await releaseScan.promise
    }
    adapter.page = createSubmitPage({
      onResponseTextRead: () => {
        blockScans = true
      },
    })
    await adapter.attachText('Portal request')
    const pending = adapter.submit({ signal: controller.signal })
    await scanStarted.promise
    controller.abort()

    try {
      await assert.rejects(pending, (error: unknown) => {
        return error instanceof Error && error.name === 'AbortError'
      })
    } finally {
      releaseScan.resolve([])
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(emitted, [])
  }
)

test('QwenAdapter ignores response-only and failure-only requests without timing proof', async () => {
  for (const terminalEvent of ['response', 'requestfailed'] as const) {
    const adapter = createTestQwenAdapter()
    const oldRequest = createRequest('old request', 'old-user')
    const page = createSubmitPage({
      onOwnedRequest: () => {
        if (terminalEvent === 'response') {
          page.emit(
            'response',
            createResponse(oldRequest, true, {
              responseText: 'old answer',
              responseParentId: 'old-user',
            })
          )
        } else {
          page.emit('requestfailed', oldRequest)
        }
      },
    })
    adapter.page = page
    await adapter.attachText('Portal request')

    assert.equal(await adapter.submit(), 'Qwen answer')
  }
})

test('QwenAdapter reads the current user id from one completion payload', async () => {
  const adapter = createTestQwenAdapter()
  const payload = {
    stream: true,
    chat_id: 'chat-1',
    messages: [
      { id: 'old-user', role: 'user', content: 'old question' },
      { id: 'old-answer', role: 'assistant', content: 'old answer' },
      { id: 'user-1', role: 'user', content: 'browser-rewritten text' },
    ],
    metadata: {
      messages: [{ id: 'unrelated', role: 'user' }],
    },
  }
  adapter.page = createSubmitPage({
    ownedRequestBody: JSON.stringify(payload),
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter rejects conflicting ids instead of combining request fields', async () => {
  for (const invalidPayload of [
    {
      stream: true,
      chat_id: 'chat-1',
      chatId: 'different-chat',
      messages: [{ id: 'user-1', role: 'user', content: 'unsafe' }],
    },
    {
      stream: true,
      chat_id: 'chat-1',
      messages: [{ id: 'user-1', role: 'user', content: 'safe' }],
      nested: {
        stream: true,
        chat_id: 'chat-1',
        messages: [{ id: 'different-user', role: 'user', content: 'unsafe' }],
      },
    },
  ]) {
    const adapter = createTestQwenAdapter()
    const emitted: string[] = []
    adapter.setSubmitTextReporter((text) => {
      emitted.push(text)
    })
    const page = createSubmitPage({
      onOwnedRequest: () => {
        const invalid = createRequest(
          'unsafe',
          'user-1',
          JSON.stringify(invalidPayload)
        )
        page.emit('request', invalid)
        page.emit(
          'response',
          createResponse(invalid, true, {
            responseText: 'unsafe answer',
            responseParentId: 'user-1',
          })
        )
      },
    })
    adapter.page = page
    await adapter.attachText('Portal request')

    assert.equal(await adapter.submit(), 'Qwen answer')
    assert.equal(emitted.includes('unsafe answer'), false)
  }
})

test('QwenAdapter ignores near-match completion routes', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({
    onOwnedRequest: () => {
      for (const [method, url] of [
        ['GET', QWEN_COMPLETION_URL],
        ['POST', `${QWEN_COMPLETION_URL}/prepare`],
        ['POST', 'https://example.com/api/v2/chat/completions'],
      ] as const) {
        const request = {
          ...createRequest('unsafe', 'different-user'),
          method: () => method,
          url: () => url,
        }
        page.emit('request', request)
        page.emit(
          'response',
          createResponse(request, true, {
            responseText: 'unsafe answer',
            responseParentId: 'different-user',
          })
        )
      }
    },
  })
  adapter.page = page
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter accepts a unique readable request without a message id', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ ownedUserMessageId: null })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter treats an unknown request body shape as an unidentified candidate', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({
    ownedRequestBody: 'opaque future Qwen request format',
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter accepts one captured request whose body is unavailable', async () => {
  const adapter = createTestQwenAdapter()
  const entry = createCompletionEntry(1, createResponseBody())
  delete entry.requestBody
  adapter.getCapturedFetchEntries = async () => [entry]
  adapter.page = createSubmitPage({ omitRequest: true })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
})

test('QwenAdapter fails closed when a bodyless live request has an uncorrelated capture', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.getCapturedFetchEntries = async () => [
    createCompletionEntry(
      1,
      createResponseBody({ text: 'uncorrelated capture' }),
      { userMessageId: null }
    ),
  ]
  adapter.page = createSubmitPage({
    ownedRequestBody: null,
    responseTextDelayMs: 250,
  })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_ownership_ambiguous'
    )
  })
  assert.deepEqual(emitted, [])
})

test('QwenAdapter fails closed for a late captured request with another id', async () => {
  const adapter = createTestQwenAdapter()
  const holdResponse = createDeferred<void>()
  let exposeOtherCapture = false
  setTimeout(() => {
    exposeOtherCapture = true
  }, 150)
  adapter.getCapturedFetchEntries = async () =>
    exposeOtherCapture
      ? [
          createCompletionEntry(
            1,
            createResponseBody({
              text: 'unsafe answer',
              parentId: 'different-user',
            }),
            { userMessageId: 'different-user' }
          ),
        ]
      : []
  adapter.page = createSubmitPage({ responseTextReady: holdResponse.promise })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_ownership_ambiguous'
    )
  })
})

test('QwenAdapter rejects an incomplete owned response and removes listeners', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({ finished: false })
  adapter.page = page
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_incomplete'
    )
  })
  assert.equal(page.listenerCount('request'), 0)
  assert.equal(page.listenerCount('response'), 0)
})

test('QwenAdapter aborts a pending response and removes all listeners', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getSubmitResponseTimeoutMs = () => null
  const page = createSubmitPage({ omitResponse: true })
  adapter.page = page
  await adapter.attachText('Portal request')
  const controller = new AbortController()
  const pending = adapter.submit({ signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.name === 'AbortError'
  })
  assert.equal(page.listenerCount('request'), 0)
  assert.equal(page.listenerCount('requestfailed'), 0)
  assert.equal(page.listenerCount('response'), 0)
  assert.equal(page.listenerCount('close'), 0)
})

test('QwenAdapter gives signed-out state priority before submitting', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage({ loggedIn: false })
  adapter.page = page
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.kind === 'auth' &&
      error.detailCode === 'qwen_signed_out'
    )
  })
  assert.equal(page.listenerCount('request'), 0)
})

test('QwenAdapter detects auth loss while waiting for an owned request', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({
    omitRequest: true,
    authStates: [true, true, false],
  })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.kind === 'auth' &&
      error.detailCode === 'qwen_signed_out'
    )
  })
})

test('QwenAdapter propagates abort while checking login status', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = {
    url: () => 'https://chat.qwen.ai/',
    evaluate: async () => await new Promise(() => {}),
  }
  const controller = new AbortController()
  const pending = adapter.isLoggedIn({ signal: controller.signal })
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.name === 'AbortError'
  })
})

test('QwenAdapter never retries an owned request with an unknown outcome', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ requestFailed: true })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.kind === 'unknown' &&
      error.retryable === false &&
      error.detailCode === 'qwen_submit_outcome_unknown'
    )
  })
})

test('QwenAdapter rejects an owned HTTP 5xx as an unknown outcome', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ responseStatus: 503 })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.kind === 'unknown' &&
      error.retryable === false &&
      error.detailCode === 'qwen_submit_outcome_unknown'
    )
  })
})

test('QwenAdapter ignores stale same-chat stream text from another user message', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.getCapturedFetchEntries = async () => [
    createCompletionEntry(
      1,
      createResponseBody({
        text: 'STALE STREAM',
        parentId: 'different-user',
        responseId: 'stale-response',
      }),
      { userMessageId: 'different-user', startedAt: 0 }
    ),
    createCompletionEntry(2, createResponseBody()),
  ]
  adapter.page = createSubmitPage({ responseTextDelayMs: 80 })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
  assert.equal(emitted.includes('STALE STREAM'), false)
  assert.equal(emitted.at(-1), 'Qwen answer')
})

test('QwenAdapter streams the unique owned capture and keeps an active long response alive', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getSubmitResponseStartTimeoutMs = () => 90
  adapter.getSubmitResponseStallTimeoutMs = () => 500
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  const chunks = createStreamingResponseChunks()
  let reads = 0
  adapter.getCapturedFetchEntries = async () => {
    reads += 1
    const visibleChunks = chunks.slice(0, Math.min(reads, chunks.length))
    return [
      createCompletionEntry(1, visibleChunks.join(''), {
        chunks: visibleChunks,
        done: visibleChunks.length === chunks.length,
      }),
    ]
  }
  adapter.page = createSubmitPage({ responseTextDelayMs: 260 })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submitWithResponseTimeout(), 'Qwen answer')
  assert.equal(emitted.at(-1), 'Qwen answer')
  assert.equal(
    emitted.some((text) => text.includes('PRIVATE THINKING')),
    false
  )
})

test('QwenAdapter binds CDP bytes by user id and ignores a pre-dispatch CDP request', async () => {
  const partialTextObserved = createDeferred<void>()
  const finalTextObserved = createDeferred<void>()
  const cdp = Object.assign(new EventEmitter(), {
    detached: false,
    send: async (method: string) => {
      if (method === 'Network.enable') {
        cdp.emit('Network.requestWillBeSent', {
          requestId: 'cdp-pre-dispatch',
          request: {
            method: 'POST',
            url: QWEN_COMPLETION_URL,
            postData: JSON.stringify(
              createCompletionRequestPayload('old request', 'old-user')
            ),
          },
        })
        return {}
      }
      if (method === 'Network.streamResourceContent') {
        const chunks = createStreamingResponseChunks()
        setImmediate(() => {
          for (const chunk of chunks.slice(0, 3)) {
            cdp.emit('Network.dataReceived', {
              requestId: 'cdp-owned',
              data: Buffer.from(chunk).toString('base64'),
            })
          }
          void partialTextObserved.promise.then(() => {
            for (const chunk of chunks.slice(3)) {
              cdp.emit('Network.dataReceived', {
                requestId: 'cdp-owned',
                data: Buffer.from(chunk).toString('base64'),
              })
            }
          })
        })
        return {
          bufferedData: Buffer.from(': provider keepalive\n\n').toString(
            'base64'
          ),
        }
      }
      return {}
    },
    detach: async () => {
      cdp.detached = true
    },
  })
  const adapter = createTestQwenAdapter(cdp)
  adapter.getSubmitResponseStartTimeoutMs = () => 90
  adapter.getSubmitResponseStallTimeoutMs = () => 250
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
    if (text === 'Qwen ') partialTextObserved.resolve()
    if (text === 'Qwen answer') finalTextObserved.resolve()
  })
  adapter.page = createSubmitPage({
    responseTextReady: finalTextObserved.promise,
    onOwnedRequest: (rawBody) => {
      const rewritten = parseJsonRecord(rawBody)
      const messages = rewritten.messages
      if (!Array.isArray(messages) || !isRecord(messages[0])) {
        throw new Error('Expected a Qwen user message.')
      }
      messages[0].content = 'browser-rewritten text'
      cdp.emit('Network.requestWillBeSent', {
        requestId: 'cdp-owned',
        request: {
          method: 'POST',
          url: QWEN_COMPLETION_URL,
          postData: JSON.stringify(rewritten),
        },
      })
      cdp.emit('Network.responseReceived', { requestId: 'cdp-owned' })
    },
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submitWithResponseTimeout(), 'Qwen answer')
  assert.ok(emitted.includes('Qwen '))
  assert.equal(emitted.at(-1), 'Qwen answer')
  assert.equal(
    emitted.some((text) => text.includes('PRIVATE THINKING')),
    false
  )
  assert.equal(cdp.detached, true)
})

test('QwenAdapter orders buffered CDP bytes before data received during stream setup', async () => {
  const streamed = Buffer.from(
    createResponseBody({ text: '汉', responseId: 'cdp-response' })
  )
  const characterStart = streamed.indexOf(Buffer.from('汉'))
  assert.ok(characterStart >= 0)
  const splitAt = characterStart + 1
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string) => {
      if (method !== 'Network.streamResourceContent') return {}
      cdp.emit('Network.dataReceived', {
        requestId: 'cdp-owned',
        data: streamed.subarray(splitAt).toString('base64'),
      })
      return {
        bufferedData: streamed.subarray(0, splitAt).toString('base64'),
      }
    },
    detach: async () => {},
  })
  const adapter = createTestQwenAdapter(cdp)
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.page = createSubmitPage({
    responseTextDelayMs: 80,
    onOwnedRequest: (rawBody) => {
      cdp.emit('Network.requestWillBeSent', {
        requestId: 'cdp-owned',
        request: {
          method: 'POST',
          url: QWEN_COMPLETION_URL,
          postData: rawBody,
        },
      })
      cdp.emit('Network.responseReceived', { requestId: 'cdp-owned' })
    },
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), '汉')
  assert.ok(emitted.includes('汉'))
  assert.equal(emitted.at(-1), '汉')
})

test('QwenAdapter streams a same-id CDP retry without treating mirrors as ambiguous', async () => {
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, params?: { requestId?: string }) =>
      method === 'Network.streamResourceContent'
        ? {
            bufferedData: Buffer.from(
              params?.requestId === 'cdp-first'
                ? createResponseBody({
                    text: 'invalid first answer',
                    parentId: 'different-user',
                  })
                : createResponseBody({ text: 'CDP retry answer' })
            ).toString('base64'),
          }
        : {},
    detach: async () => {},
  })
  const adapter = createTestQwenAdapter(cdp)
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.page = createSubmitPage({
    responseTextDelayMs: 250,
    onOwnedRequest: (rawBody) => {
      for (const requestId of ['cdp-first', 'cdp-second']) {
        cdp.emit('Network.requestWillBeSent', {
          requestId,
          request: {
            method: 'POST',
            url: QWEN_COMPLETION_URL,
            postData: rawBody,
          },
        })
      }
      for (const requestId of ['cdp-first', 'cdp-second']) {
        cdp.emit('Network.responseReceived', {
          requestId,
          response: { status: 200 },
        })
      }
    },
  })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'CDP retry answer')
  assert.equal(emitted.at(-1), 'CDP retry answer')
})

test('QwenAdapter aborts while creating its CDP stream session', async () => {
  const adapter = createTestQwenAdapter(new Promise(() => {}))
  const page = createSubmitPage()
  adapter.page = page
  await adapter.attachText('Portal request')
  const controller = new AbortController()
  const pending = adapter.submit({ signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.name === 'AbortError'
  })
  assert.equal(page.listenerCount('request'), 0)
})

test('QwenAdapter does not let a stale capture refresh the response watchdog', async () => {
  const adapter = createTestQwenAdapter()
  adapter.getSubmitResponseStartTimeoutMs = () => 70
  adapter.getSubmitResponseStallTimeoutMs = () => 70
  adapter.stopGeneration = async () => {}
  let reads = 0
  adapter.getCapturedFetchEntries = async () => {
    reads += 1
    return [
      createCompletionEntry(1, createResponseBody({ parentId: 'stale-user' }), {
        userMessageId: 'stale-user',
        chunks: Array.from({ length: reads }, () => ': keepalive\n\n'),
        done: false,
      }),
    ]
  }
  adapter.page = createSubmitPage({ responseTextDelayMs: 220 })
  await adapter.attachText('Portal request')

  await assert.rejects(
    adapter.submitWithResponseTimeout(),
    (error: unknown) =>
      error instanceof ProviderResponseTimeoutError &&
      error.message.includes('had no activity')
  )
})

test('QwenAdapter treats multiple same-id captures as response mirrors', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  adapter.getCapturedFetchEntries = async () => [
    createCompletionEntry(1, createResponseBody({ finished: false })),
    createCompletionEntry(2, createResponseBody()),
  ]
  adapter.page = createSubmitPage({ responseTextDelayMs: 80 })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
  assert.equal(emitted.at(-1), 'Qwen answer')
})

test('QwenAdapter rejects a stream with conflicting parent identities', async () => {
  const adapter = createTestQwenAdapter()
  const rawResponseBody = [
    createResponseBody({ parentId: 'stale-user', finished: false }),
    createResponseBody({ parentId: 'user-1' }),
  ].join('\n')
  adapter.page = createSubmitPage({ rawResponseBody })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_identity_mismatch'
    )
  })
})

test('QwenAdapter rejects an exact final response without a parent identity', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ responseParentId: null })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_identity_mismatch'
    )
  })
})

test('QwenAdapter rejects another parent when the request exposes a string message id', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createSubmitPage({ responseParentId: 'different-user' })
  await adapter.attachText('Portal request')

  await assert.rejects(adapter.submit(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_response_identity_mismatch'
    )
  })
})

test('QwenAdapter suppresses an in-flight polling result after abort cleanup', async () => {
  const adapter = createTestQwenAdapter()
  const emitted: string[] = []
  adapter.setSubmitTextReporter((text) => {
    emitted.push(text)
  })
  let captureStarted = false
  let resolveEntries: (entries: CapturedFetchEntry[]) => void = () => {
    throw new Error('Capture polling did not start.')
  }
  adapter.getCapturedFetchEntries = async () =>
    await new Promise<CapturedFetchEntry[]>((resolve) => {
      captureStarted = true
      resolveEntries = resolve
    })
  adapter.page = createSubmitPage({ omitResponse: true })
  await adapter.attachText('Portal request')
  const controller = new AbortController()
  const pending = adapter.submit({ signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()

  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.name === 'AbortError'
  })
  assert.equal(captureStarted, true)
  resolveEntries([createCompletionEntry(1, createResponseBody())])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(emitted, [])
})

test('QwenAdapter classifies strict login status responses', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createAuthPage({ status: 200, data: true })
  assert.equal(await adapter.isLoggedIn(), true)

  adapter.page = createAuthPage({ status: 200, data: false })
  assert.equal(await adapter.isLoggedIn(), false)

  adapter.page = createAuthPage({ status: 200, data: 'true' })
  await assert.rejects(adapter.isLoggedIn(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_auth_state_invalid'
    )
  })

  adapter.page = createAuthPage({ status: 503, data: false })
  await assert.rejects(adapter.isLoggedIn(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.kind === 'transient' &&
      error.detailCode === 'qwen_auth_http_error'
    )
  })
})

test('QwenAdapter loads only the exact current conversation history response', async () => {
  const adapter = createTestQwenAdapter()
  const raw = createHistoryResponse()
  Object.assign(adapter, {
    getCapturedHistoryEntries: async (
      predicate: (entry: CapturedFetchEntry) => boolean
    ) => {
      const valid = createCapturedEntry(
        'https://chat.qwen.ai/api/v2/chats/chat-1',
        raw
      )
      assert.equal(predicate(valid), true)
      assert.equal(
        predicate(
          createCapturedEntry('https://chat.qwen.ai/api/v2/chats/chat-10', raw)
        ),
        false
      )
      assert.equal(
        predicate(
          createCapturedEntry('https://example.com/api/v2/chats/chat-1', raw)
        ),
        false
      )
      return [
        valid,
        {
          ...valid,
          id: 2,
          status: null,
          chunks: [],
          done: false,
        },
      ]
    },
  })

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.deepEqual(
    result.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'Answer' },
    ]
  )
})

test('QwenAdapter falls back to an exact same-origin history request', async () => {
  const adapter = createTestQwenAdapter()
  const raw = createHistoryResponse()
  Object.assign(adapter, {
    getCapturedHistoryEntries: async () => [],
  })
  adapter.page = {
    evaluate: async (_fn: unknown, pathname: unknown) => {
      assert.equal(pathname, '/api/v2/chats/chat-1')
      return { status: 200, body: raw }
    },
  }

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.equal(result.messages.length, 2)
})

test('QwenAdapter bounds direct history fallback and reports HTTP errors', async () => {
  const adapter = createTestQwenAdapter()
  Object.assign(adapter, {
    getCapturedHistoryEntries: async () => [],
  })
  adapter.page = {
    evaluate: async () => ({ status: 503, body: '' }),
  }
  assert.match((await adapter.loadHistory()).warning ?? '', /HTTP 503/)

  adapter.getHistoryLoadTimeoutMs = () => 5
  adapter.page = {
    evaluate: async () => await new Promise(() => {}),
  }
  assert.match((await adapter.loadHistory()).warning ?? '', /timed out/)
})

test('QwenAdapter changes declared models by their UI order', async () => {
  const adapter = createTestQwenAdapter()
  const selected: number[] = []
  adapter.page = createControlPage({ selected })

  await adapter.changeModel({ key: 'qwen3.8-max-preview', option: null })
  assert.deepEqual(selected, [1])
  await assert.rejects(
    adapter.changeModel({ key: 'unknown', option: null }),
    ProviderAdapterUnsupportedError
  )
  await assert.rejects(
    adapter.changeModel({ key: 'qwen3.7-max', option: null }),
    ProviderAdapterUnsupportedError
  )
})

test('QwenAdapter changes models through visible options without a listbox', async () => {
  const adapter = createTestQwenAdapter()
  const selected: number[] = []
  adapter.page = createControlPage({ selected, globalModelOptions: true })

  await adapter.changeModel({ key: 'qwen3.8-max-preview', option: null })

  assert.deepEqual(selected, [1])
})

test('QwenAdapter rejects unscoped model options from multiple groups', async () => {
  const adapter = createTestQwenAdapter()
  adapter.page = createControlPage({
    globalModelOptions: true,
    visibleListboxCount: 1,
    globalModelParentCount: 2,
  })

  await assert.rejects(
    adapter.changeModel({ key: 'qwen3.7-plus', option: null }),
    /options were ambiguous/
  )
})

test('QwenAdapter uploads through the unique file input and stops generation', async () => {
  const adapter = createTestQwenAdapter()
  const uploaded: Array<string | readonly string[]> = []
  let stopClicks = 0
  adapter.page = createControlPage({
    uploaded,
    onStop: () => {
      stopClicks += 1
    },
  })

  await adapter.attachFile(['one.txt', 'two.png'])
  await adapter.attachImage('image.png')
  await adapter.stopGeneration()

  assert.deepEqual(uploaded, [['one.txt', 'two.png'], 'image.png'])
  assert.equal(stopClicks, 1)
})

test('QwenAdapter lists discovered action capabilities and closes the menu', async () => {
  const adapter = createTestQwenAdapter()
  const page = createCapabilityPage({
    hidden: ['travel'],
    disabled: ['t2v'],
  })
  adapter.page = page

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'deep_research', state: 'available' },
    { name: 'image_generation', state: 'available' },
    { name: 'video_generation', state: 'disabled' },
    { name: 'web_dev', state: 'available' },
    { name: 'slides', state: 'available' },
    { name: 'search', state: 'available' },
    { name: 'artifacts', state: 'available' },
    { name: 'learn', state: 'available' },
  ])
  assert.equal(page.menuOpen(), false)
})

test('QwenAdapter selects and clears an action capability', async () => {
  const adapter = createTestQwenAdapter()
  const page = createCapabilityPage({ disabled: ['t2v'] })
  adapter.page = page

  assert.equal(await adapter.selectActionCapability('search'), 'selected')
  assert.equal(page.selectedCapability(), 'search')
  assert.equal(
    (await adapter.listActionCapabilities()).find(
      (capability) => capability.name === 'search'
    )?.state,
    'selected'
  )
  await adapter.clearActionCapability()
  assert.equal(page.selectedCapability(), null)
  assert.equal(
    await adapter.selectActionCapability('video_generation'),
    'disabled'
  )
})

test('QwenAdapter preserves the selected action for unavailable targets', async () => {
  const adapter = createTestQwenAdapter()
  const page = createCapabilityPage({
    selected: 'deep_research',
    hidden: ['travel'],
    disabled: ['t2v'],
  })
  adapter.page = page

  assert.equal(
    await adapter.selectActionCapability('video_generation'),
    'disabled'
  )
  assert.equal(page.selectedCapability(), 'deep_research')
  assert.equal(await adapter.selectActionCapability('travel'), 'unavailable')
  assert.equal(page.selectedCapability(), 'deep_research')
})

test('QwenAdapter rejects ambiguous capability and selected-mode identities', async () => {
  const adapter = createTestQwenAdapter()
  const duplicatePage = createCapabilityPage({ duplicates: ['search'] })
  adapter.page = duplicatePage

  await assert.rejects(adapter.listActionCapabilities(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_capability_item_duplicated'
    )
  })
  assert.equal(duplicatePage.menuOpen(), false)

  const selectedPage = createCapabilityPage({
    selected: 'search',
    ambiguousSelected: true,
  })
  adapter.page = selectedPage
  await assert.rejects(adapter.clearActionCapability(), (error: unknown) => {
    return (
      error instanceof ProviderAdapterError &&
      error.detailCode === 'qwen_selected_capability_ambiguous'
    )
  })
})

interface CapabilityTestLocator {
  count(): Promise<number>
  first(): CapabilityTestLocator
  nth(index: number): CapabilityTestLocator
  filter(options?: { visible?: boolean }): CapabilityTestLocator
  locator(selector: string): CapabilityTestLocator
  isVisible(): Promise<boolean>
  isEnabled(): Promise<boolean>
  getAttribute(name: string): Promise<string | null>
  click(options?: { force?: boolean }): Promise<void>
  hover(options?: { force?: boolean }): Promise<void>
  dispatchEvent(name: string): Promise<void>
}

function createCapabilityPage(
  options: {
    selected?: string | null
    hidden?: string[]
    disabled?: string[]
    duplicates?: string[]
    ambiguousSelected?: boolean
  } = {}
) {
  const emitter = new EventEmitter()
  const hidden = new Set(options.hidden ?? [])
  const disabled = new Set(options.disabled ?? [])
  const duplicates = new Set(options.duplicates ?? [])
  const directCapabilities = new Set([
    'deep_research',
    't2i',
    't2v',
    'web_dev',
    'slides',
  ])
  let isMenuOpen = false
  let isSubmenuOpen = false
  let isCloseVisible = false
  let selected = options.selected ?? null

  const readCapability = (selector: string): string | undefined =>
    selector.match(/data-menu-id\$="-([^"]+)"/)?.[1]

  const makeIconLocator = (reference: string): CapabilityTestLocator => {
    const icon: CapabilityTestLocator = {
      count: async () => 1,
      first: () => icon,
      nth: () => icon,
      filter: () => icon,
      locator: () => icon,
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async (name: string) =>
        name === 'xlink:href' ? reference : null,
      click: async () => {},
      hover: async () => {},
      dispatchEvent: async () => {},
    }
    return icon
  }

  const makeLocator = (
    kind: string,
    capability?: string
  ): CapabilityTestLocator => {
    const locator: CapabilityTestLocator = {
      count: async () => {
        if (kind === 'trigger') return 1
        if (kind === 'rootMenu' || kind === 'submenu') {
          return isMenuOpen ? 1 : 0
        }
        if (kind === 'nestedMenu') return isSubmenuOpen ? 1 : 0
        if (kind === 'nestedItems') {
          return isSubmenuOpen
            ? ['search', 'artifacts', 'learn', 'travel'].filter(
                (name) => !hidden.has(name)
              ).length
            : 0
        }
        if (kind === 'directAction') {
          const present =
            isMenuOpen &&
            capability !== undefined &&
            directCapabilities.has(capability) &&
            !hidden.has(capability)
          return present ? (duplicates.has(capability) ? 2 : 1) : 0
        }
        if (kind === 'nestedAction') {
          const present =
            isSubmenuOpen &&
            capability !== undefined &&
            !directCapabilities.has(capability) &&
            !hidden.has(capability)
          return present ? (duplicates.has(capability) ? 2 : 1) : 0
        }
        if (kind === 'selected') {
          if (selected === null) return 0
          return options.ambiguousSelected === true ? 2 : 1
        }
        if (kind === 'selectedClose') {
          return selected !== null && isCloseVisible ? 1 : 0
        }
        return 0
      },
      first: () => locator,
      nth: () => locator,
      filter: () => locator,
      locator: (selector: string) => {
        if (kind === 'rootMenu') {
          if (selector.includes('aria-haspopup')) return makeLocator('submenu')
          return makeLocator('directAction', readCapability(selector))
        }
        if (kind === 'nestedMenu') {
          if (
            selector.endsWith(
              joinCssLocatorCandidates(QWEN_LOCATORS.capabilityItem).replace(
                ':scope > ',
                ''
              )
            )
          ) {
            return makeLocator('nestedItems')
          }
          return makeLocator('nestedAction', readCapability(selector))
        }
        if (kind === 'selected' && selector.includes('close')) {
          return makeLocator('selectedClose')
        }
        return makeIconLocator(`#icon-${capability ?? selected ?? 'unknown'}`)
      },
      isVisible: async () => {
        if (kind === 'trigger') return true
        return (await locator.count()) === 1
      },
      isEnabled: async () => true,
      getAttribute: async (name: string) => {
        if (kind === 'submenu' && name === 'aria-controls') {
          return 'qwen-capability-popup'
        }
        if (
          (kind === 'directAction' || kind === 'nestedAction') &&
          name === 'aria-disabled'
        ) {
          return capability !== undefined && disabled.has(capability)
            ? 'true'
            : 'false'
        }
        return null
      },
      click: async () => {
        if (kind === 'trigger') {
          isMenuOpen = true
          isSubmenuOpen = false
        } else if (
          (kind === 'directAction' || kind === 'nestedAction') &&
          capability !== undefined
        ) {
          if (!disabled.has(capability)) {
            selected = capability
            isCloseVisible = false
            isMenuOpen = false
            isSubmenuOpen = false
          }
        } else if (kind === 'selectedClose') {
          selected = null
          isCloseVisible = false
        }
      },
      hover: async () => {
        if (kind === 'submenu') isSubmenuOpen = true
        if (kind === 'selected') isCloseVisible = true
      },
      dispatchEvent: async () => {
        if (kind === 'submenu') isSubmenuOpen = true
      },
    }
    return locator
  }

  const page = Object.assign(emitter, {
    locator: (selector: string) => {
      if (selector === joinCssLocatorCandidates(QWEN_LOCATORS.capabilityMenu)) {
        return makeLocator('rootMenu')
      }
      if (selector === '[id="qwen-capability-popup"]') {
        return makeLocator('nestedMenu')
      }
      if (
        selector === joinCssLocatorCandidates(QWEN_LOCATORS.capabilityTrigger)
      ) {
        return makeLocator('trigger')
      }
      if (
        selector === joinCssLocatorCandidates(QWEN_LOCATORS.selectedCapability)
      ) {
        return makeLocator('selected')
      }
      return makeLocator('missing')
    },
    keyboard: {
      press: async () => {
        isMenuOpen = false
        isSubmenuOpen = false
      },
    },
    menuOpen: () => isMenuOpen,
    selectedCapability: () => selected,
  })
  return page
}

interface SubmitPageOptions {
  finished?: boolean
  omitResponse?: boolean
  omitRequest?: boolean
  requestFailed?: boolean
  responseStatus?: number
  responseTextDelayMs?: number
  responseTextReady?: Promise<void>
  responseText?: string
  rawResponseBody?: string
  responseParentId?: string | null
  loggedIn?: boolean
  authStates?: boolean[]
  includeStaleRequest?: boolean
  ownedRequestContent?: string
  ownedUserMessageId?: string | null
  ownedRequestBody?: string | null
  extraRequests?: Array<{
    content?: string
    userMessageId?: string | null
    requestBody?: string | null
    responseText?: string
    responseParentId?: string | null
  }>
  preDispatchRequest?: {
    content?: string
    userMessageId?: string | null
    requestBody?: string | null
  }
  onOwnedRequest?: (rawBody: string) => void
  onResponseTextRead?: () => void
}

function createSubmitPage(options: SubmitPageOptions = {}) {
  const emitter = new EventEmitter()
  let composerValue = ''
  let authIndex = 0
  let preDispatchRequestEmitted = false
  const composer = {
    count: async () => 1,
    first: () => composer,
    nth: () => composer,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {},
    inputValue: async () => composerValue,
  }
  const sendButton = {
    count: async () => 1,
    first: () => sendButton,
    nth: () => sendButton,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      if (options.omitRequest === true) return
      if (options.includeStaleRequest === true) {
        const stale = createRequest('different request', 'stale-user')
        emitter.emit('request', stale)
        emitter.emit('response', createResponse(stale, true, options))
      }

      const ownedUserMessageId = Object.hasOwn(options, 'ownedUserMessageId')
        ? options.ownedUserMessageId!
        : 'user-1'
      const owned = createRequest(
        options.ownedRequestContent ?? composerValue,
        ownedUserMessageId,
        options.ownedRequestBody
      )
      composerValue = ''
      options.onOwnedRequest?.(owned.postData() ?? '')
      emitter.emit('request', owned)
      if (options.requestFailed === true) {
        emitter.emit('requestfailed', owned)
        return
      }
      if (options.omitResponse !== true) {
        emitter.emit(
          'response',
          createResponse(owned, options.finished !== false, options)
        )
      }
      for (const extra of options.extraRequests ?? []) {
        const request = createRequest(
          extra.content ?? 'background request',
          extra.userMessageId ?? 'background-user',
          extra.requestBody
        )
        emitter.emit('request', request)
        emitter.emit(
          'response',
          createResponse(request, true, {
            ...options,
            responseParentId:
              extra.responseParentId ??
              extra.userMessageId ??
              'background-user',
            ...(extra.responseText === undefined
              ? {}
              : { responseText: extra.responseText }),
          })
        )
      }
    },
  }
  return Object.assign(emitter, {
    on(event: string | symbol, listener: (...args: unknown[]) => void) {
      EventEmitter.prototype.on.call(emitter, event, listener)
      if (
        event === 'request' &&
        options.preDispatchRequest !== undefined &&
        !preDispatchRequestEmitted
      ) {
        preDispatchRequestEmitted = true
        const preDispatch = createRequest(
          options.preDispatchRequest.content ?? 'old request',
          options.preDispatchRequest.userMessageId ?? 'old-user',
          options.preDispatchRequest.requestBody
        )
        emitter.emit('request', preDispatch)
        emitter.emit('response', createResponse(preDispatch, true, options))
      }
      return emitter
    },
    url: () => 'https://chat.qwen.ai/c/chat-1',
    locator: (selector: string) =>
      selector === '.message-input-textarea' ? composer : sendButton,
    evaluate: async () => {
      const states = options.authStates
      const state =
        states === undefined
          ? (options.loggedIn ?? true)
          : states[Math.min(authIndex, states.length - 1)]
      authIndex += 1
      return { status: 200, data: state }
    },
    keyboard: {
      insertText: async (text: string) => {
        composerValue += text
      },
      press: async () => {},
    },
  })
}

function createRequest(
  content: string,
  userMessageId: string | null = 'user-1',
  requestBodyOverride?: string | null
) {
  const payload = createCompletionRequestPayload(content, userMessageId)
  const raw = requestBodyOverride ?? JSON.stringify(payload)
  return {
    method: () => 'POST',
    url: () => QWEN_COMPLETION_URL,
    postData: () => (requestBodyOverride === null ? null : raw),
    postDataJSON: () => {
      if (requestBodyOverride === null) throw new Error('body unavailable')
      const parsed: unknown = JSON.parse(raw)
      return parsed
    },
    failure: () => ({ errorText: 'connection reset' }),
  }
}

function createResponse(
  request: ReturnType<typeof createRequest>,
  finished: boolean,
  options: SubmitPageOptions
) {
  const raw =
    options.rawResponseBody ??
    createResponseBody({
      finished,
      ...(options.responseText === undefined
        ? {}
        : { text: options.responseText }),
      ...(!Object.hasOwn(options, 'responseParentId')
        ? {}
        : { parentId: options.responseParentId }),
    })
  return {
    request: () => request,
    status: () => options.responseStatus ?? 200,
    text: async () => {
      if (options.responseTextReady !== undefined) {
        await options.responseTextReady
      } else if (options.responseTextDelayMs !== undefined) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.responseTextDelayMs)
        )
      }
      options.onResponseTextRead?.()
      return raw
    },
  }
}

function createResponseBody({
  text = 'Qwen answer',
  parentId = 'user-1',
  responseId = 'response-1',
  finished = true,
}: {
  text?: string
  parentId?: string | null
  responseId?: string
  finished?: boolean
} = {}): string {
  return [
    `data: ${JSON.stringify({
      'response.created': {
        chat_id: 'chat-1',
        response_id: responseId,
        ...(parentId === null ? {} : { parent_id: parentId }),
      },
    })}`,
    '',
    `data: {"choices":[{"delta":{"content":"${text}","phase":"answer","status":"typing"}}],"response_id":"${responseId}"}`,
    '',
    `data: {"choices":[{"delta":{"content":"","phase":"answer","status":"${finished ? 'finished' : 'typing'}"}}],"response_id":"${responseId}"}`,
    '',
  ].join('\n')
}

function createAuthPage(result: { status: number; data: unknown }) {
  return {
    url: () => 'https://chat.qwen.ai/',
    evaluate: async () => result,
  }
}

function createControlPage({
  selected = [],
  uploaded = [],
  onStop = () => {},
  globalModelOptions = false,
  visibleListboxCount,
  globalModelParentCount = 1,
}: {
  selected?: number[]
  uploaded?: Array<string | readonly string[]>
  onStop?: () => void
  globalModelOptions?: boolean
  visibleListboxCount?: number
  globalModelParentCount?: number
}) {
  const emitter = new EventEmitter()
  let listboxVisible = false
  let uploadMenuVisible = false
  let uploadCount = 0
  const options = {
    count: async () => 2,
    evaluateAll: async () => globalModelParentCount === 1,
    nth: (index: number) => ({
      click: async () => {
        selected.push(index)
      },
    }),
  }
  const listbox = {
    count: async () => visibleListboxCount ?? (globalModelOptions ? 0 : 1),
    first: () => listbox,
    nth: () => listbox,
    isVisible: async () => listboxVisible,
    locator: () => (globalModelOptions ? { count: async () => 0 } : options),
  }
  const trigger = {
    count: async () => 1,
    first: () => trigger,
    nth: () => trigger,
    isVisible: async () => true,
    click: async () => {
      listboxVisible = true
    },
  }
  const uploadTrigger = {
    count: async () => 1,
    first: () => uploadTrigger,
    nth: () => uploadTrigger,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      uploadMenuVisible = true
    },
  }
  const uploadItem = {
    count: async () => 1,
    first: () => uploadItem,
    nth: () => uploadItem,
    isVisible: async () => uploadMenuVisible,
    click: async () => {},
  }
  const fileCards = {
    count: async () => uploadCount,
  }
  const stop = {
    count: async () => 1,
    first: () => stop,
    nth: () => stop,
    isVisible: async () => true,
    click: async () => onStop(),
  }
  return Object.assign(emitter, {
    locator: (selector: string) => {
      if (selector === joinCssLocatorCandidates(QWEN_LOCATORS.modelTrigger)) {
        return trigger
      }
      if (selector === joinCssLocatorCandidates(QWEN_LOCATORS.modelListbox)) {
        return listbox
      }
      if (
        selector ===
        joinCssLocatorCandidates(QWEN_LOCATORS.modelListbox, ':visible')
      ) {
        return listbox
      }
      if (
        selector ===
        joinCssLocatorCandidates(QWEN_LOCATORS.modelItem, ':visible')
      ) {
        return options
      }
      if (
        selector === joinCssLocatorCandidates(QWEN_LOCATORS.capabilityTrigger)
      ) {
        return uploadTrigger
      }
      if (selector.includes('data-menu-id')) return uploadItem
      if (selector.includes('file-card-list')) return fileCards
      return stop
    },
    waitForEvent: async () => ({
      setFiles: async (paths: string | readonly string[]) => {
        uploaded.push(paths)
        uploadCount += typeof paths === 'string' ? 1 : paths.length
        emitter.emit('response', {
          url: () => 'https://chat.qwen.ai/api/v2/files/parse/status',
          request: () => ({ method: () => 'POST' }),
          json: async () => ({ data: [{ status: 'success' }] }),
        })
      },
    }),
    keyboard: { press: async () => {} },
  })
}

function createCapturedEntry(url: string, body: string): CapturedFetchEntry {
  return {
    id: 1,
    url,
    method: 'GET',
    status: 200,
    chunks: [body],
    done: true,
    error: null,
  }
}

function createCompletionEntry(
  id: number,
  body: string,
  options: {
    userMessageId?: string | null
    userText?: string
    chunks?: string[]
    done?: boolean
    startedAt?: number
  } = {}
): CapturedFetchEntry {
  return {
    id,
    url: QWEN_COMPLETION_URL,
    method: 'POST',
    startedAt: options.startedAt ?? Number.MAX_SAFE_INTEGER,
    requestBody: JSON.stringify(
      createCompletionRequestPayload(
        options.userText ?? 'Portal request',
        Object.hasOwn(options, 'userMessageId')
          ? options.userMessageId
          : 'user-1'
      )
    ),
    status: 200,
    chunks: options.chunks ?? [body],
    done: options.done ?? true,
    error: null,
  }
}

function createCompletionRequestPayload(
  content: string,
  userMessageId: string | null = 'user-1'
) {
  return {
    stream: true,
    chat_id: 'chat-1',
    messages: [
      {
        ...(userMessageId === null ? {} : { id: userMessageId }),
        role: 'user',
        content,
      },
    ],
  }
}

function createStreamingResponseChunks(): string[] {
  return [
    'data: {"response.created":{"chat_id":"chat-1","response_id":"response-1","parent_id":"user-1"}}\n\n',
    'data: {"choices":[{"delta":{"content":"PRIVATE THINKING","phase":"thinking_summary","status":"typing"}}],"response_id":"response-1"}\n\n',
    'data: {"choices":[{"delta":{"content":"Qwen ","phase":"answer","status":"typing"}}],"response_id":"response-1"}\n\n',
    'data: {"choices":[{"delta":{"content":"answer","phase":"answer","status":"typing"}}],"response_id":"response-1"}\n\n',
    'data: {"choices":[{"delta":{"content":"","phase":"answer","status":"finished"}}],"response_id":"response-1"}\n\n',
  ]
}

function createHistoryResponse(): string {
  return JSON.stringify({
    data: {
      chat: {
        history: {
          messages: {
            user: {
              id: 'user',
              role: 'user',
              content: 'Question',
              parentId: null,
              childrenIds: ['assistant'],
              error: null,
            },
            assistant: {
              id: 'assistant',
              role: 'assistant',
              parentId: 'user',
              childrenIds: [],
              done: true,
              error: null,
              content_list: [
                { phase: 'answer', content: 'Answer', status: 'finished' },
              ],
            },
          },
          currentId: 'assistant',
          currentResponseIds: ['assistant'],
        },
      },
    },
  })
}
