import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ProviderAdapterError } from '../../../src/providers/adapters/adapter-base.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

type GeminiAdapterHarness = Pick<GeminiAdapter, keyof GeminiAdapter> & {
  page: unknown
  lastParsedResponse: unknown
  parseResponse: unknown
  readCurrentStreamedResponseText: unknown
  getSubmitRequestStartGraceMs(): number
  getSubmitBlockedWarningIntervalMs(): number
  getSubmitResponseTimeoutMs(): number
}

function createTestGeminiAdapter(): GeminiAdapterHarness {
  return Object.assign(new GeminiAdapter(createBrowserContextStub()), {
    page: undefined,
    lastParsedResponse: null,
    parseResponse: async (): Promise<unknown> => {
      throw new Error('Response parser was not configured for this test.')
    },
    readCurrentStreamedResponseText: async (): Promise<string> => {
      throw new Error(
        'Streamed response reader was not configured for this test.'
      )
    },
    getSubmitRequestStartGraceMs: (): number => 30_000,
    getSubmitBlockedWarningIntervalMs: (): number => 30_000,
    getSubmitResponseTimeoutMs: (): number => 30_000,
  })
}

test('GeminiAdapter normalizes conversationId and conversationUrl at the source', () => {
  const adapter = createTestGeminiAdapter()

  adapter.lastParsedResponse = {
    conversationId: 'c_7807b33e16f78ea0',
    text: 'done',
    isFinished: true,
  }

  assert.equal(adapter.conversationId, '7807b33e16f78ea0')
  assert.equal(
    adapter.conversationUrl,
    'https://gemini.google.com/app/7807b33e16f78ea0'
  )
})

test('GeminiAdapter.submit emits periodic warnings while waiting for the request to start and still accepts a later response', async () => {
  const adapter = createTestGeminiAdapter()
  const warnings: string[] = []
  adapter.lastParsedResponse = null
  adapter.parseResponse = async () => ({
    text: 'Gemini recovered after verification.',
    isFinished: true,
  })

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => undefined,
  }
  const microphoneButton = {
    isVisible: async () => true,
    isEnabled: async () => true,
    first: () => microphoneButton,
  }
  const page = createGeminiPage(sendButton, microphoneButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async (message: string) => {
    warnings.push(message)
  })
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.getSubmitBlockedWarningIntervalMs = () => 10
  const submitPromise = adapter.submit()
  await new Promise((resolve) => setTimeout(resolve, 35))

  assert.ok(
    warnings.some((message) =>
      message.includes('Gemini submit has not started a provider request yet.')
    )
  )

  const request = {
    method: () => 'POST',
    url: () =>
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    failure: () => null,
  }
  page.emit('request', request)
  page.emit('response', {
    request: () => request,
    status: () => 200,
    url: () =>
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    text: async () => 'raw',
  })

  const result = await submitPromise
  assert.equal(result, 'Gemini recovered after verification.')
  const warningCountAfterRecovery = warnings.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(warnings.length, warningCountAfterRecovery)
})

test('GeminiAdapter.submit contains asynchronous response parser failures', async () => {
  const adapter = createTestGeminiAdapter()
  adapter.lastParsedResponse = null
  adapter.parseResponse = async () => {
    throw new Error('parser failed')
  }
  const request = {
    method: () => 'POST',
    url: () =>
      'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    failure: () => null,
  }
  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        status: () => 200,
        text: async () => 'raw',
      })
    },
  }
  const microphoneButton = {
    isVisible: async () => true,
    isEnabled: async () => true,
    first: () => microphoneButton,
  }
  const page = createGeminiPage(sendButton, microphoneButton)
  adapter.page = page
  adapter.getSubmitRequestStartGraceMs = () => 5
  adapter.getSubmitResponseTimeoutMs = () => 20

  const assertion = assert.rejects(adapter.submit(), (error: unknown) => {
    assert.ok(error instanceof ProviderAdapterError)
    assert.equal(error.message, 'Action failed during submit')
    assert.ok(error.cause instanceof Error)
    assert.equal(error.cause.message, 'parser failed')
    return true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assertion

  assert.equal(page.listenerCount('response'), 0)
})

test('GeminiAdapter.submit emits assistant stream snapshots while the response is growing', async () => {
  const adapter = createTestGeminiAdapter()
  const streamedTexts: string[] = []
  adapter.lastParsedResponse = null
  let currentStreamText = 'partial stream'
  adapter.readCurrentStreamedResponseText = async () => currentStreamText
  adapter.parseResponse = async () => ({
    text: 'partial stream complete',
    isFinished: true,
  })

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      setTimeout(() => {
        currentStreamText = 'partial stream complete'
      }, 15)
      setTimeout(() => {
        const request = {
          method: () => 'POST',
          url: () =>
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          failure: () => null,
        }
        page.emit('request', request)
        page.emit('response', {
          request: () => request,
          status: () => 200,
          url: () =>
            'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          text: async () => 'raw',
        })
      }, 30)
    },
  }
  const microphoneButton = {
    isVisible: async () => true,
    isEnabled: async () => true,
    first: () => microphoneButton,
  }
  const page = createGeminiPage(sendButton, microphoneButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => undefined)
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })
  adapter.getSubmitRequestStartGraceMs = () => 50
  adapter.getSubmitBlockedWarningIntervalMs = () => 50

  const result = await adapter.submit()

  assert.equal(result, 'partial stream complete')
  assert.deepEqual(streamedTexts, ['partial stream', 'partial stream complete'])
})

test('GeminiAdapter lists action capabilities by icon name without reading labels', async () => {
  const adapter = createTestGeminiAdapter()
  adapter.page = createGeminiCapabilityPage([
    { name: 'image_create' },
    { name: 'canvas', disabled: true },
    { name: '' },
    { name: 'image_create' },
  ])

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'image_create', state: 'available' },
    { name: 'canvas', state: 'disabled' },
  ])
})

test('GeminiAdapter selects action capabilities by icon name', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([
    { name: 'image_create' },
    { name: 'canvas', disabled: true },
  ])
  adapter.page = page

  assert.equal(await adapter.selectActionCapability('image_create'), 'selected')
  assert.deepEqual(page.events, ['click:trigger', 'click:image_create'])

  assert.equal(await adapter.selectActionCapability('canvas'), 'disabled')
  assert.equal(
    await adapter.selectActionCapability('video_create'),
    'unavailable'
  )
})

test('GeminiAdapter clears selected action capabilities', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }], {
    selected: true,
  })
  adapter.page = page

  await adapter.clearActionCapability()

  assert.deepEqual(page.events, ['click:selected-clear'])
})

test('GeminiAdapter clearActionCapability is a no-op without a selected capability', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }])
  adapter.page = page

  await adapter.clearActionCapability()

  assert.deepEqual(page.events, [])
})

test('GeminiAdapter clears selected capabilities before selecting another', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }], {
    selected: true,
  })
  adapter.page = page

  assert.equal(await adapter.selectActionCapability('image_create'), 'selected')

  assert.deepEqual(page.events, [
    'click:selected-clear',
    'click:trigger',
    'click:image_create',
  ])
})

test('GeminiAdapter closes the capability menu after listing', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }])
  adapter.page = page

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'image_create', state: 'available' },
  ])
  assert.deepEqual(page.events, ['click:trigger', 'click:trigger'])

  assert.equal(await adapter.selectActionCapability('image_create'), 'selected')

  assert.deepEqual(page.events, [
    'click:trigger',
    'click:trigger',
    'click:trigger',
    'click:image_create',
  ])
})

test('GeminiAdapter expands more tools before reading capabilities', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }], {
    moreCapabilities: [{ name: 'guided_learning' }],
  })
  adapter.page = page

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'image_create', state: 'available' },
    { name: 'guided_learning', state: 'available' },
  ])
  assert.deepEqual(page.events, [
    'click:trigger',
    'click:more-tools',
    'click:trigger',
  ])
})

test('GeminiAdapter expands more tools before selecting capabilities', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiCapabilityPage([{ name: 'image_create' }], {
    moreCapabilities: [{ name: 'guided_learning' }],
  })
  adapter.page = page

  assert.equal(
    await adapter.selectActionCapability('guided_learning'),
    'selected'
  )
  assert.deepEqual(page.events, [
    'click:trigger',
    'click:more-tools',
    'click:guided_learning',
  ])
})

test('GeminiAdapter changes model through the mode menu', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiModelPage()
  adapter.page = page

  await adapter.changeModel('3')

  assert.deepEqual(page.events, [
    'click:model-trigger',
    'click:model-item:2',
    'click:model-trigger',
    'click:model-trigger',
  ])
})

test('GeminiAdapter enables model extension only when requested', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiModelPage()
  adapter.page = page

  await adapter.changeModel('2+extended')

  assert.deepEqual(page.events, [
    'click:model-trigger',
    'click:model-item:1',
    'click:model-trigger',
    'click:model-item:4',
  ])
  assert.equal(page.isExtended(), true)
})

test('GeminiAdapter keeps selected model extension when requested', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiModelPage({ extended: true })
  adapter.page = page

  await adapter.changeModel('2+extended')

  assert.deepEqual(page.events, [
    'click:model-trigger',
    'click:model-item:1',
    'click:model-trigger',
    'click:model-trigger',
  ])
  assert.equal(page.isExtended(), true)
})

test('GeminiAdapter disables model extension when it is not requested', async () => {
  const adapter = createTestGeminiAdapter()
  const page = createGeminiModelPage({ extended: true })
  adapter.page = page

  await adapter.changeModel('1')

  assert.deepEqual(page.events, [
    'click:model-trigger',
    'click:model-item:0',
    'click:model-trigger',
    'click:model-item:4',
  ])
  assert.equal(page.isExtended(), false)
})

test('GeminiAdapter rejects unsupported model names', async () => {
  const adapter = createTestGeminiAdapter()
  adapter.page = createGeminiModelPage()

  await assert.rejects(
    adapter.changeModel('3.1-pro'),
    /Gemini does not support model "3\.1-pro"\./
  )

  await assert.rejects(
    adapter.changeModel('5'),
    /Gemini does not have model 5\./
  )
})

test('GeminiAdapter.stopGeneration clicks the direct child stop button when present', async () => {
  const adapter = createTestGeminiAdapter()
  const stopButton = createStopButton()
  adapter.page = createGeminiPage(
    createStopButton(),
    {
      isVisible: async () => true,
      isEnabled: async () => true,
      first: () => ({}),
    },
    stopButton
  )

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('GeminiAdapter.stopGeneration is a no-op when the stop button is missing', async () => {
  const adapter = createTestGeminiAdapter()
  adapter.page = createGeminiPage(
    createStopButton(),
    {
      isVisible: async () => true,
      isEnabled: async () => true,
      first: () => ({}),
    },
    null
  )

  await adapter.stopGeneration()
})

function createGeminiPage(
  sendButton: {
    isEnabled: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    click: () => Promise<void>
  },
  microphoneButton: {
    isVisible: () => Promise<boolean>
    isEnabled: () => Promise<boolean>
    first: () => unknown
  },
  stopButton?: ReturnType<typeof createStopButton> | null
) {
  const emitter = new EventEmitter()

  return {
    locator: (selector: string) => {
      if (selector === '[data-test-id="send-button-container"] button') {
        return {
          first: () => sendButton,
        }
      }
      if (
        selector ===
        'button.speech_dictation_mic_button, [data-node-type="speech_dictation_mic_button"] .speech_dictation_mic_button, speech-dictation-mic-button .speech_dictation_mic_button'
      ) {
        return {
          count: async () => 1,
          first: () => microphoneButton,
        }
      }
      if (selector === '[data-test-id="send-button-container"]') {
        return createGeminiStopContainer(stopButton ?? null)
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
    on: (eventName: string, listener: (...args: unknown[]) => void) => {
      emitter.on(eventName, listener)
    },
    off: (eventName: string, listener: (...args: unknown[]) => void) => {
      emitter.off(eventName, listener)
    },
    emit: (eventName: string, payload: unknown) => {
      emitter.emit(eventName, payload)
    },
    listenerCount: (eventName: string) => emitter.listenerCount(eventName),
  }
}

function createGeminiStopContainer(
  stopButton: ReturnType<typeof createStopButton> | null
) {
  return {
    locator: (selector: string) => {
      if (!selector.startsWith('xpath=./gem-icon-button')) {
        throw new Error(`Unexpected stop icon selector: ${selector}`)
      }
      return {
        locator: (buttonSelector: string) => {
          if (buttonSelector !== 'xpath=./button') {
            throw new Error(
              `Unexpected stop button selector: ${buttonSelector}`
            )
          }
          return createOptionalLocator(stopButton)
        },
      }
    },
  }
}

function createOptionalLocator<
  T extends {
    isVisible: () => Promise<boolean>
    isEnabled: () => Promise<boolean>
    click: () => Promise<void>
  },
>(target: T | null) {
  const missing = {
    isVisible: async () => false,
    isEnabled: async () => false,
    click: async () => {
      throw new Error('Missing locator target.')
    },
  }
  return {
    count: async () => (target === null ? 0 : 1),
    first: () => target ?? missing,
  }
}

function createStopButton() {
  const button = {
    clicks: 0,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      button.clicks += 1
    },
  }
  return button
}

function createGeminiModelPage({ extended = false, itemCount = 5 } = {}) {
  const events: string[] = []
  let menuOpen = false
  let extensionEnabled = extended
  const trigger = {
    click: async () => {
      events.push('click:model-trigger')
      menuOpen = !menuOpen
    },
    first: () => trigger,
  }
  const secondaryText = {
    first: () => secondaryText,
    textContent: async () => (extensionEnabled ? '扩展' : ''),
  }
  const menuItems = Array.from({ length: itemCount }, (_, index) => ({
    getAttribute: async (name: string) => {
      if (name !== 'aria-checked' || index !== menuItems.length - 1) {
        return null
      }
      return extensionEnabled ? 'true' : 'false'
    },
    click: async () => {
      events.push(`click:model-item:${index}`)
      if (index === menuItems.length - 1) {
        extensionEnabled = !extensionEnabled
      }
      menuOpen = false
    },
  }))
  const modelMenu = {
    last: () => modelMenu,
    isVisible: async () => menuOpen,
    locator: (selector: string) => {
      if (selector !== 'gem-menu-item') {
        throw new Error(`Unexpected model menu selector: ${selector}`)
      }
      return {
        count: async () => menuItems.length,
        nth: (index: number) => menuItems[index],
      }
    },
  }

  return {
    events,
    isExtended: () => extensionEnabled,
    locator: (selector: string) => {
      if (selector === '[data-test-id="bard-mode-menu-button"]') {
        return trigger
      }
      if (
        selector ===
        'button[data-test-id="bard-mode-menu-button"] span.picker-secondary-text'
      ) {
        return secondaryText
      }
      if (selector === 'gem-menu[data-test-id="gem-mode-menu"]') {
        return modelMenu
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }
}

function createGeminiCapabilityPage(
  capabilities: { name: string; disabled?: boolean }[],
  {
    moreCapabilities = [],
    selected = false,
  }: {
    moreCapabilities?: { name: string; disabled?: boolean }[]
    selected?: boolean
  } = {}
) {
  const events: string[] = []
  let menuOpen = false
  let moreToolsOpen = false
  let hasSelected = selected
  const trigger = {
    count: async () => 1,
    first: () => trigger,
    click: async () => {
      events.push('click:trigger')
      menuOpen = !menuOpen
    },
  }
  const createButton = (capability: { name: string; disabled?: boolean }) => ({
    getAttribute: async (name: string) =>
      name === 'aria-disabled' && capability.disabled ? 'true' : null,
    click: async () => {
      events.push(`click:${capability.name}`)
    },
    locator: (selector: string) => {
      if (selector !== '[data-mat-icon-name]') {
        throw new Error(`Unexpected capability icon selector: ${selector}`)
      }
      const icon = {
        first: () => icon,
        getAttribute: async (name: string) =>
          name === 'data-mat-icon-name' ? capability.name : null,
      }
      return icon
    },
  })
  const buttons = capabilities.map(createButton)
  const moreButtons = moreCapabilities.map(createButton)
  const moreToolsButton = {
    count: async () => (moreCapabilities.length > 0 ? 1 : 0),
    first: () => moreToolsButton,
    isVisible: async () => moreCapabilities.length > 0 && menuOpen,
    getAttribute: async (name: string) =>
      name === 'aria-disabled' ? 'false' : null,
    click: async () => {
      events.push('click:more-tools')
      moreToolsOpen = true
    },
  }
  const selectedButton = {
    count: async () => (hasSelected ? 1 : 0),
    first: () => selectedButton,
    isVisible: async () => hasSelected,
    click: async () => {
      events.push('click:selected-clear')
      hasSelected = false
    },
  }

  return {
    events,
    locator: (selector: string) => {
      if (selector === 'div.has-model-picker button') {
        return trigger
      }
      if (selector === 'button[role="menuitemcheckbox"]') {
        const visibleButtons =
          menuOpen && moreToolsOpen ? [...buttons, ...moreButtons] : buttons
        return {
          count: async () => (menuOpen ? visibleButtons.length : 0),
          nth: (index: number) => visibleButtons[index],
        }
      }
      if (selector === 'button[data-test-id="more-tools-button"]') {
        return moreToolsButton
      }
      if (
        selector ===
        'gem-button[data-test-id="deselect-drawer-item-gem-button"] > button'
      ) {
        return selectedButton
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }
}
