import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractKimiJsonObjects,
  KimiAdapter,
  parseKimiConnectResponse,
} from '../../../src/providers/adapters/adapter-kimi.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const KIMI_CHAT_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat'

type KimiAdapterHarness = Pick<KimiAdapter, keyof KimiAdapter> & {
  page: unknown
  conversationIdVal: string | null
  pendingTextVal: string
  getCapturedFetchEntryCount(): Promise<number>
  getCapturedFetchEntries(startIndex?: number): Promise<unknown[]>
  reportCapturedSubmitActivity(entries: readonly unknown[]): void
  startSubmitTextPolling(read: () => Promise<string | null>): () => void
}

function createTestKimiAdapter(): KimiAdapterHarness {
  const adapter = new KimiAdapter(createBrowserContextStub())
  const candidate: object = adapter
  if (
    !('getCapturedFetchEntryCount' in candidate) ||
    typeof candidate.getCapturedFetchEntryCount !== 'function' ||
    !('getCapturedFetchEntries' in candidate) ||
    typeof candidate.getCapturedFetchEntries !== 'function' ||
    !('reportCapturedSubmitActivity' in candidate) ||
    typeof candidate.reportCapturedSubmitActivity !== 'function' ||
    !('startSubmitTextPolling' in candidate) ||
    typeof candidate.startSubmitTextPolling !== 'function'
  ) {
    throw new Error('Kimi adapter is missing submit harness methods.')
  }
  return Object.assign(adapter, {
    page: undefined,
    conversationIdVal: null,
    pendingTextVal: '',
    getCapturedFetchEntryCount: candidate.getCapturedFetchEntryCount,
    getCapturedFetchEntries: candidate.getCapturedFetchEntries,
    reportCapturedSubmitActivity: candidate.reportCapturedSubmitActivity,
    startSubmitTextPolling: candidate.startSubmitTextPolling,
  })
}

function connectFrame(payload: unknown): string {
  const json = JSON.stringify(payload)
  return `\0\0\0\0${String.fromCharCode(json.length)}${json}`
}

function kimiRequestFrame(text: string): string {
  return connectFrame({
    message: {
      role: 'user',
      blocks: [{ text: { content: text } }],
    },
  })
}

test('Kimi Connect parser extracts concatenated JSON frames and completion', () => {
  const raw = [
    connectFrame({ heartbeat: {} }),
    connectFrame({
      message: {
        id: 'user-1',
        role: 'user',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  assert.equal(extractKimiJsonObjects(raw).length, 4)
  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: true,
    statuses: ['MESSAGE_STATUS_GENERATING', 'MESSAGE_STATUS_COMPLETED'],
    error: null,
  })
})

test('Kimi Connect parser preserves structured stream errors', () => {
  const raw = connectFrame({
    error: { code: 'MODEL_RATE_LIMIT', message: 'busy' },
  })

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: false,
    statuses: [],
    error: { code: 'MODEL_RATE_LIMIT', detail: 'busy' },
  })
})

test('Kimi Connect parser reads block exception reasons', () => {
  const raw = connectFrame({
    block: {
      exception: {
        error: { reason: 'REASON_COMPLETION_OVERLOADED' },
      },
    },
  })

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: false,
    statuses: [],
    error: { code: 'REASON_COMPLETION_OVERLOADED', detail: null },
  })
})

test('Kimi Connect parser ignores empty error metadata', () => {
  const raw = connectFrame({
    message: {
      id: 'assistant-1',
      role: 'assistant',
      status: 'MESSAGE_STATUS_COMPLETED',
      error: {},
    },
  })

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: true,
    statuses: ['MESSAGE_STATUS_COMPLETED'],
    error: null,
  })
})

test('Kimi Connect parser requires completion from the owned assistant id', () => {
  const raw = [
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-2',
        role: 'assistant',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
    connectFrame({
      message: {
        role: 'assistant',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: false,
    statuses: ['MESSAGE_STATUS_GENERATING'],
    error: null,
  })
})

test('KimiAdapter submit requires an owned completed response and returns DOM text', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let sendClicks = 0
  const completedRaw = [
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  const locator = (selector: string) => {
    const count = async () => {
      if (selector === '.chat-editor .send-button-container.stop') return 0
      if (selector === '.segment.segment-assistant .markdown') {
        return sendClicks === 0 ? 0 : 1
      }
      return 1
    }
    const target = {
      count,
      first() {
        return this
      },
      last() {
        return this
      },
      async isVisible() {
        return true
      },
      async click() {
        if (selector.includes(':not(.disabled)')) {
          sendClicks += 1
          currentUrl = 'https://www.kimi.com/chat/conversation-1'
        }
      },
      async textContent() {
        return selector === '.segment.segment-assistant .markdown'
          ? 'assistant answer'
          : ''
      },
    }
    return target
  }
  const page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  const adapter = createTestKimiAdapter()
  adapter.page = page
  adapter.conversationIdVal = null
  adapter.pendingTextVal = 'owned prompt'
  adapter.getCapturedFetchEntryCount = async () => 4
  adapter.getCapturedFetchEntries = async () => [
    {
      id: 5,
      url: KIMI_CHAT_URL,
      method: 'POST',
      requestBody: kimiRequestFrame('owned prompt'),
      status: 200,
      chunks: [completedRaw],
      done: true,
      error: null,
    },
  ]
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.startSubmitTextPolling = () => () => {}

  assert.equal(await adapter.submit(), 'assistant answer')
  assert.equal(sendClicks, 1)
  assert.equal(adapter.conversationId, 'conversation-1')
})

test('KimiAdapter page fallback ignores a concurrent POST with different text', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let sendClicks = 0
  let staleTextReads = 0
  let freshTextReads = 0
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const freshRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => kimiRequestFrame('owned fallback prompt'),
  }
  const staleRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => kimiRequestFrame('concurrent prompt'),
  }
  const completedRaw = [
    connectFrame({
      message: {
        id: 'assistant-fallback',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-fallback',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')
  const locator = (selector: string) => ({
    count: async () => {
      if (selector === '.chat-editor .send-button-container.stop') return 0
      if (selector === '.segment.segment-assistant .markdown') {
        return sendClicks === 0 ? 0 : 1
      }
      return 1
    },
    first() {
      return this
    },
    last() {
      return this
    },
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      sendClicks += 1
      currentUrl = 'https://www.kimi.com/chat/fallback-conversation'
      const staleResponse = {
        request: () => staleRequest,
        url: () => KIMI_CHAT_URL,
        status: () => 200,
        text: async () => {
          staleTextReads += 1
          return completedRaw
        },
      }
      requestListeners.forEach((listener) => listener(staleRequest))
      responseListeners.forEach((listener) => listener(staleResponse))
      requestListeners.forEach((listener) => listener(freshRequest))
      const freshResponse = {
        request: () => freshRequest,
        url: () => KIMI_CHAT_URL,
        status: () => 200,
        text: async () => {
          freshTextReads += 1
          return completedRaw
        },
      }
      responseListeners.forEach((listener) => listener(freshResponse))
    },
    textContent: async () =>
      selector === '.segment.segment-assistant .markdown'
        ? 'fallback answer'
        : '',
  })
  const page = {
    locator,
    url: () => currentUrl,
    on: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') requestListeners.add(listener)
      if (event === 'response') responseListeners.add(listener)
    },
    off: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') requestListeners.delete(listener)
      if (event === 'response') responseListeners.delete(listener)
    },
  }
  const adapter = createTestKimiAdapter()
  adapter.page = page
  adapter.conversationIdVal = null
  adapter.pendingTextVal = 'owned fallback prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => []
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.startSubmitTextPolling = () => () => {}

  assert.equal(await adapter.submit(), 'fallback answer')
  assert.equal(staleTextReads, 0)
  assert.equal(freshTextReads, 1)
  assert.equal(requestListeners.size, 0)
  assert.equal(responseListeners.size, 0)
})

test('KimiAdapter stopGeneration clicks only one visible stop control', async () => {
  let clicks = 0
  const stop = {
    count: async () => 1,
    first() {
      return this
    },
    isVisible: async () => true,
    click: async () => {
      clicks += 1
    },
  }
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator: () => stop,
  }

  await adapter.stopGeneration()

  assert.equal(clicks, 1)
})

test('KimiAdapter waits for every selected file to finish uploading', async () => {
  let uploadComplete = false
  let selectedPaths: string[] = []
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator: (selector: string) => {
      if (selector.includes('toolkit-trigger-btn')) {
        return {
          count: async () => 1,
          first() {
            return this
          },
          isVisible: async () => true,
          click: async () => {},
        }
      }
      if (selector.includes('input[type="file"]')) {
        return {
          count: async () => 1,
          first() {
            return this
          },
          setInputFiles: async (paths: string[]) => {
            selectedPaths = paths
            setTimeout(() => {
              uploadComplete = true
            }, 20)
          },
        }
      }
      return {
        count: async () => selectedPaths.length,
        nth: () => ({
          getAttribute: async () =>
            uploadComplete
              ? 'file-card-container normal success'
              : 'file-card-container normal uploading',
        }),
      }
    },
  }

  await adapter.attachFile(['first.txt', 'second.txt'])

  assert.deepEqual(selectedPaths, ['first.txt', 'second.txt'])
  assert.equal(uploadComplete, true)
})

test('KimiAdapter fails immediately when an uploaded file enters an error state', async () => {
  let selected = false
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator: (selector: string) => {
      if (selector.includes('toolkit-trigger-btn')) {
        return {
          count: async () => 1,
          first() {
            return this
          },
          isVisible: async () => true,
          click: async () => {},
        }
      }
      if (selector.includes('input[type="file"]')) {
        return {
          count: async () => 1,
          first() {
            return this
          },
          setInputFiles: async () => {
            selected = true
          },
        }
      }
      return {
        count: async () => (selected ? 1 : 0),
        nth: () => ({
          getAttribute: async () => 'file-card-container normal failed',
        }),
      }
    },
  }

  await assert.rejects(
    adapter.attachFile('failed.txt'),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_file_upload_failed'
  )
})
