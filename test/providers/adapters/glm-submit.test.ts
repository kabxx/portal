import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../../src/providers/adapters/adapter-base.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'
import {
  getProviderDefinition,
  joinCssLocatorCandidates,
} from '../../../src/providers/provider-definition-pack.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const GLM_COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions'
const GLM_LOCATORS = getProviderDefinition('glm').locators

type GlmAdapterHarness = Pick<GlmAdapter, keyof GlmAdapter> & {
  page: unknown
  conversationIdVal: string | null
  parseResponse(raw: string): unknown
  isTargetCompletionRequest(request: {
    method(): string
    url(): string
  }): boolean
  getLatestCapturedFetchBody: unknown
  readCurrentStreamedResponseText(startIndex: number): Promise<string>
  getSubmitRequestStartGraceMs(): number
}

function createTestGlmAdapter(): GlmAdapterHarness {
  const adapter = new GlmAdapter(createBrowserContextStub())
  const candidate: object = adapter
  if (
    !('parseResponse' in candidate) ||
    typeof candidate.parseResponse !== 'function' ||
    !('isTargetCompletionRequest' in candidate) ||
    typeof candidate.isTargetCompletionRequest !== 'function' ||
    !('getLatestCapturedFetchBody' in candidate) ||
    typeof candidate.getLatestCapturedFetchBody !== 'function' ||
    !('readCurrentStreamedResponseText' in candidate) ||
    typeof candidate.readCurrentStreamedResponseText !== 'function'
  ) {
    throw new Error('GLM adapter is missing submit harness methods.')
  }
  const parseResponse = candidate.parseResponse
  const isTargetCompletionRequest = candidate.isTargetCompletionRequest
  const readCurrentStreamedResponseText =
    candidate.readCurrentStreamedResponseText

  return Object.assign(adapter, {
    page: undefined,
    conversationIdVal: null,
    parseResponse(raw: string): unknown {
      const parsed: unknown = Reflect.apply(parseResponse, adapter, [raw])
      return parsed
    },
    isTargetCompletionRequest(request: {
      method(): string
      url(): string
    }): boolean {
      const matched: unknown = Reflect.apply(
        isTargetCompletionRequest,
        adapter,
        [request]
      )
      if (typeof matched !== 'boolean') {
        throw new Error('GLM request matcher returned a non-boolean value.')
      }
      return matched
    },
    getLatestCapturedFetchBody: candidate.getLatestCapturedFetchBody,
    async readCurrentStreamedResponseText(startIndex: number): Promise<string> {
      const text: unknown = await Promise.resolve(
        Reflect.apply(readCurrentStreamedResponseText, adapter, [startIndex])
      )
      if (typeof text !== 'string') {
        throw new Error('GLM streamed response reader returned a non-string.')
      }
      return text
    },
    getSubmitRequestStartGraceMs: (): number => 5,
  })
}

test('GlmAdapter parser keeps answer deltas and hides thinking deltas', () => {
  const adapter = createTestGlmAdapter()
  const raw = [
    'data: {"type":"chat:completion","data":{"delta_content":"hidden","phase":"thinking"}}',
    'data: {"type":"chat:completion","data":{"delta_content":"Hello ","phase":"answer"}}',
    'data: {"type":"chat:completion","data":{"phase":"other","usage":{"total_tokens":3}}}',
    'data: {"type":"chat:completion","data":{"delta_content":"world","phase":"answer"}}',
    'data: {"type":"chat:completion","data":{"phase":"done","done":true}}',
  ].join('\n\n')

  assert.deepEqual(adapter.parseResponse(raw), {
    text: 'Hello world',
    isFinished: true,
    error: null,
  })
})

test('GlmAdapter parser reads concurrency errors and the DONE sentinel', () => {
  const adapter = createTestGlmAdapter()
  const raw = [
    'data: {"type":"chat:completion","data":{"content":"","done":true,"error":{"code":"MODEL_CONCURRENCY_LIMIT","detail":"busy"}}}',
    'data: {"data":"[DONE]"}',
  ].join('\n\n')

  assert.deepEqual(adapter.parseResponse(raw), {
    text: '',
    isFinished: true,
    error: {
      code: 'MODEL_CONCURRENCY_LIMIT',
      detail: 'busy',
    },
  })
})

test('GlmAdapter parser accepts the JSON DONE sentinel without an event type', () => {
  const adapter = createTestGlmAdapter()
  const raw = [
    'data: {"type":"chat:completion","data":{"delta_content":"done","phase":"answer"}}',
    'data: {"data":"[DONE]"}',
  ].join('\n\n')

  assert.deepEqual(adapter.parseResponse(raw), {
    text: 'done',
    isFinished: true,
    error: null,
  })
})

test('GlmAdapter matches captured completion URLs with query parameters', async () => {
  const adapter = createTestGlmAdapter()
  const raw =
    'data: {"type":"chat:completion","data":{"delta_content":"partial","phase":"answer"}}'
  adapter.getLatestCapturedFetchBody = async (
    startIndex: number,
    predicate: (entry: {
      id: number
      url: string
      method: string
      status: number | null
      chunks: string[]
      done: boolean
      error: string | null
    }) => boolean
  ) => {
    assert.equal(startIndex, 4)
    assert.equal(
      predicate({
        id: 1,
        url: '/api/v2/chat/completions?conversation_id=one',
        method: 'POST',
        status: 200,
        chunks: [raw],
        done: false,
        error: null,
      }),
      true
    )
    assert.equal(
      predicate({
        id: 2,
        url: 'https://example.com/api/v2/chat/completions?conversation_id=one',
        method: 'POST',
        status: 200,
        chunks: [raw],
        done: false,
        error: null,
      }),
      false
    )
    return raw
  }

  assert.equal(await adapter.readCurrentStreamedResponseText(4), 'partial')
  assert.equal(
    adapter.isTargetCompletionRequest(
      createCompletionRequest(`${GLM_COMPLETION_URL}?conversation_id=one`)
    ),
    true
  )
})

test('GlmAdapter.submit returns answer text when the visible send button is disabled after completion', async () => {
  const adapter = createTestGlmAdapter()
  adapter.conversationIdVal = null
  const raw = [
    'data: {"type":"chat:completion","data":{"delta_content":"Hello ","phase":"answer"}}',
    'data: {"type":"chat:completion","data":{"delta_content":"world","phase":"answer"}}',
    'data: {"type":"chat:completion","data":{"phase":"done","done":true}}',
  ].join('\n\n')
  const sendButton = createButton({
    click: async () => {
      sendButton.enabled = false
      const request = createCompletionRequest()
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => raw,
      })
    },
  })
  const page = createGlmPage({ sendButton })
  adapter.page = page

  const result = await adapter.submit()

  assert.equal(result, 'Hello world')
  assert.equal(sendButton.enabled, false)
  assert.equal(adapter.conversationId, 'conversation-1')
})

test('GlmAdapter.submit emits answer snapshots before the final response', async () => {
  const adapter = createTestGlmAdapter()
  adapter.getSubmitRequestStartGraceMs = () => 50
  adapter.conversationIdVal = null
  const snapshots: string[] = []
  let currentText = 'partial answer'
  adapter.readCurrentStreamedResponseText = async () => currentText
  const raw = [
    'data: {"type":"chat:completion","data":{"delta_content":"partial answer complete","phase":"answer"}}',
    'data: {"type":"chat:completion","data":{"phase":"done","done":true}}',
  ].join('\n\n')
  const sendButton = createButton({
    click: async () => {
      setTimeout(() => {
        currentText = 'partial answer complete'
      }, 15)
      setTimeout(() => {
        const request = createCompletionRequest()
        page.emit('request', request)
        page.emit('response', {
          request: () => request,
          text: async () => raw,
        })
      }, 30)
    },
  })
  const page = createGlmPage({ sendButton })
  adapter.page = page
  adapter.setSubmitTextReporter(async (text: string) => {
    snapshots.push(text)
  })

  const result = await adapter.submit()

  assert.equal(result, 'partial answer complete')
  assert.equal(snapshots[0], 'partial answer')
  assert.equal(snapshots.at(-1), 'partial answer complete')
})

test('GlmAdapter.submit reports concurrency errors as rate limits', async () => {
  const adapter = createTestGlmAdapter()
  adapter.conversationIdVal = null
  const raw =
    'data: {"type":"chat:completion","data":{"content":"","done":true,"error":{"code":"MODEL_CONCURRENCY_LIMIT","detail":"busy"}}}'
  const sendButton = createButton({
    click: async () => {
      const request = createCompletionRequest()
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => raw,
      })
    },
  })
  const page = createGlmPage({ sendButton })
  adapter.page = page

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'rate_limit' &&
      error.detailCode === 'glm_stream_error_model_concurrency_limit'
  )
})

test('GlmAdapter changes model through data-value menu items', async () => {
  const adapter = createTestGlmAdapter()
  const modelItems = [createButton(), createButton(), createButton()]
  const page = createGlmPage({ modelItems })
  adapter.page = page

  await adapter.changeModel('2')

  assert.equal(page.modelTrigger.clicks, 1)
  assert.deepEqual(
    modelItems.map((item) => item.clicks),
    [0, 1, 0]
  )
  await assert.rejects(
    adapter.changeModel('unknown'),
    /GLM does not support model "unknown"\./
  )
  await assert.rejects(adapter.changeModel('4'), /GLM does not have model 4\./)
})

test('GlmAdapter rejects unscoped model options from multiple groups', async () => {
  const adapter = createTestGlmAdapter()
  adapter.page = createGlmPage({
    visibleModelMenuCount: 1,
    globalModelParentCount: 2,
  })

  await assert.rejects(adapter.changeModel('1'), /options were ambiguous/)
})

test('GlmAdapter reads and sets thinking/search toggle states', async () => {
  const adapter = createTestGlmAdapter()
  const thinkingButton = createToggleButton('data-autothink', 'false')
  const searchButton = createToggleButton('data-active', 'true')
  adapter.page = createGlmPage({ thinkingButton, searchButton })

  assert.equal(await adapter.hasToggleCapability('thinking'), true)
  assert.equal(await adapter.hasToggleCapability('search'), true)
  assert.equal(await adapter.getToggleState('thinking'), 'off')
  assert.equal(await adapter.getToggleState('search'), 'on')

  assert.equal(await adapter.setToggleState('thinking', 'on'), 'on')
  assert.equal(thinkingButton.clicks, 1)
  assert.equal(await adapter.setToggleState('search', 'on'), 'on')
  assert.equal(searchButton.clicks, 0)
})

test('GlmAdapter enables advanced search dependencies and only disables advanced search', async () => {
  const adapter = createTestGlmAdapter()
  const thinkingButton = createToggleButton('data-autothink', 'false')
  const searchButton = createToggleButton('data-active', 'false')
  const advancedSearchSwitch = createAdvancedSearchSwitch('false')
  adapter.page = createGlmPage({
    thinkingButton,
    searchButton,
    advancedSearchSwitch,
  })

  assert.equal(await adapter.hasToggleCapability('advanced_search'), true)
  assert.equal(await adapter.getToggleState('advanced_search'), 'off')

  assert.equal(await adapter.setToggleState('advanced_search', 'on'), 'on')
  assert.equal(await adapter.getToggleState('thinking'), 'on')
  assert.equal(await adapter.getToggleState('search'), 'on')
  assert.equal(thinkingButton.clicks, 1)
  assert.equal(searchButton.clicks, 1)
  assert.equal(advancedSearchSwitch.clicks, 1)

  assert.equal(await adapter.setToggleState('advanced_search', 'off'), 'off')
  assert.equal(await adapter.getToggleState('thinking'), 'on')
  assert.equal(await adapter.getToggleState('search'), 'on')
  assert.equal(thinkingButton.clicks, 1)
  assert.equal(searchButton.clicks, 1)
  assert.equal(advancedSearchSwitch.clicks, 2)
  assert.ok(searchButton.hovers > 0)
  assert.ok(
    searchButton.hoverOptions.every(
      (options) =>
        typeof options === 'object' && options !== null && !('force' in options)
    )
  )
})

test('GlmAdapter reports advanced search unavailable when normal hover fails', async () => {
  const adapter = createTestGlmAdapter()
  const searchButton = createToggleButton('data-active', 'false', {
    hoverFails: true,
  })
  adapter.page = createGlmPage({ searchButton })

  assert.equal(await adapter.hasToggleCapability('advanced_search'), false)
  assert.equal(searchButton.hoverOptions.length, 3)
})

test('GlmAdapter attaches text and files through stable composer controls', async () => {
  const adapter = createTestGlmAdapter()
  const uploadButton = createButton()
  const page = createGlmPage({ uploadButton })
  adapter.page = page

  await adapter.attachText('hello')
  await adapter.attachFile(['C:/tmp/one.txt', 'C:/tmp/two.png'])

  assert.deepEqual(page.insertedTexts, ['hello'])
  assert.equal(uploadButton.clicks, 1)
  assert.deepEqual(page.uploadedFiles, ['C:/tmp/one.txt', 'C:/tmp/two.png'])
})

test('GlmAdapter reports unavailable file upload and clicks the visible stop button', async () => {
  const adapter = createTestGlmAdapter()
  const stopButton = createButton()
  adapter.page = createGlmPage({ stopButton })

  await assert.rejects(
    adapter.attachFile('C:/tmp/one.txt'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message ===
        'GLM file upload is not available in the current conversation.'
  )
  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

function createCompletionRequest(url = GLM_COMPLETION_URL) {
  return {
    method: () => 'POST',
    url: () => url,
    failure: () => null,
  }
}

function createGlmPage({
  sendButton = createButton(),
  uploadButton,
  stopButton,
  thinkingButton,
  searchButton,
  advancedSearchSwitch,
  modelItems = [createButton(), createButton(), createButton()],
  visibleModelMenuCount = 0,
  globalModelParentCount = 1,
}: {
  sendButton?: ReturnType<typeof createButton>
  uploadButton?: ReturnType<typeof createButton>
  stopButton?: ReturnType<typeof createButton>
  thinkingButton?: ReturnType<typeof createToggleButton>
  searchButton?: ReturnType<typeof createToggleButton>
  advancedSearchSwitch?: ReturnType<typeof createAdvancedSearchSwitch>
  modelItems?: ReturnType<typeof createButton>[]
  visibleModelMenuCount?: number
  globalModelParentCount?: number
} = {}) {
  const emitter = new EventEmitter()
  const modelTrigger = createButton()
  const insertedTexts: string[] = []
  const uploadedFiles: string[] = []
  const composer = createButton()
  const missingButton = createButton({ visible: false, enabled: false })
  const modelMenu = {
    isVisible: async () => true,
    locator: (selector: string) => {
      assert.equal(selector, joinCssLocatorCandidates(GLM_LOCATORS.modelItem))
      return {
        count: async () => modelItems.length,
        nth: (index: number) => modelItems[index] ?? missingButton,
      }
    },
  }

  return {
    modelTrigger,
    insertedTexts,
    uploadedFiles,
    bringToFront: async () => undefined,
    mouse: {
      move: async () => undefined,
    },
    locator: (selector: string) => {
      if (selector === '#send-message-button') {
        return createSingleLocator(sendButton)
      }
      if (selector === '[data-dialog-overlay][data-state="open"]') {
        return createSingleLocator(missingButton)
      }
      if (selector === '#chat-input') {
        return createSingleLocator(composer)
      }
      if (selector === '#upload-file-button') {
        return {
          count: async () => (uploadButton === undefined ? 0 : 1),
          first: () => uploadButton ?? missingButton,
        }
      }
      if (selector === joinCssLocatorCandidates(GLM_LOCATORS.modelTrigger)) {
        return createSingleLocator(modelTrigger)
      }
      if (
        selector ===
        joinCssLocatorCandidates(GLM_LOCATORS.modelMenu, ':visible')
      ) {
        return {
          count: async () => visibleModelMenuCount,
          locator: () => ({ count: async () => 0 }),
        }
      }
      if (
        selector ===
        joinCssLocatorCandidates(GLM_LOCATORS.modelItem, ':visible')
      ) {
        return {
          count: async () => modelItems.length,
          nth: (index: number) => modelItems[index] ?? missingButton,
          evaluateAll: async () => globalModelParentCount === 1,
        }
      }
      if (selector === joinCssLocatorCandidates(GLM_LOCATORS.modelMenu)) {
        return {
          last: () => modelMenu,
        }
      }
      if (selector === '.messageInputContainer button.bg-black.rounded-full') {
        return {
          count: async () => (stopButton === undefined ? 0 : 1),
          first: () => stopButton ?? missingButton,
        }
      }
      if (selector === joinCssLocatorCandidates(GLM_LOCATORS.thinkingToggle)) {
        return {
          count: async () => (thinkingButton === undefined ? 0 : 1),
          first: () => thinkingButton ?? missingButton,
        }
      }
      if (selector === joinCssLocatorCandidates(GLM_LOCATORS.searchToggle)) {
        return {
          count: async () => (searchButton === undefined ? 0 : 1),
          first: () => searchButton ?? missingButton,
        }
      }
      if (
        selector === joinCssLocatorCandidates(GLM_LOCATORS.advancedSearchSwitch)
      ) {
        return {
          first: () => advancedSearchSwitch ?? missingButton,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
    keyboard: {
      insertText: async (text: string) => {
        insertedTexts.push(text)
      },
      press: async () => undefined,
    },
    waitForEvent: async (eventName: string) => {
      assert.equal(eventName, 'filechooser')
      return {
        setFiles: async (paths: string | readonly string[]) => {
          uploadedFiles.push(
            ...(typeof paths === 'string' ? [paths] : [...paths])
          )
        },
      }
    },
    url: () => 'https://chat.z.ai/c/conversation-1',
    on: (eventName: string, listener: (...args: unknown[]) => void) => {
      emitter.on(eventName, listener)
    },
    off: (eventName: string, listener: (...args: unknown[]) => void) => {
      emitter.off(eventName, listener)
    },
    emit: (eventName: string, payload: unknown) => {
      emitter.emit(eventName, payload)
    },
  }
}

function createSingleLocator<T>(target: T) {
  return {
    ...target,
    count: async () => 1,
    first: () => target,
  }
}

function createButton({
  visible = true,
  enabled = true,
  click = async () => undefined,
}: {
  visible?: boolean
  enabled?: boolean
  click?: () => Promise<void>
} = {}) {
  const button = {
    visible,
    enabled,
    clicks: 0,
    isVisible: async () => button.visible,
    isEnabled: async () => button.enabled,
    click: async () => {
      button.clicks += 1
      await click()
    },
  }
  return button
}

function createToggleButton(
  attribute: 'data-autothink' | 'data-active',
  initialValue: 'true' | 'false',
  options: { hoverFails?: boolean } = {}
) {
  let value = initialValue
  const button = {
    clicks: 0,
    hovers: 0,
    hoverOptions: [] as unknown[],
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async (name: string) => (name === attribute ? value : null),
    hover: async (hoverOptions?: unknown) => {
      button.hoverOptions.push(hoverOptions)
      if (options.hoverFails) {
        throw new Error('hover failed')
      }
      button.hovers += 1
    },
    locator: (selector: string) => {
      assert.equal(selector, '..')
      return {
        hover: async (hoverOptions?: unknown) => {
          await button.hover(hoverOptions)
        },
      }
    },
    click: async () => {
      button.clicks += 1
      value = value === 'true' ? 'false' : 'true'
    },
  }
  return button
}

function createAdvancedSearchSwitch(initialValue: 'true' | 'false') {
  let value = initialValue
  const button = {
    clicks: 0,
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async (name: string) =>
      name === 'aria-checked' ? value : null,
    waitFor: async () => undefined,
    evaluate: async <T, A>(
      callback: (
        element: {
          disabled: boolean
          getAttribute: (name: string) => string | null
          click: () => void
        },
        arg?: A
      ) => T,
      arg?: A
    ) => {
      const hadHtmlButtonElement = Reflect.has(globalThis, 'HTMLButtonElement')
      const previousHtmlButtonElement: unknown = Reflect.get(
        globalThis,
        'HTMLButtonElement'
      )
      class TestHtmlButtonElement {
        public disabled = false

        public getAttribute(name: string): string | null {
          return name === 'aria-checked' ? value : null
        }

        public click(): void {
          button.clicks += 1
          value = value === 'true' ? 'false' : 'true'
        }
      }
      Reflect.set(globalThis, 'HTMLButtonElement', TestHtmlButtonElement)
      try {
        return callback(new TestHtmlButtonElement(), arg)
      } finally {
        if (hadHtmlButtonElement) {
          Reflect.set(
            globalThis,
            'HTMLButtonElement',
            previousHtmlButtonElement
          )
        } else {
          Reflect.deleteProperty(globalThis, 'HTMLButtonElement')
        }
      }
    },
    click: async () => {
      button.clicks += 1
      value = value === 'true' ? 'false' : 'true'
    },
  }
  return button
}
