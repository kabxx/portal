import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { createDeferred } from '../../../src/providers/adapters/adapter-base.ts'

type MockButton = {
  first: () => unknown
  isVisible: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
}

function createTestChatGPTAdapter() {
  const adapter = Object.create(ChatGPTAdapter.prototype) as any
  adapter.getFinishedResponseSettleMs = () => 50
  adapter.getSubmitRequestStartGraceMs = () => 5
  return adapter
}

test('ChatGPTAdapter target conversation request ignores prepare requests', () => {
  const adapter = createTestChatGPTAdapter()

  assert.equal(
    adapter.isTargetConversationRequest({
      method: () => 'POST',
      url: () => 'https://chatgpt.com/backend-api/f/conversation/prepare',
    }),
    false
  )
  assert.equal(
    adapter.isTargetConversationRequest({
      method: () => 'POST',
      url: () => 'https://chatgpt.com/backend-api/f/conversation',
    }),
    true
  )
})

test('ChatGPTAdapter.submit waits past empty target responses for the real HTTP response', async () => {
  const adapter = createTestChatGPTAdapter()
  const parsedBodies: string[] = []

  adapter.websocketFrames = []
  adapter.parseHttpResponse = (raw: string) => {
    parsedBodies.push(raw)
    if (raw === 'data: READY\n\n') {
      return {
        text: 'READY',
        isFinished: true,
      }
    }
    return null
  }
  adapter.parseWebsocketResponse = () => null

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const firstRequest = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      const secondRequest = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', firstRequest)
      page.emit('response', {
        request: () => firstRequest,
        text: async () => '{"status":"ok"}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      setTimeout(() => {
        page.emit('request', secondRequest)
        page.emit('response', {
          request: () => secondRequest,
          text: async () => 'data: READY\n\n',
          url: () => 'https://chatgpt.com/backend-api/f/conversation',
          status: () => 200,
        })
      }, 20)
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire after a target response')
  })

  const result = await adapter.submit()

  assert.equal(result, 'READY')
  assert.deepEqual(parsedBodies, ['{"status":"ok"}', 'data: READY\n\n'])
})

test('ChatGPTAdapter.submit keeps accepting later HTTP text after the first non-empty response', async () => {
  const adapter = createTestChatGPTAdapter()

  adapter.websocketFrames = []
  adapter.parseHttpResponse = (raw: string) => ({
    text: raw,
    isFinished: true,
  })
  adapter.parseWebsocketResponse = () => null

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const firstRequest = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      const secondRequest = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', firstRequest)
      page.emit('response', {
        request: () => firstRequest,
        text: async () => 'First sentence.',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      setTimeout(() => {
        page.emit('request', secondRequest)
        page.emit('response', {
          request: () => secondRequest,
          text: async () => 'First sentence. Second sentence.',
          url: () => 'https://chatgpt.com/backend-api/f/conversation',
          status: () => 200,
        })
      }, 20)
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire after a target response')
  })

  const result = await adapter.submit()

  assert.equal(result, 'First sentence. Second sentence.')
})

test('ChatGPTAdapter.submit streams captured HTTP text before response.text completes', async () => {
  const adapter = createTestChatGPTAdapter()
  const streamedTexts: string[] = []
  const responseTextCompletedByEmission: boolean[] = []
  const releaseResponseText = createDeferred<void>()
  const responseTextFinished = createDeferred<void>()
  let captureCalls = 0
  let responseTextCompleted = false

  adapter.websocketFrames = []
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.readCurrentCapturedResponse = async () => {
    captureCalls += 1
    if (captureCalls < 2) {
      return null
    }
    if (captureCalls < 5) {
      return {
        text: 'First sentence.',
        isFinished: false,
      }
    }
    return {
      text: 'First sentence. Second sentence.',
      isFinished: true,
    }
  }
  adapter.parseHttpResponse = (raw: string) => ({
    text: raw,
    isFinished: true,
  })
  adapter.parseWebsocketResponse = () => null

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => {
          await releaseResponseText.promise
          responseTextCompleted = true
          responseTextFinished.resolve()
          return 'First sentence. Second sentence.'
        },
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire after a target response')
  })
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
    responseTextCompletedByEmission.push(responseTextCompleted)
  })

  const result = await adapter.submit()

  assert.equal(result, 'First sentence. Second sentence.')
  assert.deepEqual(streamedTexts, [
    'First sentence.',
    'First sentence. Second sentence.',
  ])
  assert.deepEqual(responseTextCompletedByEmission, [false, false])
  releaseResponseText.resolve()
  await responseTextFinished.promise
})

test('ChatGPTAdapter.submit waits for websocket text to stabilize after the HTTP response settles', async () => {
  let websocketParseCalls = 0

  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = ['frame-1', 'frame-2', 'frame-3']
  adapter.parseHttpResponse = () => ({
    text: 'half tool payload',
    isFinished: false,
  })
  adapter.parseWebsocketResponse = () => {
    websocketParseCalls += 1
    if (websocketParseCalls < 3) {
      return {
        text: 'half tool payload',
        isFinished: false,
      }
    }

    return {
      text: '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>',
      isFinished: true,
    }
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{"status":"ok"}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(
    result,
    '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>'
  )
  assert.ok(websocketParseCalls >= 3)
})

test('ChatGPTAdapter.submit emits assistant stream snapshots while websocket text is growing', async () => {
  const adapter = createTestChatGPTAdapter()
  const streamedTexts: string[] = []
  let websocketParseCalls = 0

  adapter.websocketFrames = ['frame-1']
  adapter.parseHttpResponse = () => null
  adapter.parseWebsocketResponse = () => {
    websocketParseCalls += 1
    if (websocketParseCalls < 3) {
      return {
        text: 'partial stream',
        isFinished: false,
      }
    }

    return {
      text: 'partial stream complete',
      isFinished: true,
    }
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => undefined)
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })

  const result = await adapter.submit()

  assert.equal(result, 'partial stream complete')
  assert.deepEqual(streamedTexts, ['partial stream', 'partial stream complete'])
})

test('ChatGPTAdapter.submit emits periodic warnings while waiting for the request to start and still accepts a later response', async () => {
  const adapter = createTestChatGPTAdapter()
  const warnings: string[] = []
  adapter.websocketFrames = []
  adapter.parseHttpResponse = () => ({
    text: 'Recovered after manual verification.',
    isFinished: true,
  })
  adapter.parseWebsocketResponse = () => null

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => undefined,
  }
  const page = createChatGPTPage(sendButton)
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
      message.includes('ChatGPT submit has not started a provider request yet.')
    )
  )

  const request = {
    method: () => 'POST',
    url: () => 'https://chatgpt.com/backend-api/f/conversation',
    failure: () => null,
  }
  page.emit('request', request)
  page.emit('response', {
    request: () => request,
    text: async () => '{"status":"ok"}',
    url: () => 'https://chatgpt.com/backend-api/f/conversation',
    status: () => 200,
  })

  const result = await submitPromise
  assert.equal(result, 'Recovered after manual verification.')
  const warningCountAfterRecovery = warnings.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(warnings.length, warningCountAfterRecovery)
})

test('ChatGPTAdapter.submit waits for finished websocket text to stabilize before returning', async () => {
  let websocketParseCalls = 0

  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = ['frame-1']
  adapter.parseHttpResponse = () => null
  adapter.parseWebsocketResponse = () => {
    websocketParseCalls += 1
    if (websocketParseCalls < 3) {
      return {
        text: '<tool>\n{\n  "tool": "attach_image",\n  "',
        isFinished: true,
      }
    }

    return {
      text: '<tool>\n{\n  "tool": "attach_image",\n  "params": {\n    "path": "C:/images/cat.png"\n  }\n}\n</tool>',
      isFinished: true,
    }
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(
    result,
    '<tool>\n{\n  "tool": "attach_image",\n  "params": {\n    "path": "C:/images/cat.png"\n  }\n}\n</tool>'
  )
  assert.ok(websocketParseCalls >= 3)
})

test('ChatGPTAdapter.submit keeps streaming after an early finished chunk until later websocket text completes', async () => {
  const adapter = createTestChatGPTAdapter()
  const streamedTexts: string[] = []
  adapter.websocketFrames = []
  adapter.parseHttpResponse = () => null
  adapter.parseWebsocketResponse = (frames: readonly string[]) => {
    if (frames.length < 2) {
      return {
        text: 'partial finished chunk',
        isFinished: true,
      }
    }

    return {
      text: 'partial finished chunk that later completed',
      isFinished: true,
    }
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      adapter.websocketFrames.push('frame-1')
      setTimeout(() => {
        adapter.websocketFrames.push('frame-2')
      }, 20)
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => undefined)
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })

  const result = await adapter.submit()

  assert.equal(result, 'partial finished chunk that later completed')
  assert.deepEqual(streamedTexts, [
    'partial finished chunk',
    'partial finished chunk that later completed',
  ])
})

test('ChatGPTAdapter.submit does not accept a stable unfinished tool call before a later websocket frame completes it', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = []
  adapter.parseHttpResponse = () => ({
    text: 'half tool payload',
    isFinished: false,
  })
  adapter.parseWebsocketResponse = (frames: readonly string[]) => {
    if (frames.length < 2) {
      return {
        text: '<tool>{"tool":"run_command","params":{"command":"d',
        isFinished: false,
      }
    }

    return {
      text: '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>',
      isFinished: true,
    }
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      adapter.websocketFrames.push('frame-1')
      setTimeout(() => {
        adapter.websocketFrames.push('frame-2')
      }, 20)
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })
  adapter.getSubmitResponseIdleTimeoutMs = () => 400
  const result = await adapter.submit()

  assert.equal(
    result,
    '<tool>{"tool":"run_command","params":{"command":"dir"}}</tool>'
  )
})

test('ChatGPTAdapter.submit fails instead of returning an unfinished response without finish', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = []
  adapter.parseHttpResponse = () => ({
    text: 'still streaming',
    isFinished: false,
  })
  adapter.parseWebsocketResponse = () => ({
    text: 'still streaming',
    isFinished: false,
  })

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      adapter.websocketFrames.push('frame-1')
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })
  adapter.getSubmitResponseIdleTimeoutMs = () => 200
  await assert.rejects(
    adapter.submit(),
    /ChatGPT submit failed due to a temporary page or network issue\./
  )
})

test('ChatGPTAdapter.submit waits for the real speech button selector to become usable again before returning', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = ['frame-1']
  adapter.parseHttpResponse = () => ({
    text: 'done',
    isFinished: true,
  })
  adapter.parseWebsocketResponse = () => ({
    text: 'done',
    isFinished: true,
  })

  let speechChecks = 0
  const speechButton = {
    first: () => speechButton,
    isVisible: async () => {
      speechChecks += 1
      return speechChecks >= 3
    },
    isEnabled: async () => speechChecks >= 3,
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton, speechButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(result, 'done')
  assert.ok(speechChecks >= 3)
})

test('ChatGPTAdapter.submit accepts the data-testid send button as composer ready fallback', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = ['frame-1']
  adapter.parseHttpResponse = () => ({
    text: 'done',
    isFinished: true,
  })
  adapter.parseWebsocketResponse = () => ({
    text: 'done',
    isFinished: true,
  })

  const unavailableSpeechButton = {
    first: () => unavailableSpeechButton,
    isVisible: async () => false,
    isEnabled: async () => false,
  }
  let fallbackChecks = 0
  const dataTestIdSendButton = {
    first: () => dataTestIdSendButton,
    isVisible: async () => {
      fallbackChecks += 1
      return true
    },
    isEnabled: async () => true,
  }

  const sendButton = {
    isEnabled: async () => true,
    isVisible: async () => true,
    click: async () => {
      const request = {
        method: () => 'POST',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        failure: () => null,
      }
      page.emit('request', request)
      page.emit('response', {
        request: () => request,
        text: async () => '{}',
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
    },
  }
  const page = createChatGPTPage(sendButton, {
    speechButton: unavailableSpeechButton,
    dataTestIdSendButton,
  })
  adapter.page = page
  adapter.setSubmitStatusReporter(async () => {
    throw new Error('submit warning should not fire for the normal path')
  })

  const result = await adapter.submit()

  assert.equal(result, 'done')
  assert.ok(fallbackChecks >= 1)
})

test('ChatGPTAdapter lists fixed action capabilities when the capability group exists', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTCapabilityPage()
  adapter.page = page

  assert.deepEqual(await adapter.listActionCapabilities(), [
    { name: 'image_create', state: 'available' },
    { name: 'web_search', state: 'available' },
    { name: 'deep_research', state: 'available' },
    { name: 'openai_platform', state: 'available' },
  ])
  assert.deepEqual(page.events, ['click:plus'])
})

test('ChatGPTAdapter returns no action capabilities when the capability group is missing', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.page = createChatGPTCapabilityPage({ hasCapabilityGroup: false })

  assert.deepEqual(await adapter.listActionCapabilities(), [])
})

test('ChatGPTAdapter selects fixed action capabilities by index', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTCapabilityPage()
  adapter.page = page

  assert.equal(await adapter.selectActionCapability('web_search'), 'selected')
  assert.equal(
    await adapter.selectActionCapability('openai_platform'),
    'selected'
  )

  assert.deepEqual(page.events, [
    'click:plus',
    'click:capability:web_search',
    'click:capability:openai_platform',
  ])
})

test('ChatGPTAdapter changes model and mode through the intelligence picker', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTModelPage()
  adapter.page = page

  await adapter.changeModel('2+1')

  assert.deepEqual(page.events, [
    'click:pill',
    'click:mode:0',
    'click:pill',
    'click:model-menu',
    'click:model:1',
  ])
})

test('ChatGPTAdapter changes model without changing mode', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTModelPage()
  adapter.page = page

  await adapter.changeModel('3')

  assert.deepEqual(page.events, [
    'click:pill',
    'click:model-menu',
    'click:model:2',
  ])
})

test('ChatGPTAdapter rejects unsupported model and mode numbers', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.page = createChatGPTModelPage({ modelCount: 2, modeCount: 1 })

  await assert.rejects(
    adapter.changeModel('name'),
    /ChatGPT does not support model "name"\./
  )
  await assert.rejects(
    adapter.changeModel('3'),
    /ChatGPT does not have model 3\./
  )
  await assert.rejects(
    adapter.changeModel('1+2'),
    /ChatGPT does not have model mode 2\./
  )
})

test('ChatGPTAdapter.stopGeneration clicks the visible stop button when present', async () => {
  const adapter = createTestChatGPTAdapter()
  const stopButton = createStopButton()
  adapter.page = createChatGPTStopPage(stopButton)

  await adapter.stopGeneration()

  assert.equal(stopButton.clicks, 1)
})

test('ChatGPTAdapter.stopGeneration is a no-op when the stop button is missing', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.page = createChatGPTStopPage(null)

  await adapter.stopGeneration()
})

function createChatGPTPage(
  sendButton: {
    isEnabled: () => Promise<boolean>
    isVisible: () => Promise<boolean>
    click: () => Promise<void>
  },
  readyButtons?:
    | {
        speechButton?: MockButton
        dataTestIdSendButton?: MockButton
      }
    | MockButton
) {
  const emitter = new EventEmitter()
  let readySpeechButton: MockButton
  let readyDataTestIdSendButton: MockButton
  const isReadyButtonSet = (
    value: typeof readyButtons
  ): value is {
    speechButton?: MockButton
    dataTestIdSendButton?: MockButton
  } =>
    Boolean(
      value && ('speechButton' in value || 'dataTestIdSendButton' in value)
    )
  const configuredSpeechButton = isReadyButtonSet(readyButtons)
    ? readyButtons.speechButton
    : readyButtons
  const configuredDataTestIdSendButton = isReadyButtonSet(readyButtons)
    ? readyButtons.dataTestIdSendButton
    : undefined

  if (configuredSpeechButton) {
    readySpeechButton = configuredSpeechButton
  } else {
    readySpeechButton = {
      first: () => readySpeechButton,
      isVisible: async () => true,
      isEnabled: async () => true,
    }
  }
  if (configuredDataTestIdSendButton) {
    readyDataTestIdSendButton = configuredDataTestIdSendButton
  } else {
    readyDataTestIdSendButton = {
      first: () => readyDataTestIdSendButton,
      isVisible: async () => false,
      isEnabled: async () => false,
    }
  }

  return {
    locator: (selector: string) => {
      if (selector === '#composer-submit-button') {
        return sendButton
      }
      if (selector === 'button[style*="--vt-composer-speech-button"]') {
        return readySpeechButton
      }
      if (selector === 'button[data-testid="send-button"]') {
        return readyDataTestIdSendButton
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
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

function createChatGPTStopPage(
  stopButton: ReturnType<typeof createStopButton> | null
) {
  return {
    locator: (selector: string) => {
      if (selector !== 'button[data-testid="stop-button"]') {
        throw new Error(`Unexpected selector: ${selector}`)
      }
      return createOptionalLocator(stopButton)
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

function createChatGPTModelPage({
  modelCount = 3,
  modeCount = 2,
}: {
  modelCount?: number
  modeCount?: number
} = {}) {
  const events: string[] = []
  let pickerOpen = false
  let modelMenuOpen = false
  const modelItems = Array.from({ length: modelCount }, (_, index) => ({
    click: async () => {
      events.push(`click:model:${index}`)
    },
  }))
  const modeItems = Array.from({ length: modeCount }, (_, index) => ({
    click: async () => {
      events.push(`click:mode:${index}`)
      pickerOpen = false
    },
  }))
  const picker = {
    last: () => picker,
    isVisible: async () => pickerOpen,
    locator: (selector: string) => {
      if (selector === 'div[role="group"] div[role="menuitemradio"]') {
        return {
          count: async () => modeItems.length,
          nth: (index: number) => modeItems[index],
        }
      }
      if (selector === 'div[role="menuitem"]') {
        return {
          count: async () => 1,
          first: () => ({
            getAttribute: async (name: string) =>
              name === 'aria-controls' ? 'chatgpt-model-menu' : null,
            click: async () => {
              events.push('click:model-menu')
              modelMenuOpen = true
            },
          }),
        }
      }
      throw new Error(`Unexpected picker selector: ${selector}`)
    },
  }
  const modelMenu = {
    count: async () => (modelMenuOpen ? modelItems.length : 0),
    nth: (itemIndex: number) => modelItems[itemIndex],
  }

  return {
    events,
    locator: (selector: string) => {
      if (selector === 'button.__composer-pill') {
        return {
          click: async () => {
            events.push('click:pill')
            pickerOpen = true
          },
        }
      }
      if (
        selector === 'div[data-testid="composer-intelligence-picker-content"]'
      ) {
        return picker
      }
      if (selector === '[id="chatgpt-model-menu"] div[role="menuitemradio"]') {
        return modelMenu
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }
}

function createChatGPTCapabilityPage({
  hasCapabilityGroup = true,
}: {
  hasCapabilityGroup?: boolean
} = {}) {
  const events: string[] = []
  let menuOpen = false
  const capabilityNames = [
    'image_create',
    'web_search',
    'deep_research',
    'openai_platform',
  ]
  const uploadGroup = {
    locator: (selector: string) => {
      if (selector !== 'xpath=./div') {
        throw new Error(`Unexpected upload group selector: ${selector}`)
      }
      return {
        nth: () => ({
          click: async () => {
            events.push('click:upload')
          },
        }),
      }
    },
  }
  const capabilityGroup = {
    count: async () => (hasCapabilityGroup && menuOpen ? 1 : 0),
    locator: (selector: string) => {
      if (selector !== 'xpath=./div') {
        throw new Error(`Unexpected capability group selector: ${selector}`)
      }
      return {
        nth: (index: number) => ({
          click: async () => {
            events.push(`click:capability:${capabilityNames[index]}`)
          },
        }),
      }
    },
  }
  return {
    events,
    getByTestId: (testId: string) => {
      if (testId !== 'composer-plus-btn') {
        throw new Error(`Unexpected test id: ${testId}`)
      }
      return {
        click: async () => {
          events.push('click:plus')
          menuOpen = true
        },
      }
    },
    locator: (selector: string) => {
      if (selector !== 'div[role="group"][class*="empty:hidden"]') {
        throw new Error(`Unexpected selector: ${selector}`)
      }
      return {
        nth: (index: number) => (index === 1 ? capabilityGroup : uploadGroup),
      }
    },
  }
}
