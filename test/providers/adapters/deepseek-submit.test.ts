import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ProviderAdapterUnsupportedError } from '../../../src/providers/adapters/adapter-base.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { isAbortError } from '../../../src/runtime/runtime-cancellation.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

type DeepSeekAdapterHarness = Pick<DeepSeekAdapter, keyof DeepSeekAdapter> & {
  page: unknown
  conversationIdVal: string | null
  getCapturedFetchEntryCount(): Promise<number>
  getLatestCapturedFetchBody(): Promise<string | null>
  getSubmitRequestStartGraceMs(): number
  getSubmitBlockedWarningIntervalMs(): number
  getSubmitResponseTimeoutMs(): number
  readCurrentStreamedResponseText: unknown
}

function createTestDeepSeekAdapter(): DeepSeekAdapterHarness {
  const adapter = new DeepSeekAdapter(createBrowserContextStub())
  const candidate: object = adapter
  if (
    !('readCurrentStreamedResponseText' in candidate) ||
    typeof candidate.readCurrentStreamedResponseText !== 'function'
  ) {
    throw new Error('DeepSeek adapter is missing its streamed response reader.')
  }
  return Object.assign(adapter, {
    page: undefined,
    conversationIdVal: null,
    getCapturedFetchEntryCount: async (): Promise<number> => {
      throw new Error('Captured fetch count was not configured for this test.')
    },
    getLatestCapturedFetchBody: async (): Promise<string | null> => {
      throw new Error('Captured fetch body was not configured for this test.')
    },
    getSubmitRequestStartGraceMs: (): number => 30_000,
    getSubmitBlockedWarningIntervalMs: (): number => 30_000,
    getSubmitResponseTimeoutMs: (): number => 30_000,
    readCurrentStreamedResponseText: candidate.readCurrentStreamedResponseText,
  })
}

test('DeepSeekAdapter.submit returns a captured finished response without waiting for response.text()', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.conversationIdVal = null
  const responseText =
    '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(responseText)}}]}}}
data: {"p":"response/status","o":"SET","v":"FINISHED"}`

  let responseTextCalled = false
  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        text: async () => {
          responseTextCalled = true
          return await new Promise<string>(() => {})
        },
      })
    },
  }
  const page = createDeepSeekPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })
  adapter.getSubmitRequestStartGraceMs = () => 10

  const controller = new AbortController()
  const submitPromise = adapter.submit({ signal: controller.signal })
  let timeout: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      submitPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('submit waited for response.text()')),
          100
        )
      }),
    ])

    assert.equal(result, responseText)
    assert.equal(responseTextCalled, false)
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    controller.abort()
    await submitPromise.catch(() => {})
  }
})

test('DeepSeekAdapter.submit emits periodic warnings while waiting for the request to start and still accepts a later response', async () => {
  const adapter = createTestDeepSeekAdapter()
  const warnings: string[] = []
  adapter.conversationIdVal = null
  const responseText = 'Recovered after the page resumed.'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(responseText)}}]}}}
data: {"p":"response/status","o":"SET","v":"FINISHED"}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => undefined,
  }
  const page = createDeepSeekPage(sendButton)
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
      message.includes(
        'DeepSeek submit has not started a provider request yet.'
      )
    )
  )

  const request = {
    method: () => 'POST',
    url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
    failure: () => null,
  }
  page.emit('request', request)
  page.emit('response', {
    request: () => request,
    url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
    text: async () => raw,
  })

  const result = await submitPromise
  assert.equal(result, responseText)
  const warningCountAfterRecovery = warnings.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(warnings.length, warningCountAfterRecovery)
})

test('DeepSeekAdapter.submit emits assistant stream snapshots while the response is growing', async () => {
  const adapter = createTestDeepSeekAdapter()
  const streamedTexts: string[] = []
  adapter.conversationIdVal = null
  let currentStreamText = 'partial stream'
  adapter.readCurrentStreamedResponseText = async () => currentStreamText
  const finalText = 'partial stream complete'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(finalText)}}]}}}
data: {"p":"response/status","o":"SET","v":"FINISHED"}`

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
          url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
          failure: () => null,
        }
        page.emit('request', request)
        page.emit('response', {
          request: () => request,
          url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
          text: async () => raw,
        })
      }, 30)
    },
  }
  const page = createDeepSeekPage(sendButton)
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
  assert.deepEqual(streamedTexts.slice(0, 2), ['partial stream', finalText])
  assert.equal(streamedTexts.at(-1), finalText)
})

test('DeepSeekAdapter.submit aborts after streaming a complete tool payload without a FINISHED status', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.conversationIdVal = null
  const controller = new AbortController()
  const streamedTexts: string[] = []
  const responseText =
    '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(responseText)}}]}}}`
  let capturedRaw: string | null = null

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      capturedRaw = raw
      const request = {
        method: () => 'POST',
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        text: async () => await new Promise<string>(() => {}),
      })
      setTimeout(() => controller.abort(), 80)
    },
  }
  const page = createDeepSeekPage(sendButton)
  adapter.page = page
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getLatestCapturedFetchBody = async () => capturedRaw
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })
  adapter.getSubmitRequestStartGraceMs = () => 10

  await assert.rejects(
    adapter.submit({ signal: controller.signal }),
    isAbortError
  )
  assert.equal(streamedTexts.at(-1), responseText)
})

test('DeepSeekAdapter.submit fails instead of returning an unfinished response without FINISHED status', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.conversationIdVal = null
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":"still streaming"}]}}}`

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        text: async () => raw,
      })
    },
  }
  const page = createDeepSeekPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.getSubmitResponseTimeoutMs = () => 20
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  await assert.rejects(
    adapter.submit(),
    /DeepSeek submit failed due to a temporary page or network issue\./
  )
})

test('DeepSeekAdapter.submit waits for the ready button to become visible before returning', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.conversationIdVal = null
  const responseText = 'Recovered after render completed.'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(responseText)}}]}}}
data: {"p":"response/status","o":"SET","v":"FINISHED"}`

  let readyChecks = 0
  const readyButton = {
    first: () => readyButton,
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
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        text: async () => raw,
      })
    },
  }
  const page = createDeepSeekPage(sendButton, readyButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(result, responseText)
  assert.ok(readyChecks >= 3)
})

test('DeepSeekAdapter.submit waits for the send button disabled class to clear before clicking', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.conversationIdVal = null
  const responseText = 'Submitted after the send button became ready.'
  const raw = `data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"content":${JSON.stringify(responseText)}}]}}}
data: {"p":"response/status","o":"SET","v":"FINISHED"}`

  const sendButton = createSendButton({
    className: 'ds-button ds-button--disabled',
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        url: () => 'https://chat.deepseek.com/api/v0/chat/completion',
        text: async () => raw,
      })
    },
  })
  const page = createDeepSeekPage(sendButton)
  adapter.page = page
  stubCapturedResponse(adapter, raw)
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire before the button is ready')
  })

  const submitPromise = adapter.submit()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sendButton.clicks, 0)

  sendButton.className = 'ds-button'
  const result = await submitPromise

  assert.equal(result, responseText)
  assert.equal(sendButton.clicks, 1)
})

test('DeepSeekAdapter reads and sets thinking/search toggle states', async () => {
  const adapter = createTestDeepSeekAdapter()
  const thinkingButton = createToggleButton('false')
  const searchButton = createToggleButton('true')
  adapter.page = createDeepSeekPage(
    {
      isEnabled: async () => true,
      isVisible: async () => true,
      click: async () => undefined,
    },
    undefined,
    [thinkingButton, searchButton]
  )

  assert.equal(await adapter.getToggleState('thinking'), 'off')
  assert.equal(await adapter.getToggleState('search'), 'on')
  assert.equal(await adapter.hasToggleCapability('thinking'), true)
  assert.equal(await adapter.hasToggleCapability('search'), true)

  assert.equal(await adapter.setToggleState('thinking', 'on'), 'on')
  assert.equal(thinkingButton.clicks, 1)

  assert.equal(await adapter.setToggleState('search', 'on'), 'on')
  assert.equal(searchButton.clicks, 0)
})

test('DeepSeekAdapter treats a missing second toggle as unavailable search', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.page = createDeepSeekPage(
    {
      isEnabled: async () => true,
      isVisible: async () => true,
      click: async () => undefined,
    },
    undefined,
    [createToggleButton('false')]
  )

  assert.equal(await adapter.hasToggleCapability('thinking'), true)
  assert.equal(await adapter.hasToggleCapability('search'), false)
  await assert.rejects(
    adapter.getToggleState('search'),
    /DeepSeek search capability is not available on this page\./
  )
})

test('DeepSeekAdapter treats zero toggle buttons as no toggle capabilities', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.page = createDeepSeekPage(
    {
      isEnabled: async () => true,
      isVisible: async () => true,
      click: async () => undefined,
    },
    undefined,
    []
  )

  assert.equal(await adapter.hasToggleCapability('thinking'), false)
  assert.equal(await adapter.hasToggleCapability('search'), false)
})

test('DeepSeekAdapter changes model by data-model-type', async () => {
  const adapter = createTestDeepSeekAdapter()
  const modelButtons = {
    default: createModelButton(),
    expert: createModelButton(),
    vision: createModelButton(),
  }
  adapter.page = createDeepSeekPage(
    createSendButton(),
    undefined,
    [],
    undefined,
    undefined,
    modelButtons
  )

  await adapter.changeModel('2')

  assert.equal(modelButtons.default.clicks, 0)
  assert.equal(modelButtons.expert.clicks, 1)
  assert.equal(modelButtons.vision.clicks, 0)
})

test('DeepSeekAdapter rejects unsupported model names', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.page = createDeepSeekPage(createSendButton())

  await assert.rejects(
    adapter.changeModel('unknown'),
    /DeepSeek does not support model "unknown"\./
  )
  await assert.rejects(
    adapter.changeModel('expert'),
    /DeepSeek does not support model "expert"\./
  )
  await assert.rejects(
    adapter.changeModel('4'),
    /DeepSeek does not have model 4\./
  )
})

test('DeepSeekAdapter.attachFile uploads through the current upload button when available', async () => {
  const adapter = createTestDeepSeekAdapter()
  const uploadButton = createUploadButton()
  adapter.page = createDeepSeekPage(
    {
      isEnabled: async () => true,
      isVisible: async () => true,
      click: async () => undefined,
    },
    undefined,
    [],
    uploadButton
  )

  await adapter.attachFile('C:/Users/XXX/Pictures/sample.png')

  assert.equal(uploadButton.clicks, 1)
  assert.deepEqual(uploadButton.files, ['C:/Users/XXX/Pictures/sample.png'])
})

test('DeepSeekAdapter.attachFile reports unsupported when the upload button is unavailable', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.page = createDeepSeekPage({
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => undefined,
  })

  await assert.rejects(
    adapter.attachFile('C:/Users/XXX/Pictures/sample.png'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message ===
        'DeepSeek file upload is not available in the current conversation.'
  )
})

test('DeepSeekAdapter.stopGeneration clicks the visible stop icon button when present', async () => {
  const adapter = createTestDeepSeekAdapter()
  const stopButton = createStopButton()
  adapter.page = createDeepSeekPage(
    createSendButton(),
    undefined,
    [],
    undefined,
    stopButton
  )

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('DeepSeekAdapter.stopGeneration clicks a visible stop div even when it is not enabled', async () => {
  const adapter = createTestDeepSeekAdapter()
  const stopButton = createStopButton({ enabled: false })
  adapter.page = createDeepSeekPage(
    createSendButton(),
    undefined,
    [],
    undefined,
    stopButton
  )

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('DeepSeekAdapter.stopGeneration is a no-op when the stop icon is missing', async () => {
  const adapter = createTestDeepSeekAdapter()
  adapter.page = createDeepSeekPage(createSendButton())

  await adapter.stopGeneration()
})

function createDeepSeekPage(
  sendButton: {
    isEnabled: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    getAttribute?: (name: string) => Promise<string | null>
    click: () => Promise<void>
  },
  readyButton?: {
    first: () => unknown
    isVisible: () => Promise<boolean>
  },
  toggleButtons: ReturnType<typeof createToggleButton>[] = [],
  uploadButton?: ReturnType<typeof createUploadButton>,
  stopButton?: ReturnType<typeof createStopButton>,
  modelButtons: Partial<
    Record<
      'default' | 'expert' | 'vision',
      ReturnType<typeof createModelButton>
    >
  > = {}
) {
  const emitter = new EventEmitter()
  const normalizedSendButton = {
    ...sendButton,
    getAttribute: sendButton.getAttribute ?? (async () => null),
  }
  const readyButtonTarget = readyButton ?? {
    isVisible: async () => true,
  }

  return {
    locator: (selector: string) => {
      if (selector === 'div._52c986b') {
        return {
          ...normalizedSendButton,
          first: () => normalizedSendButton,
        }
      }
      if (selector === 'div[role="button"][class*="bd74640a"]') {
        return {
          count: async () => 1,
          first: () => readyButtonTarget,
        }
      }
      if (selector === 'div.f79352dc') {
        return {
          count: async () => toggleButtons.length,
          nth: (index: number) => toggleButtons[index] ?? missingToggleButton,
        }
      }
      if (selector === 'div[role="button"].f02f0e25') {
        return {
          count: async () => (uploadButton ? 1 : 0),
          first: () => uploadButton ?? missingUploadButton,
        }
      }
      if (selector === 'div.b0db7355 div[role="radio"][data-model-type]') {
        const modelOrder = ['default', 'expert', 'vision'] as const
        return {
          count: async () =>
            modelOrder.filter((model) => modelButtons[model]).length,
          nth: (index: number) => {
            const model = modelOrder[index]
            return model === undefined
              ? missingModelButton
              : (modelButtons[model] ?? missingModelButton)
          },
        }
      }
      if (
        selector.startsWith('div[role="button"]:has(svg[viewBox^="0 0 16"]') &&
        selector.includes('path[d^=')
      ) {
        return createOptionalLocator(stopButton ?? null)
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
    waitForEvent: async (eventName: string) => {
      assert.equal(eventName, 'filechooser')
      return {
        setFiles: async (path: string | readonly string[]) => {
          if (uploadButton) {
            uploadButton.files = typeof path === 'string' ? [path] : [...path]
          }
        },
      }
    },
    url: () => 'https://chat.deepseek.com/a/chat/s/conv-1',
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

function stubCapturedResponse(
  adapter: {
    getCapturedFetchEntryCount: () => Promise<number>
    getLatestCapturedFetchBody: () => Promise<string | null>
  },
  raw: string
) {
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getLatestCapturedFetchBody = async () => raw
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

const missingToggleButton = {
  count: async () => 0,
  getAttribute: async () => null,
  click: async () => {
    throw new Error('Missing toggle button.')
  },
}

const missingUploadButton = {
  isVisible: async () => false,
  isEnabled: async () => false,
  click: async () => {
    throw new Error('Missing upload button.')
  },
}

const missingModelButton = {
  click: async () => {
    throw new Error('Missing model button.')
  },
}

function createModelButton() {
  const button = {
    clicks: 0,
    click: async () => {
      button.clicks += 1
    },
  }
  return button
}

function createToggleButton(initialValue: 'true' | 'false') {
  const button = {
    value: initialValue,
    clicks: 0,
    getAttribute: async (name: string) => {
      return name === 'aria-pressed' ? button.value : null
    },
    count: async () => 1,
    click: async () => {
      button.clicks += 1
      button.value = button.value === 'true' ? 'false' : 'true'
    },
  }
  return button
}

function createUploadButton() {
  const button = {
    clicks: 0,
    files: [] as string[],
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      button.clicks += 1
    },
  }
  return button
}

function createSendButton({
  className = '',
  click = async () => undefined,
}: {
  className?: string
  click?: () => Promise<void>
} = {}) {
  const button = {
    className,
    clicks: 0,
    isEnabled: async () => true,
    isVisible: async () => true,
    getAttribute: async (name: string) => {
      return name === 'class' ? button.className : null
    },
    click: async () => {
      button.clicks += 1
      await click()
    },
  }
  return button
}
