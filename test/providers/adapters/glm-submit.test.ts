import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../../src/providers/adapters/adapter-base.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'

const GLM_COMPLETION_URL = 'https://chat.z.ai/api/v2/chat/completions'

function createTestGlmAdapter() {
  const adapter = Object.create(GlmAdapter.prototype) as any
  adapter.getSubmitRequestStartGraceMs = () => 5
  return adapter
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
  let page: ReturnType<typeof createGlmPage>
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
  page = createGlmPage({ sendButton })
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
  let page: ReturnType<typeof createGlmPage>
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
  page = createGlmPage({ sendButton })
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
  let page: ReturnType<typeof createGlmPage>
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
  page = createGlmPage({ sendButton })
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
}: {
  sendButton?: ReturnType<typeof createButton>
  uploadButton?: ReturnType<typeof createButton>
  stopButton?: ReturnType<typeof createButton>
  thinkingButton?: ReturnType<typeof createToggleButton>
  searchButton?: ReturnType<typeof createToggleButton>
  advancedSearchSwitch?: ReturnType<typeof createAdvancedSearchSwitch>
  modelItems?: ReturnType<typeof createButton>[]
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
      assert.equal(selector, 'button[data-value]')
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
      if (selector === 'button[id^="model-selector-"]') {
        return createSingleLocator(modelTrigger)
      }
      if (selector === '[data-dropdown-menu-content]') {
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
      if (selector === 'button[data-autothink]') {
        return {
          count: async () => (thinkingButton === undefined ? 0 : 1),
          first: () => thinkingButton ?? missingButton,
        }
      }
      if (selector === 'button[data-active]:has(svg[viewBox="0 0 15 15"])') {
        return {
          count: async () => (searchButton === undefined ? 0 : 1),
          first: () => searchButton ?? missingButton,
        }
      }
      if (
        selector ===
        '[data-tooltip-content] button[role="switch"][data-switch-root]'
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
          uploadedFiles.push(...(Array.isArray(paths) ? paths : [paths]))
        },
      }
    },
    url: () => 'https://chat.z.ai/c/conversation-1',
    on: (eventName: string, listener: (...args: any[]) => void) => {
      emitter.on(eventName, listener)
    },
    off: (eventName: string, listener: (...args: any[]) => void) => {
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
  initialValue: 'true' | 'false'
) {
  let value = initialValue
  const button = {
    clicks: 0,
    hovers: 0,
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async (name: string) => (name === attribute ? value : null),
    hover: async () => {
      button.hovers += 1
    },
    locator: (selector: string) => {
      assert.equal(selector, '..')
      return {
        hover: button.hover,
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
    ) =>
      callback(
        {
          disabled: false,
          getAttribute: (name: string) =>
            name === 'aria-checked' ? value : null,
          click: () => {
            button.clicks += 1
            value = value === 'true' ? 'false' : 'true'
          },
        },
        arg
      ),
    click: async () => {
      button.clicks += 1
      value = value === 'true' ? 'false' : 'true'
    },
  }
  return button
}
