import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractKimiJsonObjects,
  KimiAdapter,
  parseKimiConnectResponse,
} from '../../../src/providers/adapters/adapter-kimi.ts'
import { ProviderResponseTimeoutError } from '../../../src/providers/adapters/adapter-base.ts'
import { joinCssLocatorCandidates } from '../../../src/providers/ui/provider-ui.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const KIMI_CHAT_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const KIMI_LOCATORS = {
  capabilityTrigger: ['.chat-editor .toolkit-trigger-btn'],
  capabilityPopover: ['.toolkit-popover'],
  searchItem: ['.toolkit-item:has(svg[name="InternetOn"])'],
  searchPopover: ['.connect-popover'],
  searchOption: ['.connect-item'],
  selectedOptionIcon: ['svg[name="Check"]'],
} as const

type KimiAdapterHarness = Pick<KimiAdapter, keyof KimiAdapter> & {
  page: unknown
  conversationIdVal: string | null
  pendingTextVal: string
  getCapturedFetchEntryCount(): Promise<number>
  getCapturedFetchEntries(startIndex?: number): Promise<unknown[]>
  reportCapturedSubmitActivity(entries: readonly unknown[]): void
  getSubmitResponseTimeoutMs(): number | null
  getSubmitResponseStartTimeoutMs(): number
  getSubmitResponseStallTimeoutMs(): number
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
    !('getSubmitResponseTimeoutMs' in candidate) ||
    typeof candidate.getSubmitResponseTimeoutMs !== 'function' ||
    !('getSubmitResponseStartTimeoutMs' in candidate) ||
    typeof candidate.getSubmitResponseStartTimeoutMs !== 'function' ||
    !('getSubmitResponseStallTimeoutMs' in candidate) ||
    typeof candidate.getSubmitResponseStallTimeoutMs !== 'function'
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
    getSubmitResponseTimeoutMs: candidate.getSubmitResponseTimeoutMs,
    getSubmitResponseStartTimeoutMs: candidate.getSubmitResponseStartTimeoutMs,
    getSubmitResponseStallTimeoutMs: candidate.getSubmitResponseStallTimeoutMs,
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

function completedKimiResponse(id: string, text: string): string {
  return [
    connectFrame({
      message: {
        id,
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [{ text: { content: text } }],
      },
    }),
    connectFrame({
      message: {
        id,
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')
}

function createKimiCapabilityPage({
  initialState = 'off',
  onOptionIndex = 0,
  triggerCount = 1,
  toolkitOpens = true,
  triggerVisible = true,
  triggerEnabled = true,
  searchCount = 1,
  searchVisible = true,
  searchEnabled = true,
  optionCount = 2,
  optionVisible = true,
  optionEnabled = true,
  selectedChecks = 'state',
  storageValue = 'state',
  applyClicks = true,
  escapeClosesMenu = true,
}: {
  initialState?: 'on' | 'off'
  onOptionIndex?: 0 | 1
  triggerCount?: number
  toolkitOpens?: boolean
  triggerVisible?: boolean
  triggerEnabled?: boolean
  searchCount?: number
  searchVisible?: boolean
  searchEnabled?: boolean
  optionCount?: number
  optionVisible?: boolean
  optionEnabled?: boolean
  selectedChecks?: 'state' | 'none' | 'both' | 'hidden'
  storageValue?: 'state' | 'invalid' | null
  applyClicks?: boolean
  escapeClosesMenu?: boolean
} = {}) {
  let state = initialState
  let toolkitOpen = false
  let searchOpen = false
  let searchClicks = 0
  let triggerClicks = 0
  let escapePresses = 0
  let composerClicks = 0
  const trigger = {
    count: async () => triggerCount,
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => triggerVisible,
    isEnabled: async () => triggerEnabled,
    click: async () => {
      triggerClicks += 1
      if (toolkitOpens) toolkitOpen = true
    },
    getAttribute: async (name: string) =>
      name === 'class' && toolkitOpen
        ? 'icon-button toolkit-trigger-btn active'
        : 'icon-button toolkit-trigger-btn',
  }
  const popover = {
    count: async () => (toolkitOpen ? 1 : 0),
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => toolkitOpen,
    locator: () => search,
  }
  const searchPopover = {
    count: async () => (searchOpen ? 1 : 0),
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => searchOpen,
    locator: () => options,
  }
  const search = {
    count: async () => (toolkitOpen ? searchCount : 0),
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => toolkitOpen && searchVisible,
    isEnabled: async () => searchEnabled,
    click: async () => {
      searchOpen = true
    },
  }
  const option = (index: number) => {
    const isSelected = () => {
      if (selectedChecks === 'none') return false
      if (selectedChecks === 'both') return true
      const selectedIndex = state === 'on' ? onOptionIndex : 1 - onOptionIndex
      return index === selectedIndex
    }
    return {
      isVisible: async () => searchOpen && optionVisible,
      isEnabled: async () => optionEnabled,
      click: async () => {
        searchClicks += 1
        if (applyClicks) state = index === onOptionIndex ? 'on' : 'off'
      },
      locator: (selector: string) => ({
        count: async () =>
          selector ===
            joinCssLocatorCandidates(KIMI_LOCATORS.selectedOptionIcon) &&
          isSelected()
            ? 1
            : 0,
        first() {
          return this
        },
        isVisible: async () => isSelected() && selectedChecks !== 'hidden',
      }),
    }
  }
  const options = {
    count: async () => (searchOpen ? optionCount : 0),
    nth: (index: number) => option(index),
  }
  const composer = {
    count: async () => 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => true,
    click: async () => {
      composerClicks += 1
      toolkitOpen = false
      searchOpen = false
    },
  }
  const missing = {
    count: async () => 0,
    first() {
      return this
    },
    nth() {
      return this
    },
    isVisible: async () => false,
    isEnabled: async () => false,
  }
  return {
    page: {
      locator: (selector: string) => {
        if (
          selector === joinCssLocatorCandidates(KIMI_LOCATORS.capabilityTrigger)
        ) {
          return trigger
        }
        if (
          selector === joinCssLocatorCandidates(KIMI_LOCATORS.capabilityPopover)
        ) {
          return popover
        }
        if (
          selector === joinCssLocatorCandidates(KIMI_LOCATORS.searchPopover)
        ) {
          return searchPopover
        }
        if (
          selector ===
          `${joinCssLocatorCandidates(KIMI_LOCATORS.searchPopover)} ${joinCssLocatorCandidates(KIMI_LOCATORS.searchOption)}`
        ) {
          return options
        }
        if (
          selector === '.chat-editor .chat-input-editor[contenteditable="true"]'
        ) {
          return composer
        }
        if (
          selector ===
          `${joinCssLocatorCandidates(KIMI_LOCATORS.capabilityPopover)} ${joinCssLocatorCandidates(KIMI_LOCATORS.searchItem)}`
        ) {
          return search
        }
        return missing
      },
      keyboard: {
        press: async (key: string) => {
          if (key === 'Escape') {
            escapePresses += 1
            if (escapeClosesMenu) {
              toolkitOpen = false
              searchOpen = false
            }
          }
        },
      },
      evaluate: async (_pageFunction: unknown, storageKey: string) => {
        if (storageKey !== 'selectSearch' || storageValue === null) return null
        if (storageValue === 'invalid') return 'unexpected'
        return state === 'on' ? 'true' : 'false'
      },
    },
    get state() {
      return state
    },
    get menuOpen() {
      return toolkitOpen || searchOpen
    },
    get searchClicks() {
      return searchClicks
    },
    get triggerClicks() {
      return triggerClicks
    },
    get escapePresses() {
      return escapePresses
    },
    get composerClicks() {
      return composerClicks
    },
  }
}

function createKimiCapturedSubmitPage() {
  let currentUrl = 'https://www.kimi.com/'
  let sendClicks = 0
  let requestText = ''
  let responseRaw = ''
  let responseDone = true
  let requestStartedAt = 0
  let keepStopVisible = false
  let stopVisible = false

  const locator = (selector: string) => ({
    count: async () => {
      if (selector === '.chat-editor .send-button-container.stop') {
        return stopVisible ? 1 : 0
      }
      return 1
    },
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      sendClicks += 1
      currentUrl = 'https://www.kimi.com/chat/conversation-1'
      requestStartedAt = Date.now()
      stopVisible = keepStopVisible
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  adapter.conversationIdVal = null
  adapter.getCapturedFetchEntryCount = async () => 4
  adapter.getCapturedFetchEntries = async () => [
    {
      id: 5,
      url: KIMI_CHAT_URL,
      method: 'POST',
      startedAt: requestStartedAt,
      requestBody: kimiRequestFrame(requestText),
      status: 200,
      chunks: [responseRaw],
      done: responseDone,
      error: null,
    },
  ]
  adapter.reportCapturedSubmitActivity = () => {}

  return {
    adapter,
    setTurn(
      text: string,
      raw: string,
      {
        done = true,
        keepStop = false,
      }: { done?: boolean; keepStop?: boolean } = {}
    ) {
      requestText = text
      responseRaw = raw
      responseDone = done
      keepStopVisible = keepStop
      stopVisible = false
      adapter.pendingTextVal = text
    },
    setResponseTimeout(timeoutMs: number | null) {
      adapter.getSubmitResponseTimeoutMs = () => timeoutMs
    },
    get sendClicks() {
      return sendClicks
    },
  }
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
    text: null,
    error: null,
  })
})

test('Kimi Connect parser appends owned text block frames without prefix guessing', () => {
  const raw = [
    connectFrame({
      message: {
        id: 'user-1',
        role: 'user',
        blocks: [{ text: { content: 'ignore user text' } }],
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [
          {
            id: 'text-1',
            messageId: 'assistant-1',
            text: { content: '#' },
          },
        ],
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-2',
        role: 'assistant',
        blocks: [
          {
            id: 'text-2',
            messageId: 'assistant-2',
            text: { content: 'ignore concurrent assistant' },
          },
        ],
      },
    }),
    connectFrame({
      op: 'append',
      block: {
        id: 'text-1',
        messageId: 'assistant-1',
        text: { content: '# Heading\n\n- one' },
      },
    }),
    connectFrame({
      op: 'OPERATOR_APPEND',
      event: {
        case: 'block',
        value: {
          id: 'text-1',
          messageId: 'assistant-1',
          content: {
            case: 'text',
            value: { content: '\n- two\n\n```ts\nconst x = 1\n```' },
          },
        },
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: true,
    statuses: ['MESSAGE_STATUS_GENERATING', 'MESSAGE_STATUS_COMPLETED'],
    text: '## Heading\n\n- one\n- two\n\n```ts\nconst x = 1\n```',
    error: null,
  })
})

test('Kimi Connect parser replaces a text block only for a whole-block set', () => {
  const raw = [
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [
          {
            id: 'text-1',
            messageId: 'assistant-1',
            text: { content: 'old text' },
          },
        ],
      },
    }),
    connectFrame({
      op: 'OPERATOR_SET',
      mask: { paths: ['block'] },
      block: {
        id: 'text-1',
        messageId: 'assistant-1',
        text: { content: '# Replacement' },
      },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  assert.equal(parseKimiConnectResponse(raw).text, '# Replacement')
})

test('Kimi Connect parser associates stable anonymous blocks with the owned assistant', () => {
  const raw = [
    connectFrame({
      block: { id: 'too-early', text: { content: 'ignore before assistant' } },
    }),
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      op: 'OPERATOR_APPEND',
      event: {
        case: 'block',
        value: { id: 'text-1', text: { content: '#' } },
      },
    }),
    connectFrame({
      op: 'OPERATOR_APPEND',
      block: { id: 'text-1', text: { content: '# Heading' } },
    }),
    connectFrame({
      block: {
        id: 'text-1',
        messageId: 'assistant-2',
        text: { content: ' ignore foreign assistant' },
      },
    }),
    connectFrame({ block: { text: { content: ' ignore unstable block' } } }),
    connectFrame({
      message: {
        id: 'assistant-1',
        status: 'MESSAGE_STATUS_COMPLETED',
      },
    }),
  ].join('')

  assert.equal(parseKimiConnectResponse(raw).text, '## Heading')
})

test('Kimi Connect parser replaces an associated anonymous block on whole-block set', () => {
  const raw = [
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      op: 'OPERATOR_APPEND',
      block: { id: 'text-1', text: { content: 'old text' } },
    }),
    connectFrame({
      op: 'OPERATOR_SET',
      mask: { paths: ['block'] },
      event: {
        case: 'block',
        value: { id: 'text-1', text: { content: '# Replacement' } },
      },
    }),
    connectFrame({ done: {} }),
  ].join('')

  assert.equal(parseKimiConnectResponse(raw).text, '# Replacement')
})

test('Kimi Connect parser accepts only an empty root done frame', () => {
  assert.deepEqual(parseKimiConnectResponse(connectFrame({ done: {} })), {
    isFinished: true,
    statuses: [],
    text: null,
    error: null,
  })

  for (const raw of [
    connectFrame({ message: { done: {} } }),
    connectFrame({ done: null }),
    connectFrame({ done: true }),
    connectFrame({ done: [] }),
    connectFrame({ done: { unexpected: true } }),
  ]) {
    assert.deepEqual(parseKimiConnectResponse(raw), {
      isFinished: false,
      statuses: [],
      text: null,
      error: null,
    })
  }
})

test('Kimi Connect parser preserves stream errors alongside a done frame', () => {
  const raw = [
    connectFrame({ error: { code: 'MODEL_RATE_LIMIT', message: 'busy' } }),
    connectFrame({ done: {} }),
  ].join('')

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: true,
    statuses: [],
    text: null,
    error: { code: 'MODEL_RATE_LIMIT', detail: 'busy' },
  })
})

test('Kimi Connect parser preserves structured stream errors', () => {
  const raw = connectFrame({
    error: { code: 'MODEL_RATE_LIMIT', message: 'busy' },
  })

  assert.deepEqual(parseKimiConnectResponse(raw), {
    isFinished: false,
    statuses: [],
    text: null,
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
    text: null,
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
    text: null,
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
    text: null,
    error: null,
  })
})

test('KimiAdapter returns Markdown from terminal network protocol frames', async () => {
  const controls = createKimiCapturedSubmitPage()
  const doneRaw = [
    connectFrame({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [{ text: { content: '# Assistant answer\n\n- item' } }],
      },
    }),
    connectFrame({ done: {} }),
  ].join('')
  controls.setTurn('owned done prompt', doneRaw)
  assert.equal(await controls.adapter.submit(), '# Assistant answer\n\n- item')

  const completedRaw = connectFrame({
    message: {
      id: 'assistant-2',
      role: 'assistant',
      status: 'MESSAGE_STATUS_COMPLETED',
      blocks: [{ text: { content: '`network only`' } }],
    },
  })
  controls.setTurn('owned completed prompt', completedRaw)
  assert.equal(await controls.adapter.submit(), '`network only`')

  const anonymousBlockRaw = [
    connectFrame({
      message: {
        id: 'assistant-3',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
      },
    }),
    connectFrame({
      op: 'OPERATOR_APPEND',
      event: {
        case: 'block',
        value: {
          id: 'text-3',
          content: {
            case: 'text',
            value: { content: '**network Markdown**' },
          },
        },
      },
    }),
    connectFrame({ done: {} }),
  ].join('')
  controls.setTurn('anonymous block prompt', anonymousBlockRaw)
  assert.equal(await controls.adapter.submit(), '**network Markdown**')

  assert.equal(controls.sendClicks, 3)
  assert.equal(controls.adapter.conversationId, 'conversation-1')
})

test('KimiAdapter rejects errors and unverified clean-EOF responses', async () => {
  const controls = createKimiCapturedSubmitPage()
  const errorRaw = [
    connectFrame({ error: { code: 'MODEL_RATE_LIMIT', message: 'busy' } }),
    connectFrame({ done: {} }),
  ].join('')
  controls.setTurn('owned error prompt', errorRaw)
  await assert.rejects(
    controls.adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_stream_error_model_rate_limit'
  )

  const incompleteRaw = connectFrame({
    message: {
      id: 'assistant-incomplete',
      role: 'assistant',
      status: 'MESSAGE_STATUS_GENERATING',
    },
  })
  controls.setResponseTimeout(1)
  for (const options of [{ keepStop: false }, { keepStop: true }]) {
    controls.setTurn('owned incomplete prompt', incompleteRaw, options)
    await assert.rejects(
      controls.adapter.submit(),
      (error: unknown) =>
        error instanceof Error &&
        'detailCode' in error &&
        error.detailCode === 'kimi_response_incomplete'
    )
  }

  const completedRaw = connectFrame({
    message: {
      id: 'assistant-completed',
      role: 'assistant',
      status: 'MESSAGE_STATUS_COMPLETED',
    },
  })
  controls.setTurn('owned missing text prompt', completedRaw)
  await assert.rejects(
    controls.adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_response_text_missing'
  )

  controls.setResponseTimeout(null)
  controls.setTurn('owned aborted prompt', incompleteRaw, {
    done: false,
    keepStop: true,
  })
  const abortController = new AbortController()
  const abortedSubmit = controls.adapter.submit({
    signal: abortController.signal,
  })
  setTimeout(() => abortController.abort(), 0)
  await assert.rejects(
    abortedSubmit,
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
})

test('KimiAdapter page ownership does not depend on request body text', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let freshTextReads = 0
  let capturedEntries: Array<Record<string, unknown>> = []
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const freshRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => kimiRequestFrame('rewritten by the page'),
  }
  const completedRaw = [
    connectFrame({
      message: {
        id: 'assistant-fallback',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [{ text: { content: '# Fallback answer' } }],
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
      return 1
    },
    first() {
      return this
    },
    last() {
      return this
    },
    nth() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/fallback-conversation'
      capturedEntries = [
        {
          id: 5,
          url: KIMI_CHAT_URL,
          method: 'POST',
          startedAt: Date.now(),
          status: 200,
          chunks: [
            completedKimiResponse(
              'assistant-captured-mirror',
              'wrong captured answer'
            ),
          ],
          done: true,
          error: null,
        },
      ]
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
  adapter.getCapturedFetchEntries = async () => capturedEntries
  adapter.reportCapturedSubmitActivity = () => {}

  assert.equal(await adapter.submit(), '# Fallback answer')
  assert.equal(freshTextReads, 1)
  assert.equal(requestListeners.size, 0)
  assert.equal(responseListeners.size, 0)
})

test('KimiAdapter does not emit final text after cancellation during the final capture scan', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let generationSettledChecked = false
  let cancelledCaptureRead = false
  const emittedText: string[] = []
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const abortController = new AbortController()
  const request = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const completedRaw = completedKimiResponse(
    'assistant-cancelled-final-scan',
    'answer-after-abort'
  )
  const locator = (selector: string) => ({
    count: async () => {
      if (selector === '.chat-editor .send-button-container.stop') {
        generationSettledChecked = true
        return 0
      }
      return 1
    },
    first() {
      return this
    },
    last() {
      return this
    },
    nth() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/cancelled-final-scan'
      requestListeners.forEach((listener) => listener(request))
      responseListeners.forEach((listener) =>
        listener({
          request: () => request,
          status: () => 200,
          text: async () => completedRaw,
        })
      )
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
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
  adapter.pendingTextVal = 'cancel during final capture scan'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => {
    if (!generationSettledChecked || cancelledCaptureRead) return []
    cancelledCaptureRead = true
    return await new Promise<unknown[]>((resolve) => {
      setTimeout(() => {
        abortController.abort()
        resolve([])
      }, 0)
    })
  }
  adapter.getSubmitResponseTimeoutMs = () => 1_000
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.setSubmitTextReporter(async (text) => {
    emittedText.push(text)
  })

  await assert.rejects(
    adapter.submit({ signal: abortController.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(cancelledCaptureRead, true)
  assert.deepEqual(emittedText, [])
})

test('KimiAdapter does not emit captured text after cancellation during an owned read', async () => {
  const controls = createKimiCapturedSubmitPage()
  const abortController = new AbortController()
  const emittedText: string[] = []
  const partialRaw = connectFrame({
    message: {
      id: 'assistant-cancelled-capture-read',
      role: 'assistant',
      status: 'MESSAGE_STATUS_GENERATING',
      blocks: [{ text: { content: 'partial-after-abort' } }],
    },
  })
  let ownershipConfirmed = false
  let postOwnershipReads = 0
  let cancelledCaptureRead = false

  controls.setTurn('cancel during owned capture read', partialRaw, {
    done: false,
    keepStop: true,
  })
  controls.setResponseTimeout(1_000)
  controls.adapter.reportCapturedSubmitActivity = (entries) => {
    if (entries.length > 0) ownershipConfirmed = true
  }
  controls.adapter.getCapturedFetchEntries = async () => {
    const entries = [
      {
        id: 5,
        url: KIMI_CHAT_URL,
        method: 'POST',
        startedAt: Date.now(),
        status: 200,
        chunks: [partialRaw],
        done: false,
        error: null,
      },
    ]
    if (!ownershipConfirmed) return entries
    postOwnershipReads += 1
    if (postOwnershipReads !== 2) return entries
    return await new Promise<unknown[]>((resolve) => {
      setTimeout(() => {
        cancelledCaptureRead = true
        abortController.abort()
        resolve(entries)
      }, 0)
    })
  }
  controls.adapter.setSubmitTextReporter(async (text) => {
    emittedText.push(text)
  })

  await assert.rejects(
    controls.adapter.submit({ signal: abortController.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
  assert.equal(cancelledCaptureRead, true)
  assert.ok(postOwnershipReads >= 2)
  assert.deepEqual(emittedText, [])
})

test('KimiAdapter does not let unrelated captured traffic refresh the response watchdog', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let dispatchedAt = 0
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/unrelated-capture'
      dispatchedAt = Date.now()
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  adapter.pendingTextVal = 'unrelated capture prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => {
    if (dispatchedAt === 0) return []
    const elapsedMs = Date.now() - dispatchedAt
    const chunkCount = Math.max(1, Math.min(8, Math.floor(elapsedMs / 20) + 1))
    return [
      {
        id: 5,
        url: 'https://www.kimi.com/api/analytics',
        method: 'GET',
        startedAt: dispatchedAt,
        status: 200,
        chunks: Array.from({ length: chunkCount }, () => 'background'),
        done: false,
        error: null,
      },
    ]
  }
  adapter.getSubmitResponseTimeoutMs = () => null
  adapter.getSubmitResponseStartTimeoutMs = () => 60
  adapter.getSubmitResponseStallTimeoutMs = () => 60
  adapter.stopGeneration = async () => {}

  await assert.rejects(
    adapter.submitWithResponseTimeout(),
    (error: unknown) =>
      error instanceof ProviderResponseTimeoutError &&
      error.detailCode === 'provider_response_start_timeout'
  )
})

test('KimiAdapter owned captured progress refreshes the response watchdog', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let dispatchedAt = 0
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/owned-capture-progress'
      dispatchedAt = Date.now()
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  adapter.pendingTextVal = 'owned capture progress prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => {
    if (dispatchedAt === 0) return []
    const elapsedMs = Date.now() - dispatchedAt
    const done = elapsedMs >= 650
    const progressCount = Math.max(1, Math.floor(elapsedMs / 50) + 1)
    const progressChunks = Array.from({ length: progressCount }, (_, index) =>
      connectFrame({ heartbeat: { index } })
    )
    return [
      {
        id: 5,
        url: 'https://www.kimi.com/api/analytics',
        method: 'GET',
        startedAt: dispatchedAt,
        status: 200,
        chunks: Array.from({ length: progressCount }, () => 'background'),
        done: false,
        error: null,
      },
      {
        id: 6,
        url: KIMI_CHAT_URL,
        method: 'POST',
        startedAt: dispatchedAt,
        status: 200,
        chunks: done
          ? [
              ...progressChunks,
              completedKimiResponse('assistant-owned-progress', 'owned answer'),
            ]
          : progressChunks,
        done,
        error: null,
      },
    ]
  }
  adapter.getSubmitResponseTimeoutMs = () => null
  adapter.getSubmitResponseStartTimeoutMs = () => 300
  adapter.getSubmitResponseStallTimeoutMs = () => 250
  adapter.stopGeneration = async () => {}

  assert.equal(await adapter.submitWithResponseTimeout(), 'owned answer')
})

test('KimiAdapter accepted live mirror progress refreshes the response watchdog', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let dispatchedAt = 0
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const liveRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/live-mirror-progress'
      dispatchedAt = Date.now()
      requestListeners.forEach((listener) => listener(liveRequest))
      responseListeners.forEach((listener) =>
        listener({
          request: () => liveRequest,
          status: () => 200,
          text: async () => {
            await new Promise((resolve) => setTimeout(resolve, 650))
            return completedKimiResponse(
              'assistant-live-progress',
              'live answer'
            )
          },
        })
      )
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
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
  adapter.pendingTextVal = 'live mirror progress prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => {
    if (dispatchedAt === 0) return []
    const progressCount = Math.max(
      1,
      Math.floor((Date.now() - dispatchedAt) / 50) + 1
    )
    return [
      {
        id: 5,
        url: KIMI_CHAT_URL,
        method: 'POST',
        startedAt: dispatchedAt,
        status: 200,
        chunks: Array.from({ length: progressCount }, (_, index) =>
          connectFrame({ heartbeat: { index } })
        ),
        done: false,
        error: null,
      },
    ]
  }
  adapter.getSubmitResponseTimeoutMs = () => null
  adapter.getSubmitResponseStartTimeoutMs = () => 300
  adapter.getSubmitResponseStallTimeoutMs = () => 250
  adapter.stopGeneration = async () => {}

  assert.equal(await adapter.submitWithResponseTimeout(), 'live answer')
})

test('KimiAdapter ignores a pre-dispatch live request that responds later', async () => {
  let currentUrl = 'https://www.kimi.com/'
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const staleRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => kimiRequestFrame('old text'),
  }
  const currentRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => kimiRequestFrame('rewritten current text'),
  }
  const responseRaw = [
    connectFrame({
      message: {
        id: 'assistant-current',
        role: 'assistant',
        status: 'MESSAGE_STATUS_GENERATING',
        blocks: [{ text: { content: 'current answer' } }],
      },
    }),
    connectFrame({ done: {} }),
  ].join('')
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/current'
      requestListeners.forEach((listener) => listener(currentRequest))
      const currentResponse = {
        request: () => currentRequest,
        url: () => KIMI_CHAT_URL,
        status: () => 200,
        text: async () => responseRaw,
      }
      responseListeners.forEach((listener) => listener(currentResponse))
      const staleResponse = {
        request: () => staleRequest,
        url: () => KIMI_CHAT_URL,
        status: () => 200,
        text: async () => {
          throw new Error('stale response must not be read')
        },
      }
      responseListeners.forEach((listener) => listener(staleResponse))
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') {
        requestListeners.add(listener)
        listener(staleRequest)
      }
      if (event === 'response') responseListeners.add(listener)
    },
    off: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') requestListeners.delete(listener)
      if (event === 'response') responseListeners.delete(listener)
    },
  }
  adapter.pendingTextVal = 'current prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => []
  adapter.reportCapturedSubmitActivity = () => {}

  assert.equal(await adapter.submit(), 'current answer')
})

test('KimiAdapter excludes pre-dispatch captured entries by start time', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let entries: Array<Record<string, unknown>> = []
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/current-capture'
      entries = [
        {
          id: 4,
          url: KIMI_CHAT_URL,
          method: 'POST',
          startedAt: Date.now() - 1_000,
          status: 200,
          chunks: [connectFrame({ done: {} })],
          done: true,
          error: null,
        },
        {
          id: 5,
          url: KIMI_CHAT_URL,
          method: 'POST',
          startedAt: Date.now(),
          status: 200,
          chunks: [
            connectFrame({
              message: {
                id: 'assistant-current-capture',
                role: 'assistant',
                status: 'MESSAGE_STATUS_COMPLETED',
                blocks: [{ text: { content: 'captured answer' } }],
              },
            }),
          ],
          done: true,
          error: null,
        },
      ]
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  adapter.pendingTextVal = 'captured prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => entries
  adapter.reportCapturedSubmitActivity = () => {}

  assert.equal(await adapter.submit(), 'captured answer')
})

test('KimiAdapter rejects multiple live ChatService candidates', async () => {
  let currentUrl = 'https://www.kimi.com/'
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const requestA = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const requestB = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/ambiguous'
      requestListeners.forEach((listener) => listener(requestA))
      requestListeners.forEach((listener) => listener(requestB))
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
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
  adapter.pendingTextVal = 'ambiguous prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => []
  adapter.getSubmitResponseTimeoutMs = () => 500
  adapter.reportCapturedSubmitActivity = () => {}

  await assert.rejects(
    adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_submit_outcome_unknown'
  )
  assert.equal(responseListeners.size, 0)
})

test('KimiAdapter rejects duplicate captured candidates', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let entries: Array<Record<string, unknown>> = []
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/captured-ambiguous'
      entries = [
        {
          id: 5,
          url: KIMI_CHAT_URL,
          method: 'POST',
          startedAt: Date.now(),
          status: 200,
          chunks: [],
          done: false,
          error: null,
        },
        {
          id: 6,
          url: KIMI_CHAT_URL,
          method: 'POST',
          startedAt: Date.now(),
          status: 200,
          chunks: [],
          done: false,
          error: null,
        },
      ]
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: () => {},
    off: () => {},
  }
  adapter.pendingTextVal = 'captured ambiguous prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => entries
  adapter.getSubmitResponseTimeoutMs = () => 500
  adapter.reportCapturedSubmitActivity = () => {}

  await assert.rejects(
    adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_submit_outcome_unknown'
  )
})

test('KimiAdapter rejects a second live request after the first response completes', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let dispatched = false
  let emittedLateRequest = false
  const emittedText: string[] = []
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const requestA = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const requestB = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const locator = (selector: string) => ({
    count: async () => {
      if (selector === '.chat-editor .send-button-container.stop') {
        if (dispatched && !emittedLateRequest) {
          emittedLateRequest = true
          requestListeners.forEach((listener) => listener(requestB))
        }
        return 0
      }
      return 1
    },
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      dispatched = true
      currentUrl = 'https://www.kimi.com/chat/late-live'
      requestListeners.forEach((listener) => listener(requestA))
      responseListeners.forEach((listener) =>
        listener({
          request: () => requestA,
          status: () => 200,
          text: async () =>
            completedKimiResponse('assistant-live-a', 'answer-a'),
        })
      )
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
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
  adapter.pendingTextVal = 'late live prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => []
  adapter.getSubmitResponseTimeoutMs = () => 1_000
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.setSubmitTextReporter(async (text) => {
    emittedText.push(text)
  })

  await assert.rejects(
    adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_submit_outcome_unknown'
  )
  assert.equal(emittedLateRequest, true)
  assert.deepEqual(emittedText, [])
})

test('KimiAdapter rejects a live request that appears while a captured owner completes', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let capturedEntry: Record<string, unknown> | null = null
  const emittedText: string[] = []
  const requestListeners = new Set<(value: unknown) => void>()
  const lateRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const locator = (selector: string) => ({
    count: async () =>
      selector === '.chat-editor .send-button-container.stop' ? 0 : 1,
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/capture-late-live'
      capturedEntry = {
        id: 5,
        url: KIMI_CHAT_URL,
        method: 'POST',
        startedAt: Date.now(),
        status: 200,
        chunks: [],
        done: false,
        error: null,
      }
      setTimeout(() => {
        requestListeners.forEach((listener) => listener(lateRequest))
        if (capturedEntry !== null) {
          capturedEntry.chunks = [
            completedKimiResponse('assistant-captured', 'captured answer'),
          ]
          capturedEntry.done = true
        }
      }, 150)
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
    locator,
    url: () => currentUrl,
    on: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') requestListeners.add(listener)
    },
    off: (event: string, listener: (value: unknown) => void) => {
      if (event === 'request') requestListeners.delete(listener)
    },
  }
  adapter.pendingTextVal = 'captured owner prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () =>
    capturedEntry === null ? [] : [capturedEntry]
  adapter.getSubmitResponseTimeoutMs = () => 1_000
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.setSubmitTextReporter(async (text) => {
    emittedText.push(text)
  })

  await assert.rejects(
    adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_submit_outcome_unknown'
  )
  assert.deepEqual(emittedText, [])
})

test('KimiAdapter rejects two captured requests that appear after live ownership', async () => {
  let currentUrl = 'https://www.kimi.com/'
  let capturedEntries: Array<Record<string, unknown>> = []
  let addedCapturedRequests = false
  const emittedText: string[] = []
  const requestListeners = new Set<(value: unknown) => void>()
  const responseListeners = new Set<(value: unknown) => void>()
  const liveRequest = {
    method: () => 'POST',
    url: () => KIMI_CHAT_URL,
    postData: () => null,
  }
  const locator = (selector: string) => ({
    count: async () => {
      if (selector === '.chat-editor .send-button-container.stop') {
        if (!addedCapturedRequests) {
          addedCapturedRequests = true
          const startedAt = Date.now()
          capturedEntries = [
            {
              id: 5,
              url: KIMI_CHAT_URL,
              method: 'POST',
              startedAt,
              status: 200,
              chunks: [],
              done: false,
              error: null,
            },
            {
              id: 6,
              url: KIMI_CHAT_URL,
              method: 'POST',
              startedAt,
              status: 200,
              chunks: [],
              done: false,
              error: null,
            },
          ]
        }
        return 0
      }
      return 1
    },
    first() {
      return this
    },
    nth() {
      return this
    },
    last() {
      return this
    },
    isEnabled: async () => true,
    getAttribute: async () => null,
    isVisible: async () => true,
    click: async () => {
      if (!selector.includes(':not(.disabled)')) return
      currentUrl = 'https://www.kimi.com/chat/live-capture-ambiguity'
      requestListeners.forEach((listener) => listener(liveRequest))
      responseListeners.forEach((listener) =>
        listener({
          request: () => liveRequest,
          status: () => 200,
          text: async () =>
            completedKimiResponse('assistant-live', 'live answer'),
        })
      )
    },
  })
  const adapter = createTestKimiAdapter()
  adapter.page = {
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
  adapter.pendingTextVal = 'live with captured ambiguity prompt'
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getCapturedFetchEntries = async () => capturedEntries
  adapter.getSubmitResponseTimeoutMs = () => 1_000
  adapter.reportCapturedSubmitActivity = () => {}
  adapter.setSubmitTextReporter(async (text) => {
    emittedText.push(text)
  })

  await assert.rejects(
    adapter.submit(),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_submit_outcome_unknown'
  )
  assert.equal(addedCapturedRequests, true)
  assert.deepEqual(emittedText, [])
})

test('KimiAdapter reads and idempotently changes a reordered search toggle', async () => {
  const controls = createKimiCapabilityPage({ onOptionIndex: 1 })
  const adapter = createTestKimiAdapter()
  adapter.page = controls.page

  assert.equal(await adapter.hasToggleCapability('search'), true)
  assert.equal(controls.menuOpen, false)
  assert.equal(await adapter.getToggleState('search'), 'off')

  assert.equal(await adapter.setToggleState('search', 'on'), 'on')
  assert.equal(controls.state, 'on')
  assert.equal(controls.searchClicks, 1)
  assert.equal(controls.menuOpen, false)

  assert.equal(await adapter.setToggleState('search', 'on'), 'on')
  assert.equal(controls.searchClicks, 1)

  assert.equal(await adapter.setToggleState('search', 'off'), 'off')
  assert.equal(controls.state, 'off')
  assert.equal(controls.searchClicks, 2)
  assert.equal(controls.menuOpen, false)
  assert.ok(controls.escapePresses > 0)
})

test('KimiAdapter hides missing, ambiguous, disabled, and unknown toggles', async () => {
  for (const controls of [
    createKimiCapabilityPage({ triggerCount: 0 }),
    createKimiCapabilityPage({ triggerCount: 2 }),
    createKimiCapabilityPage({ triggerVisible: false }),
    createKimiCapabilityPage({ triggerEnabled: false }),
    createKimiCapabilityPage({ searchCount: 0 }),
    createKimiCapabilityPage({ searchCount: 2 }),
    createKimiCapabilityPage({ searchVisible: false }),
    createKimiCapabilityPage({ searchEnabled: false }),
    createKimiCapabilityPage({ optionCount: 1 }),
    createKimiCapabilityPage({ optionCount: 3 }),
    createKimiCapabilityPage({ optionVisible: false }),
    createKimiCapabilityPage({ optionEnabled: false }),
    createKimiCapabilityPage({ selectedChecks: 'none' }),
    createKimiCapabilityPage({ selectedChecks: 'both' }),
    createKimiCapabilityPage({ selectedChecks: 'hidden' }),
    createKimiCapabilityPage({ storageValue: null }),
    createKimiCapabilityPage({ storageValue: 'invalid' }),
  ]) {
    const adapter = createTestKimiAdapter()
    adapter.page = controls.page

    assert.equal(await adapter.hasToggleCapability('search'), false)
    assert.equal(controls.menuOpen, false)
  }

  const controls = createKimiCapabilityPage()
  const adapter = createTestKimiAdapter()
  adapter.page = controls.page
  assert.equal(await adapter.hasToggleCapability('thinking'), false)
  assert.equal(controls.triggerClicks, 0)
})

test('KimiAdapter closes the toolkit through the Composer when Escape is ignored', async () => {
  const controls = createKimiCapabilityPage({ escapeClosesMenu: false })
  const adapter = createTestKimiAdapter()
  adapter.page = controls.page

  assert.equal(await adapter.hasToggleCapability('search'), true)
  assert.equal(controls.menuOpen, false)
  assert.ok(controls.composerClicks > 0)
})

test('KimiAdapter reports a toolkit open timeout instead of hiding the capability', async () => {
  const controls = createKimiCapabilityPage({ toolkitOpens: false })
  const adapter = createTestKimiAdapter()
  adapter.page = controls.page
  Object.assign(adapter, { getCapabilityUiTimeoutMs: () => 1 })

  await assert.rejects(
    adapter.hasToggleCapability('search'),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_toolkit_open_timeout'
  )
  assert.equal(controls.menuOpen, false)
})

test('KimiAdapter rejects search state changes that the page does not apply', async () => {
  const controls = createKimiCapabilityPage({ applyClicks: false })
  const adapter = createTestKimiAdapter()
  adapter.page = controls.page

  await assert.rejects(
    adapter.setToggleState('search', 'on'),
    (error: unknown) =>
      error instanceof Error &&
      'detailCode' in error &&
      error.detailCode === 'kimi_search_state_unverified'
  )
  assert.equal(controls.menuOpen, false)
})

test('KimiAdapter stopGeneration clicks only one visible stop control', async () => {
  let clicks = 0
  const stop = {
    count: async () => 1,
    first() {
      return this
    },
    nth() {
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
          nth() {
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
          nth() {
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
          nth() {
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
          nth() {
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
