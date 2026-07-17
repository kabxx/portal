import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  type CapturedFetchEntry,
} from '../../../src/providers/adapters/adapter-base.ts'
import { QwenAdapter } from '../../../src/providers/adapters/adapter-qwen.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const QWEN_COMPLETION_URL = 'https://chat.qwen.ai/api/v2/chat/completions'

type QwenAdapterHarness = Pick<QwenAdapter, keyof QwenAdapter> & {
  page: unknown
  conversationIdVal: string | null
  pendingText: string
  getCapturedFetchEntryCount: () => Promise<number>
  getCapturedFetchEntries: (
    startIndex?: number
  ) => Promise<CapturedFetchEntry[]>
  getSubmitRequestStartGraceMs: () => number
  getSubmitResponseTimeoutMs: () => number
  getHistoryLoadTimeoutMs: () => number
}

function createTestQwenAdapter(): QwenAdapterHarness {
  const adapter = new QwenAdapter(createBrowserContextStub())
  return Object.assign(adapter, {
    page: undefined,
    conversationIdVal: 'chat-1',
    pendingText: '',
    getCapturedFetchEntryCount: async () => 0,
    getCapturedFetchEntries: async () => [],
    getSubmitRequestStartGraceMs: () => 5,
    getSubmitResponseTimeoutMs: () => 500,
    getHistoryLoadTimeoutMs: () => 500,
  })
}

test('QwenAdapter submits only the request whose body owns the pending text', async () => {
  const adapter = createTestQwenAdapter()
  const page = createSubmitPage()
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
  adapter.getSubmitResponseTimeoutMs = () => 2_147_483_647
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
      })
    ),
    createCompletionEntry(2, createResponseBody()),
  ]
  adapter.page = createSubmitPage({ responseTextDelayMs: 80 })
  await adapter.attachText('Portal request')

  assert.equal(await adapter.submit(), 'Qwen answer')
  assert.equal(emitted.includes('STALE STREAM'), false)
  assert.equal(emitted.at(-1), 'Qwen answer')
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

test('QwenAdapter changes models by one-based option index', async () => {
  const adapter = createTestQwenAdapter()
  const selected: number[] = []
  adapter.page = createControlPage({ selected })

  await adapter.changeModel('2')
  assert.deepEqual(selected, [1])
  await assert.rejects(
    adapter.changeModel('0'),
    ProviderAdapterUnsupportedError
  )
  await assert.rejects(
    adapter.changeModel('3'),
    ProviderAdapterUnsupportedError
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

interface SubmitPageOptions {
  finished?: boolean
  omitResponse?: boolean
  omitRequest?: boolean
  requestFailed?: boolean
  responseStatus?: number
  responseTextDelayMs?: number
  loggedIn?: boolean
  authStates?: boolean[]
}

function createSubmitPage(options: SubmitPageOptions = {}) {
  const emitter = new EventEmitter()
  let composerValue = ''
  let authIndex = 0
  const composer = {
    count: async () => 1,
    first: () => composer,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {},
    inputValue: async () => composerValue,
  }
  const sendButton = {
    count: async () => 1,
    first: () => sendButton,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      if (options.omitRequest === true) return
      const stale = createRequest('different request')
      emitter.emit('request', stale)
      emitter.emit('response', createResponse(stale, true, options))

      const owned = createRequest(composerValue)
      composerValue = ''
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
    },
  }
  return Object.assign(emitter, {
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

function createRequest(content: string) {
  return {
    method: () => 'POST',
    url: () => QWEN_COMPLETION_URL,
    postDataJSON: () => ({
      stream: true,
      chat_id: 'chat-1',
      messages: [{ id: 'user-1', role: 'user', content }],
    }),
    failure: () => ({ errorText: 'connection reset' }),
  }
}

function createResponse(
  request: ReturnType<typeof createRequest>,
  finished: boolean,
  options: SubmitPageOptions
) {
  const raw = createResponseBody({ finished })
  return {
    request: () => request,
    status: () => options.responseStatus ?? 200,
    text: async () => {
      if (options.responseTextDelayMs !== undefined) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.responseTextDelayMs)
        )
      }
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
  parentId?: string
  responseId?: string
  finished?: boolean
} = {}): string {
  return [
    `data: {"response.created":{"chat_id":"chat-1","response_id":"${responseId}","parent_id":"${parentId}"}}`,
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
}: {
  selected?: number[]
  uploaded?: Array<string | readonly string[]>
  onStop?: () => void
}) {
  const emitter = new EventEmitter()
  let listboxVisible = false
  let uploadMenuVisible = false
  let uploadCount = 0
  const options = {
    count: async () => 2,
    nth: (index: number) => ({
      click: async () => {
        selected.push(index)
      },
    }),
  }
  const listbox = {
    count: async () => 1,
    first: () => listbox,
    isVisible: async () => listboxVisible,
    locator: () => options,
  }
  const trigger = {
    count: async () => 1,
    first: () => trigger,
    click: async () => {
      listboxVisible = true
    },
  }
  const uploadTrigger = {
    count: async () => 1,
    first: () => uploadTrigger,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      uploadMenuVisible = true
    },
  }
  const uploadItem = {
    count: async () => 1,
    first: () => uploadItem,
    isVisible: async () => uploadMenuVisible,
    click: async () => {},
  }
  const fileCards = {
    count: async () => uploadCount,
  }
  const stop = {
    count: async () => 1,
    first: () => stop,
    isVisible: async () => true,
    click: async () => onStop(),
  }
  return Object.assign(emitter, {
    locator: (selector: string) => {
      if (selector.includes('qwen-chat-header-left')) return trigger
      if (selector === '[role="listbox"]') return listbox
      if (selector.includes('mode-select-open')) return uploadTrigger
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

function createCompletionEntry(id: number, body: string): CapturedFetchEntry {
  return {
    id,
    url: QWEN_COMPLETION_URL,
    method: 'POST',
    status: 200,
    chunks: [body],
    done: true,
    error: null,
  }
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
