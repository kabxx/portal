import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const DOUBAO_DESKTOP_PROMOTION_CLOSE_SELECTOR =
  'xpath=//img[contains(@src, "/obj/flow-doubao/samantha/jianti.png")]/preceding-sibling::button[@type="button"][1]'

type DoubaoAdapterHarness = Pick<DoubaoAdapter, keyof DoubaoAdapter> & {
  page: unknown
  getCapturedFetchEntryCount(): Promise<number>
  getLatestCapturedFetchBody(): Promise<string>
  getActionCapabilityState(capability: string): Promise<string>
  getSubmitRequestStartGraceMs(): number
  getSubmitBlockedWarningIntervalMs(): number
  getSubmitResponseTimeoutMs(): number
  readCurrentStreamedResponseText: unknown
}

type WebpackRuntimeCallback = (
  loadModule: (moduleId: number) => unknown
) => unknown

function isWebpackRuntimeCallback(
  value: unknown
): value is WebpackRuntimeCallback {
  return typeof value === 'function'
}

function createTestDoubaoAdapter(): DoubaoAdapterHarness {
  const adapter = new DoubaoAdapter(createBrowserContextStub())
  const candidate: object = adapter
  if (
    !('getActionCapabilityState' in candidate) ||
    typeof candidate.getActionCapabilityState !== 'function'
  ) {
    throw new Error('Doubao adapter is missing getActionCapabilityState().')
  }
  const getActionCapabilityState = candidate.getActionCapabilityState
  return Object.assign(adapter, {
    page: undefined,
    getCapturedFetchEntryCount: async (): Promise<number> => {
      throw new Error('Captured fetch count was not configured for this test.')
    },
    getLatestCapturedFetchBody: async (): Promise<string> => {
      throw new Error('Captured fetch body was not configured for this test.')
    },
    async getActionCapabilityState(capability: string): Promise<string> {
      const state: unknown = await Promise.resolve(
        Reflect.apply(getActionCapabilityState, adapter, [capability])
      )
      if (typeof state !== 'string') {
        throw new Error('Doubao action capability state was not a string.')
      }
      return state
    },
    getSubmitRequestStartGraceMs: (): number => 5,
    getSubmitBlockedWarningIntervalMs: (): number => 30_000,
    getSubmitResponseTimeoutMs: (): number => 30_000,
    readCurrentStreamedResponseText: async (): Promise<string> => {
      throw new Error(
        'Streamed response reader was not configured for this test.'
      )
    },
  })
}

test('DoubaoAdapter.submit handles request failure before a failed click settles', async () => {
  const adapter = createTestDoubaoAdapter()
  const request = {
    method: () => 'POST',
    url: () => 'https://www.doubao.com/chat/completion',
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
  }
  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      page.emit('requestfailed', request)
      throw new Error('click failed')
    },
  }
  const page = createDoubaoPage(sendButton)
  adapter.page = page
  adapter.getCapturedFetchEntryCount = async () => 0

  const assertion = assert.rejects(
    adapter.submit(),
    /Action failed during submit/
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assertion

  assert.equal(page.listenerCount('requestfailed'), 0)
})

test('DoubaoAdapter.submit reads final text from browser-captured response instead of response.body()', async () => {
  const adapter = createTestDoubaoAdapter()
  const correctText = 'response received successfully.'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(correctText)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://www.doubao.com/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        status: () => 200,
        url: () => 'https://www.doubao.com/chat/completion',
        headerValue: async (name: string) =>
          name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
        body: async () => {
          throw new Error('response.body should not be read')
        },
      })
    },
  }
  const page = createDoubaoPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(result, correctText)
})

test('DoubaoAdapter.submit emits periodic warnings while waiting for a request to start and still accepts a later response', async () => {
  const adapter = createTestDoubaoAdapter()
  const warnings: string[] = []
  const correctText = 'response received successfully.'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(correctText)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => undefined,
  }
  const page = createDoubaoPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.setSubmitStatusReporter(async (message: string) => {
    warnings.push(message)
  })
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.getSubmitBlockedWarningIntervalMs = () => 10
  const submitPromise = adapter.submit()
  await new Promise((resolve) => setTimeout(resolve, 35))

  assert.ok(
    warnings.some((message) =>
      message.includes('Doubao submit has not started a provider request yet.')
    )
  )

  const request = {
    method: () => 'POST',
    url: () => 'https://www.doubao.com/chat/completion',
    failure: () => null,
  }
  page.emit('request', request)
  page.emit('response', {
    request: () => request,
    status: () => 200,
    url: () => 'https://www.doubao.com/chat/completion',
    headerValue: async (name: string) =>
      name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
    body: async () => {
      throw new Error('response.body should not be read')
    },
  })

  const result = await submitPromise
  assert.equal(result, correctText)
  const warningCountAfterRecovery = warnings.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(warnings.length, warningCountAfterRecovery)
})

test('DoubaoAdapter.submit emits assistant stream snapshots while the response is growing', async () => {
  const adapter = createTestDoubaoAdapter()
  const streamedTexts: string[] = []
  let currentStreamText = 'partial stream'
  adapter.readCurrentStreamedResponseText = async () => currentStreamText
  const finalText = 'partial stream complete'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(finalText)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      setTimeout(() => {
        currentStreamText = finalText
      }, 15)
      setTimeout(() => {
        const request = {
          method: () => 'POST',
          url: () => 'https://www.doubao.com/chat/completion',
          failure: () => null,
        }
        page.emit('request', request)
        page.emit('response', {
          request: () => request,
          status: () => 200,
          url: () => 'https://www.doubao.com/chat/completion',
          headerValue: async (name: string) =>
            name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
          body: async () => {
            throw new Error('response.body should not be read')
          },
        })
      }, 30)
    },
  }
  const page = createDoubaoPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.setSubmitStatusReporter(async () => undefined)
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })
  adapter.getSubmitRequestStartGraceMs = () => 50
  adapter.getSubmitBlockedWarningIntervalMs = () => 50

  const result = await adapter.submit()

  assert.equal(result, finalText)
  assert.deepEqual(streamedTexts, ['partial stream', finalText])
})

test('DoubaoAdapter.submit fails instead of returning an unfinished response without finish markers', async () => {
  const adapter = createTestDoubaoAdapter()

  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"still streaming"}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://www.doubao.com/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        status: () => 200,
        url: () => 'https://www.doubao.com/chat/completion',
        headerValue: async (name: string) =>
          name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
        body: async () => {
          throw new Error('response.body should not be read')
        },
      })
    },
  }
  const page = createDoubaoPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.getSubmitResponseTimeoutMs = () => 20
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  await assert.rejects(
    adapter.submit(),
    /Doubao submit failed due to a temporary page or network issue\./
  )
})

test('DoubaoAdapter.submit waits for the ready container to become visible again before returning', async () => {
  const adapter = createTestDoubaoAdapter()
  const correctText = 'response received successfully.'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(correctText)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`

  let readyChecks = 0
  const readyContainer = {
    first: () => readyContainer,
    isVisible: async () => {
      readyChecks += 1
      return readyChecks >= 3
    },
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://www.doubao.com/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        status: () => 200,
        url: () => 'https://www.doubao.com/chat/completion',
        headerValue: async (name: string) =>
          name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
        body: async () => {
          throw new Error('response.body should not be read')
        },
      })
    },
  }
  const page = createDoubaoPage(sendButton, readyContainer)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(result, correctText)
  assert.ok(readyChecks >= 3)
})

test('DoubaoAdapter.submit dismisses the desktop promotion before and after sending', async () => {
  const adapter = createTestDoubaoAdapter()
  const events: string[] = []
  const promotion = createDesktopPromotion(events)
  const correctText = 'response received successfully.'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(correctText)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      events.push('click:send')
      promotion.show()
      const request = {
        method: () => 'POST',
        url: () => 'https://www.doubao.com/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        status: () => 200,
        url: () => 'https://www.doubao.com/chat/completion',
        headerValue: async (name: string) =>
          name === 'content-type' ? 'text/event-stream; charset=utf-8' : null,
      })
    },
  }
  const page = createDoubaoPage(sendButton, undefined, undefined, {
    desktopPromotion: promotion,
  })
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.getSubmitRequestStartGraceMs = () => 1

  const result = await adapter.submit()

  assert.equal(result, correctText)
  assert.deepEqual(events, [
    'click:desktop-promotion-close',
    'click:send',
    'click:desktop-promotion-close',
  ])
})

test('DoubaoAdapter.attachFile clicks the current plus trigger and writes files into the hidden input', async () => {
  const adapter = createTestDoubaoAdapter()
  const calls: string[] = []
  let recordedPaths: string[] | null = null

  const uploadTrigger = {
    count: async () => 1,
    click: async () => {
      calls.push('click:trigger')
    },
    first: () => uploadTrigger,
  }
  const fileInput = {
    count: async () => 1,
    setInputFiles: async (paths: string[]) => {
      calls.push('set:files')
      recordedPaths = paths
    },
    last: () => fileInput,
  }

  adapter.page = {
    locator: (selector: string) => {
      if (selector.includes('button[data-dbx-name="button"]')) {
        return uploadTrigger
      }
      if (selector === 'input[type="file"]') {
        return fileInput
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.attachFile('C:\\images\\cat.png')

  assert.deepEqual(calls, ['click:trigger', 'set:files'])
  assert.deepEqual(recordedPaths, ['C:\\images\\cat.png'])
})

test('DoubaoAdapter.attachText prefers the textarea input', async () => {
  const adapter = createTestDoubaoAdapter()
  const events: string[] = []
  adapter.page = createDoubaoTextInputPage({
    textareaVisible: true,
    events,
  })

  await adapter.attachText('hello')

  assert.deepEqual(events, ['click:textarea', 'insert:hello'])
})

test('DoubaoAdapter.attachText dismisses the desktop promotion before editing', async () => {
  const adapter = createTestDoubaoAdapter()
  const events: string[] = []
  adapter.page = createDoubaoTextInputPage({
    textareaVisible: true,
    events,
    desktopPromotion: createDesktopPromotion(events),
  })

  await adapter.attachText('hello')

  assert.deepEqual(events, [
    'click:desktop-promotion-close',
    'click:textarea',
    'insert:hello',
  ])
})

test('DoubaoAdapter reports a visible desktop promotion that cannot be dismissed', async () => {
  const adapter = createTestDoubaoAdapter()
  const events: string[] = []
  adapter.page = createDoubaoTextInputPage({
    textareaVisible: true,
    events,
    desktopPromotion: createDesktopPromotion(events, {
      clickError: new Error('click intercepted'),
    }),
  })

  await assert.rejects(adapter.attachText('hello'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(
      error.message,
      'Doubao desktop promotion is visible but could not be dismissed.'
    )
    assert.equal(
      'detailCode' in error ? error.detailCode : undefined,
      'doubao_desktop_promotion_dismiss_failed'
    )
    return true
  })
  assert.deepEqual(events, ['click:desktop-promotion-close'])
})

test('DoubaoAdapter.attachText falls back to the textbox role input', async () => {
  const adapter = createTestDoubaoAdapter()
  const events: string[] = []
  adapter.page = createDoubaoTextInputPage({
    textareaVisible: false,
    events,
  })

  await adapter.attachText('hello')

  assert.deepEqual(events, ['click:textbox', 'insert:hello'])
})

test('DoubaoAdapter selects visible one-shot capabilities by config key order', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage()
  adapter.page = page

  assert.equal(
    await adapter.getActionCapabilityState('image_generation'),
    'available'
  )

  const state = await adapter.selectActionCapability('image_generation')

  assert.equal(state, 'selected')
  assert.deepEqual(page.events, [
    'click:more',
    'click:visible:image_generation',
  ])
})

test('DoubaoAdapter cancels the selected one-shot capability before selecting another', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage({ selected: 'ppt_generation' })
  adapter.page = page

  await adapter.selectActionCapability('image_generation')

  assert.deepEqual(page.events, [
    'click:selected-close',
    'click:more',
    'click:visible:image_generation',
  ])
})

test('DoubaoAdapter cancels the selected one-shot capability before opening overflow', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage({ selected: 'ppt_generation' })
  adapter.page = page

  await adapter.selectActionCapability('ai_sheet')

  assert.deepEqual(page.events, [
    'click:selected-close',
    'click:more',
    'click:overflow:ai_sheet',
  ])
})

test('DoubaoAdapter clears selected one-shot capabilities', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage({ selected: 'ppt_generation' })
  adapter.page = page

  await adapter.clearActionCapability()

  assert.deepEqual(page.events, ['click:selected-close'])
})

test('DoubaoAdapter clearActionCapability is a no-op without a selected capability', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage()
  adapter.page = page

  await adapter.clearActionCapability()

  assert.deepEqual(page.events, [])
})

test('DoubaoAdapter selects overflow one-shot capabilities without text lookup', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage()
  adapter.page = page

  assert.equal(await adapter.getActionCapabilityState('ai_sheet'), 'available')

  const state = await adapter.selectActionCapability('ai_sheet')

  assert.equal(state, 'selected')
  assert.deepEqual(page.events, ['click:more', 'click:overflow:ai_sheet'])
})

test('DoubaoAdapter selects overflow one-shot capabilities by runtime visible count offset', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage()
  adapter.page = page

  await adapter.selectActionCapability('deep_research')
  await adapter.selectActionCapability('coding')
  await adapter.selectActionCapability('music_generation')

  assert.deepEqual(page.events, [
    'click:more',
    'click:overflow:deep_research',
    'click:selected-close',
    'click:overflow:coding',
    'click:selected-close',
    'click:overflow:music_generation',
  ])
})

test('DoubaoAdapter recalculates overflow offset when visible count changes', async () => {
  const adapter = createTestDoubaoAdapter()
  const page = createDoubaoCapabilityPage({ visibleCount: 6 })
  adapter.page = page

  await adapter.selectActionCapability('coding')

  assert.deepEqual(page.events, ['click:more', 'click:overflow:coding'])
})

test('DoubaoAdapter marks meeting_record as disabled', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoCapabilityPage()

  assert.equal(
    await adapter.getActionCapabilityState('meeting_record'),
    'disabled'
  )
  assert.equal(
    await adapter.selectActionCapability('meeting_record'),
    'disabled'
  )
})

test('DoubaoAdapter lists capabilities from action bar store config keys', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoCapabilityPage({
    capabilities: ['deep_research', 'translate', 'ppt_generation'],
  })

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'deep_research', state: 'available' },
    { name: 'translate', state: 'available' },
    { name: 'ppt_generation', state: 'available' },
  ])
})

test('DoubaoAdapter ignores action bar store skills without config keys', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoCapabilityPage({
    capabilities: ['ai_sheet'],
    missingConfigSkillTypes: [5005, 5006, 5007],
  })

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'ai_sheet', state: 'available' },
  ])
})

test('DoubaoAdapter rejects capability reads when action bar store is missing', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoCapabilityPage({ storeAvailable: false })

  await assert.rejects(
    adapter.listActionCapabilities(),
    /Doubao action bar state is unavailable\./
  )
})

test('DoubaoAdapter changes model through the dropdown menu content', async () => {
  const adapter = createTestDoubaoAdapter()
  const modelMenu = createModelMenu()
  adapter.page = createDoubaoPage(createSendButton(), undefined, undefined, {
    modelMenu,
  })

  await adapter.changeModel('2')

  assert.equal(modelMenu.triggerClicks, 1)
  assert.deepEqual(
    modelMenu.items.map((item) => item.childClicks),
    [0, 1, 0, 0]
  )
  assert.deepEqual(
    modelMenu.items.map((item) => item.selfClicks),
    [0, 0, 0, 0]
  )
})

test('DoubaoAdapter rejects unsupported model names', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoPage(createSendButton())

  await assert.rejects(
    adapter.changeModel('unknown'),
    /Doubao does not support model "unknown"\./
  )
  await assert.rejects(
    adapter.changeModel('turbo'),
    /Doubao does not support model "turbo"\./
  )
  await assert.rejects(
    adapter.changeModel('expert'),
    /Doubao does not support model "expert"\./
  )

  const modelMenu = createModelMenu(2)
  adapter.page = createDoubaoPage(createSendButton(), undefined, undefined, {
    modelMenu,
  })
  await assert.rejects(
    adapter.changeModel('3'),
    /Doubao does not have model 3\./
  )
})

test('DoubaoAdapter.stopGeneration clicks the visible stop icon button when present', async () => {
  const adapter = createTestDoubaoAdapter()
  const stopButton = createStopButton()
  adapter.page = createDoubaoPage(createSendButton(), undefined, stopButton)

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('DoubaoAdapter.stopGeneration clicks a visible stop div even when it is not enabled', async () => {
  const adapter = createTestDoubaoAdapter()
  const stopButton = createStopButton({ enabled: false })
  adapter.page = createDoubaoPage(createSendButton(), undefined, stopButton)

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('DoubaoAdapter.stopGeneration falls back to the stop button class when the primary icon selector misses', async () => {
  const adapter = createTestDoubaoAdapter()
  const stopButton = createStopButton()
  adapter.page = createDoubaoPage(createSendButton(), undefined, stopButton, {
    primaryStopSelectorAvailable: false,
  })

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('DoubaoAdapter.stopGeneration is a no-op when the stop icon is missing', async () => {
  const adapter = createTestDoubaoAdapter()
  adapter.page = createDoubaoPage(createSendButton())

  await adapter.stopGeneration()
})

function createDoubaoPage(
  sendButton: {
    isEnabled: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    click: () => Promise<void>
  },
  readyContainer?: {
    first: () => unknown
    isVisible: () => Promise<boolean>
  },
  stopButton?: ReturnType<typeof createStopButton>,
  stopOptions: {
    primaryStopSelectorAvailable?: boolean
    modelMenu?: ReturnType<typeof createModelMenu>
    desktopPromotion?: ReturnType<typeof createDesktopPromotion>
  } = {}
) {
  const emitter = new EventEmitter()
  let readyContainerLocator: {
    first: () => unknown
    isVisible: () => Promise<boolean>
  }
  if (readyContainer) {
    readyContainerLocator = readyContainer
  } else {
    readyContainerLocator = {
      first: () => readyContainerLocator,
      isVisible: async () => true,
    }
  }

  return {
    locator: (selector: string) => {
      if (selector === DOUBAO_DESKTOP_PROMOTION_CLOSE_SELECTOR) {
        return {
          first: () => stopOptions.desktopPromotion ?? missingDesktopPromotion,
        }
      }
      if (selector === 'button[class*="bg-g-send-msg-btn-bg"]') {
        return {
          last: () => sendButton,
        }
      }
      if (selector === 'div[class*="container-YCWnMI"]') {
        return readyContainerLocator
      }
      if (
        selector === 'button[data-dbx-name="button"]:has(img[src*="mode_"])'
      ) {
        return {
          first: () => ({
            click: async () => {
              stopOptions.modelMenu?.open()
            },
          }),
        }
      }
      if (selector === 'div[data-slot="dropdown-menu-content"]') {
        return {
          last: () => stopOptions.modelMenu ?? missingModelMenu,
        }
      }
      if (
        selector.startsWith(
          'div.break-btn-fISNgC:has(svg[viewBox="0 0 24 24"]'
        ) &&
        selector.includes('path[d^=')
      ) {
        return createOptionalLocator(
          stopOptions.primaryStopSelectorAvailable === false
            ? null
            : (stopButton ?? null)
        )
      }
      if (
        selector === 'div[class*="break-btn-"]:has(svg[viewBox="0 0 24 24"])'
      ) {
        return createOptionalLocator(stopButton ?? null)
      }
      if (selector.startsWith('xpath=//button[@id="flow-end-msg-send"]')) {
        return createOptionalLocator(stopButton ?? null)
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

function createStopButton({ enabled = true } = {}) {
  const button = {
    clicks: 0,
    isVisible: async () => true,
    isEnabled: async () => enabled,
    click: async () => {
      button.clicks += 1
    },
  }
  return button
}

function createSendButton() {
  return {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => undefined,
  }
}

const missingModelMenu = {
  isVisible: async () => false,
  locator: () => {
    throw new Error('Missing model menu.')
  },
}

function createModelMenu(itemCount = 4) {
  const items = Array.from({ length: itemCount }, () => {
    const item = {
      selfClicks: 0,
      childClicks: 0,
      click: async () => {
        item.selfClicks += 1
      },
      locator: (selector: string) => {
        if (selector !== 'xpath=./div') {
          throw new Error(`Unexpected model item child selector: ${selector}`)
        }
        return {
          click: async () => {
            item.childClicks += 1
          },
        }
      },
    }
    return item
  })
  const menu = {
    triggerClicks: 0,
    items,
    open: () => {
      menu.triggerClicks += 1
    },
    isVisible: async () => menu.triggerClicks > 0,
    locator: (selector: string) => {
      if (selector !== 'xpath=./div') {
        throw new Error(`Unexpected model menu selector: ${selector}`)
      }
      return {
        count: async () => items.length,
        nth: (index: number) => items[index] ?? missingModelItem,
      }
    },
  }
  return menu
}

const missingModelItem = {
  click: async () => {
    throw new Error('Missing model item.')
  },
  locator: () => {
    throw new Error('Missing model item.')
  },
}

function stubCapturedResponse(
  adapter: {
    getCapturedFetchEntryCount: () => Promise<number>
    getLatestCapturedFetchBody: () => Promise<string>
  },
  raw: string
) {
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getLatestCapturedFetchBody = async () => raw
}

function createDoubaoTextInputPage({
  textareaVisible,
  events,
  desktopPromotion,
}: {
  textareaVisible: boolean
  events: string[]
  desktopPromotion?: ReturnType<typeof createDesktopPromotion>
}) {
  const textarea = {
    first: () => textarea,
    isVisible: async () => textareaVisible,
    click: async () => {
      events.push('click:textarea')
    },
  }
  const textbox = {
    first: () => textbox,
    click: async () => {
      events.push('click:textbox')
    },
  }

  return {
    locator: (selector: string) => {
      if (selector === DOUBAO_DESKTOP_PROMOTION_CLOSE_SELECTOR) {
        return {
          first: () => desktopPromotion ?? missingDesktopPromotion,
        }
      }
      if (selector === 'textarea.semi-input-textarea') {
        return textarea
      }
      if (selector === 'div[role="textbox"]') {
        return textbox
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
    keyboard: {
      insertText: async (text: string) => {
        events.push(`insert:${text}`)
      },
    },
  }
}

const missingDesktopPromotion = {
  isVisible: async () => false,
  click: async () => {
    throw new Error('Missing desktop promotion.')
  },
}

function createDesktopPromotion(
  events: string[],
  { clickError = null }: { clickError?: Error | null } = {}
) {
  let visible = true
  return {
    isVisible: async () => visible,
    click: async () => {
      events.push('click:desktop-promotion-close')
      if (clickError !== null) {
        throw clickError
      }
      visible = false
    },
    show: () => {
      visible = true
    },
  }
}

function createDoubaoCapabilityPage({
  capabilities = [
    'ppt_generation',
    'image_generation',
    'write_assistant',
    'video_generation',
    'translate',
    'deep_research',
    'coding',
    'meeting_record',
    'music_generation',
    'exercise_assistant',
    'ai_podcast',
    'ai_sheet',
  ],
  missingConfigSkillTypes = [],
  storeAvailable = true,
  selected = null,
  visibleCount = 4,
}: {
  capabilities?: string[]
  missingConfigSkillTypes?: number[]
  storeAvailable?: boolean
  selected?: string | null
  visibleCount?: number
} = {}) {
  const events: string[] = []
  let selectedCapability = selected
  let overflowOpen = false
  const actionCapabilities = [...capabilities]
  const inputSkills = actionCapabilities.map((_, index) => ({
    skill_type: index + 1,
  }))
  inputSkills.push(
    ...missingConfigSkillTypes.map((skillType) => ({ skill_type: skillType }))
  )
  const skillMap = Object.fromEntries(
    actionCapabilities.map((configKey, index) => [
      index + 1,
      {
        config_key: configKey,
        skill_key: configKey,
        show_name: configKey,
      },
    ])
  )
  const storeState = {
    inputSkills,
    skillMap,
  }

  const selectedChip = {
    first: () => selectedChip,
    count: async () => (selectedCapability ? 1 : 0),
    getAttribute: async (name: string) =>
      name === 'data-value' ? selectedCapability : null,
    locator: (selector: string) => {
      if (selector !== 'svg') {
        throw new Error(`Unexpected selected chip selector: ${selector}`)
      }
      return {
        locator: (parentSelector: string) => {
          if (parentSelector !== '..') {
            throw new Error(
              `Unexpected selected chip parent selector: ${parentSelector}`
            )
          }
          return {
            click: async () => {
              events.push('click:selected-close')
              selectedCapability = null
            },
          }
        },
      }
    },
  }

  const popover = {
    first: () => popover,
    isVisible: async () => overflowOpen,
    locator: (selector: string) => {
      if (selector === 'button[data-input-engine-action-source="actionbar"]') {
        return createButtonListLocator(
          actionCapabilities.slice(visibleCount),
          'overflow'
        )
      }
      throw new Error(`Unexpected popover selector: ${selector}`)
    },
  }

  const toolbar = {
    first: () => toolbar,
    locator: (selector: string) => {
      if (
        selector ===
        'button[data-component-type="skill-item"][data-input-engine-action-source="actionbar"]'
      ) {
        return createButtonListLocator(
          selectedCapability ? [] : actionCapabilities.slice(0, visibleCount),
          'visible'
        )
      }
      if (
        selector ===
        'div[aria-haspopup="dialog"][aria-controls][data-state] > button[data-dbx-name="button"]'
      ) {
        return {
          first: () => ({
            count: async () => 1,
            click: async () => {
              events.push('click:more')
              overflowOpen = true
            },
          }),
        }
      }
      throw new Error(`Unexpected toolbar selector: ${selector}`)
    },
  }

  function createButtonListLocator(
    items: string[],
    area: 'visible' | 'overflow'
  ) {
    return {
      count: async () => items.length,
      nth: (index: number) => ({
        click: async () => {
          const capability = items[index]
          events.push(`click:${area}:${capability}`)
          selectedCapability = capability ?? null
        },
      }),
    }
  }

  return {
    events,
    evaluate: async (fn: (() => unknown) | string) => {
      const previousSelf: unknown = Reflect.get(globalThis, 'self')
      try {
        const storeMod = storeAvailable
          ? {
              GX: (name: string) =>
                name === 'chatInputStore' ? storeState : undefined,
              Wp: (name: string) =>
                name === 'chatInputStore'
                  ? { getState: () => storeState }
                  : undefined,
            }
          : {}
        Reflect.set(globalThis, 'self', {
          __LOADABLE_LOADED_CHUNKS__: {
            push: (chunk: unknown[]) => {
              const runtimeCallback = chunk[2]
              if (isWebpackRuntimeCallback(runtimeCallback)) {
                runtimeCallback((moduleId: number) =>
                  moduleId === 908913 ? storeMod : undefined
                )
              }
              return 1
            },
          },
        })
        const result: unknown = typeof fn === 'string' ? eval(fn) : await fn()
        return result
      } finally {
        Reflect.set(globalThis, 'self', previousSelf)
      }
    },
    locator: (selector: string) => {
      if (
        selector === '[style*="--chat-input-tool-button-overflow-list-gap"]'
      ) {
        return toolbar
      }
      if (selector === '[class*="text-g-exit-skill-btn-text"][data-value]') {
        return selectedChip
      }
      if (
        selector ===
        '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"]'
      ) {
        return popover
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }
}
