import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { createDeferred } from '../../../src/providers/adapters/adapter-base.ts'
import {
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
} from '../../../src/providers/ui/provider-ui.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const CHATGPT_LOCATORS = {
  modelTrigger: [
    'button[data-testid="model-switcher-dropdown-button"]',
    'button.__composer-pill',
  ],
  modelDirectMenu: ['[role="menu"]'],
  modelPicker: ['div[data-testid="composer-intelligence-picker-content"]'],
  modelDirectItem: ['[role="menuitemradio"]'],
  modelMenuItem: ['div[role="menuitem"]'],
  modelItem: ['div[role="menuitemradio"]'],
  capabilityTrigger: ['[data-testid="composer-plus-btn"]'],
  capabilityGroup: ['div[role="group"][class*="empty:hidden"]'],
} as const
const CHATGPT_MODEL_TRIGGER_SELECTOR = joinCssLocatorCandidates(
  CHATGPT_LOCATORS.modelTrigger,
  ':visible'
)
const CHATGPT_MODEL_DIRECT_MENU_SELECTOR = joinCssLocatorCandidates(
  CHATGPT_LOCATORS.modelDirectMenu,
  ':visible'
)
const CHATGPT_MODEL_PICKER_SELECTOR = joinCssLocatorCandidates(
  CHATGPT_LOCATORS.modelPicker,
  ':visible'
)

type MockButton = {
  first: () => unknown
  isVisible: () => Promise<boolean>
  isEnabled: () => Promise<boolean>
}

type ChatGPTAdapterHarness = Pick<ChatGPTAdapter, keyof ChatGPTAdapter> & {
  page: unknown
  websocketFrames: string[]
  isTargetConversationRequest(request: {
    method(): string
    url(): string
  }): boolean
  getCapturedFetchEntryCount: unknown
  readCurrentCapturedResponse: unknown
  getFinishedResponseSettleMs(): number
  getSubmitRequestStartGraceMs(): number
  getSubmitBlockedWarningIntervalMs(): number
  getSubmitResponseIdleTimeoutMs(): number
}

function createTestChatGPTAdapter(): ChatGPTAdapterHarness {
  const adapter = new ChatGPTAdapter(createBrowserContextStub())
  const candidate: object = adapter
  if (
    !('isTargetConversationRequest' in candidate) ||
    typeof candidate.isTargetConversationRequest !== 'function' ||
    !('getCapturedFetchEntryCount' in candidate) ||
    typeof candidate.getCapturedFetchEntryCount !== 'function' ||
    !('readCurrentCapturedResponse' in candidate) ||
    typeof candidate.readCurrentCapturedResponse !== 'function'
  ) {
    throw new Error('ChatGPT adapter is missing submit harness methods.')
  }
  const isTargetConversationRequest = candidate.isTargetConversationRequest
  const websocketFrames: string[] = []

  return Object.assign(adapter, {
    page: undefined,
    websocketFrames,
    isTargetConversationRequest(request: {
      method(): string
      url(): string
    }): boolean {
      const matched: unknown = Reflect.apply(
        isTargetConversationRequest,
        adapter,
        [request]
      )
      if (typeof matched !== 'boolean') {
        throw new Error('ChatGPT request matcher returned a non-boolean value.')
      }
      return matched
    },
    getCapturedFetchEntryCount: candidate.getCapturedFetchEntryCount,
    readCurrentCapturedResponse: candidate.readCurrentCapturedResponse,
    getFinishedResponseSettleMs: (): number => 50,
    getSubmitRequestStartGraceMs: (): number => 5,
    getSubmitBlockedWarningIntervalMs: (): number => 30_000,
    getSubmitResponseIdleTimeoutMs: (): number => 30_000,
  })
}

function createChatGptHttpResponse(
  text: string,
  finished = true,
  conversationId = 'conversation-1'
): string {
  return JSON.stringify({
    conversation_id: conversationId,
    current_node: 'node-1',
    mapping: {
      'node-1': {
        message: {
          id: 'message-1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [text] },
          status: finished ? 'finished_successfully' : 'in_progress',
          end_turn: finished,
          channel: 'final',
          metadata: {},
        },
      },
    },
  })
}

function createChatGptWebSocketFrame(
  text: string,
  finished = false,
  conversationId = 'conversation-1'
): string {
  return JSON.stringify({
    conversation_id: conversationId,
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      v: {
        message: {
          id: 'message-1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [text] },
          status: finished ? 'finished_successfully' : 'in_progress',
          end_turn: finished,
          channel: 'final',
          metadata: {},
        },
      },
    })}`,
  })
}

function createChatGptWebSocketAppendFrame(text: string): string {
  return JSON.stringify({
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: text,
    })}`,
  })
}

function createChatGptWebSocketFinishFrame(): string {
  return JSON.stringify({
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      o: 'patch',
      v: [{ p: '/message/end_turn', o: 'replace', v: true }],
    })}`,
  })
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
        text: async () => {
          const raw = '{"status":"ok"}'
          parsedBodies.push(raw)
          return raw
        },
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      setTimeout(() => {
        page.emit('request', secondRequest)
        page.emit('response', {
          request: () => secondRequest,
          text: async () => {
            const raw = createChatGptHttpResponse('READY')
            parsedBodies.push(raw)
            return raw
          },
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
  assert.deepEqual(parsedBodies, [
    '{"status":"ok"}',
    createChatGptHttpResponse('READY'),
  ])
})

test('ChatGPTAdapter.submit keeps accepting later HTTP text after the first non-empty response', async () => {
  const adapter = createTestChatGPTAdapter()

  adapter.websocketFrames = []

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
        text: async () => createChatGptHttpResponse('First sentence.'),
        url: () => 'https://chatgpt.com/backend-api/f/conversation',
        status: () => 200,
      })
      setTimeout(() => {
        page.emit('request', secondRequest)
        page.emit('response', {
          request: () => secondRequest,
          text: async () =>
            createChatGptHttpResponse('First sentence. Second sentence.'),
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
          return createChatGptHttpResponse('First sentence. Second sentence.')
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
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame(
          '<tool>{"tool":"run_command","params":{"command":"'
        )
      )
      setTimeout(() => {
        adapter.websocketFrames.push(
          createChatGptWebSocketAppendFrame('dir"}}</tool>')
        )
        adapter.websocketFrames.push(createChatGptWebSocketFinishFrame())
      }, 20)
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
})

test('ChatGPTAdapter.submit emits assistant stream snapshots while websocket text is growing', async () => {
  const adapter = createTestChatGPTAdapter()
  const streamedTexts: string[] = []

  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame('partial stream')
      )
      setTimeout(() => {
        adapter.websocketFrames.push(
          createChatGptWebSocketAppendFrame(' complete')
        )
        adapter.websocketFrames.push(createChatGptWebSocketFinishFrame())
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

  assert.equal(result, 'partial stream complete')
  assert.deepEqual(streamedTexts, ['partial stream', 'partial stream complete'])
})

test('ChatGPTAdapter.submit emits periodic warnings while waiting for the request to start and still accepts a later response', async () => {
  const adapter = createTestChatGPTAdapter()
  const warnings: string[] = []
  adapter.websocketFrames = []

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
    text: async () =>
      createChatGptHttpResponse('Recovered after manual verification.'),
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
  const adapter = createTestChatGPTAdapter()
  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame(
          '<tool>\n{\n  "tool": "attach_image",\n  "',
          true
        )
      )
      setTimeout(() => {
        adapter.websocketFrames.push(
          createChatGptWebSocketAppendFrame(
            'params": {\n    "path": "C:/images/cat.png"\n  }\n}\n</tool>'
          )
        )
      }, 20)
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
})

test('ChatGPTAdapter.submit keeps streaming after an early finished chunk until later websocket text completes', async () => {
  const adapter = createTestChatGPTAdapter()
  const streamedTexts: string[] = []
  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame('partial finished chunk', true)
      )
      setTimeout(() => {
        adapter.websocketFrames.push(
          createChatGptWebSocketAppendFrame(' that later completed')
        )
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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame(
          '<tool>{"tool":"run_command","params":{"command":"d'
        )
      )
      setTimeout(() => {
        adapter.websocketFrames.push(
          createChatGptWebSocketAppendFrame('ir"}}</tool>')
        )
        adapter.websocketFrames.push(createChatGptWebSocketFinishFrame())
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
      adapter.websocketFrames.push(
        createChatGptWebSocketFrame('still streaming')
      )
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
  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(createChatGptWebSocketFrame('done', true))
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
  adapter.websocketFrames = []

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
      adapter.websocketFrames.push(createChatGptWebSocketFrame('done', true))
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

test('ChatGPTAdapter changes the declared model through the intelligence picker', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTModelPage()
  adapter.page = page

  await adapter.changeModel({ key: 'chatgpt', option: null })

  assert.deepEqual(page.events, [
    'click:pill',
    'click:model-menu',
    'click:model:0',
  ])
})

test('ChatGPTAdapter changes model without changing mode', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTModelPage()
  adapter.page = page

  await adapter.changeModel({ key: 'chatgpt', option: null })

  assert.deepEqual(page.events, [
    'click:pill',
    'click:model-menu',
    'click:model:0',
  ])
})

test('ChatGPTAdapter changes model through the direct radio menu', async () => {
  const adapter = createTestChatGPTAdapter()
  const page = createChatGPTDirectModelPage()
  adapter.page = page

  await adapter.changeModel({ key: 'chatgpt', option: null })

  assert.deepEqual(page.events, ['click:trigger', 'click:model:0'])
})

test('ChatGPTAdapter rejects ambiguous visible model selectors', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.page = createChatGPTDirectModelPage({ triggerCount: 2 })

  await assert.rejects(
    adapter.changeModel({ key: 'chatgpt', option: null }),
    /missing or ambiguous/
  )
})

test('ChatGPTAdapter rejects unsupported, unavailable, and optioned models', async () => {
  const adapter = createTestChatGPTAdapter()
  adapter.page = createChatGPTModelPage({ modelCount: 0 })

  await assert.rejects(
    adapter.changeModel({ key: 'name', option: null }),
    /ChatGPT does not support model "name"\./
  )
  await assert.rejects(
    adapter.changeModel({ key: 'chatgpt', option: null }),
    /ChatGPT does not have model 1\./
  )
  await assert.rejects(
    adapter.changeModel({ key: 'chatgpt', option: 'extended' }),
    /ChatGPT does not support model "chatgpt" with option "extended"\./
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
        return {
          count: async () => 1,
          first: () => readySpeechButton,
        }
      }
      if (selector === 'button[data-testid="send-button"]') {
        return {
          count: async () => 1,
          first: () => readyDataTestIdSendButton,
        }
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
}: { modelCount?: number } = {}) {
  const events: string[] = []
  let pickerOpen = false
  let modelMenuOpen = false
  const modelItems = Array.from({ length: modelCount }, (_, index) => ({
    click: async () => {
      events.push(`click:model:${index}`)
    },
  }))
  const picker = {
    count: async () => (pickerOpen ? 1 : 0),
    first: () => picker,
    isVisible: async () => pickerOpen,
    locator: (selector: string) => {
      if (
        selector === joinCssLocatorCandidates(CHATGPT_LOCATORS.modelMenuItem)
      ) {
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
      if (selector === CHATGPT_MODEL_DIRECT_MENU_SELECTOR) {
        return { count: async () => 0, first: () => picker }
      }
      if (selector === CHATGPT_MODEL_TRIGGER_SELECTOR) {
        const trigger = {
          count: async () => 1,
          first: () => trigger,
          click: async () => {
            events.push('click:pill')
            pickerOpen = true
          },
        }
        return trigger
      }
      if (selector === CHATGPT_MODEL_PICKER_SELECTOR) {
        return picker
      }
      if (
        selector ===
        mapCssLocatorCandidates(
          CHATGPT_LOCATORS.modelItem,
          (candidate) => `[id="chatgpt-model-menu"] ${candidate}`
        )
      ) {
        return modelMenu
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }
}

function createChatGPTDirectModelPage({
  modelCount = 2,
  triggerCount = 1,
  menuCount = 1,
}: {
  modelCount?: number
  triggerCount?: number
  menuCount?: number
} = {}) {
  const events: string[] = []
  let menuOpen = false
  const modelItems = Array.from({ length: modelCount }, (_, index) => ({
    click: async () => {
      events.push(`click:model:${index}`)
    },
  }))
  const directModelItems = {
    count: async () => (menuOpen ? modelItems.length : 0),
    nth: (index: number) => modelItems[index],
  }
  const picker = {
    isVisible: async () => false,
  }
  const pickerCollection = {
    count: async () => 0,
    first: () => picker,
  }
  const menu = {
    locator: (selector: string) => {
      assert.equal(
        selector,
        joinCssLocatorCandidates(CHATGPT_LOCATORS.modelDirectItem)
      )
      return directModelItems
    },
  }
  const directMenus = {
    count: async () => (menuOpen ? menuCount : 0),
    first: () => menu,
  }
  const trigger = {
    click: async () => {
      events.push('click:trigger')
      menuOpen = true
    },
  }

  return {
    events,
    locator: (selector: string) => {
      if (selector === CHATGPT_MODEL_DIRECT_MENU_SELECTOR) return directMenus
      if (selector === CHATGPT_MODEL_TRIGGER_SELECTOR) {
        return {
          count: async () => triggerCount,
          first: () => trigger,
        }
      }
      if (selector === CHATGPT_MODEL_PICKER_SELECTOR) {
        return pickerCollection
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
  const capabilityTrigger = {
    click: async () => {
      events.push('click:plus')
      menuOpen = true
    },
  }
  return {
    events,
    locator: (selector: string) => {
      if (
        selector ===
        joinCssLocatorCandidates(CHATGPT_LOCATORS.capabilityTrigger)
      ) {
        return capabilityTrigger
      }
      if (
        selector !== joinCssLocatorCandidates(CHATGPT_LOCATORS.capabilityGroup)
      ) {
        throw new Error(`Unexpected selector: ${selector}`)
      }
      return {
        nth: (index: number) => (index === 1 ? capabilityGroup : uploadGroup),
      }
    },
  }
}
