import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

class TestChatGPTAdapter extends ChatGPTAdapter {
  public constructor() {
    super(createBrowserContextStub())
  }

  protected override getSubmitRequestStartGraceMs(): number {
    return 10
  }

  protected override getSubmitBlockedWarningIntervalMs(): number {
    return 10
  }
}

function installChatGPTTestPage(
  adapter: TestChatGPTAdapter,
  page: ReturnType<typeof createChatGPTPage>
): void {
  if (!Reflect.set(adapter, 'page', page)) {
    throw new Error('Failed to install the ChatGPT submit test page.')
  }
}

function installChatGPTWebSocketFrames(
  adapter: TestChatGPTAdapter,
  frames: string[]
): void {
  if (!Reflect.set(adapter, 'websocketFrames', frames)) {
    throw new Error('Failed to install the ChatGPT websocket frame buffer.')
  }
}

function createInitialWebSocketFrame(text: string): string {
  return JSON.stringify({
    conversation_id: 'conversation-1',
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      v: {
        message: {
          id: 'message-1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [text] },
          status: 'in_progress',
          end_turn: false,
          channel: 'final',
          metadata: {},
        },
      },
    })}`,
  })
}

function createAppendWebSocketFrame(text: string): string {
  return JSON.stringify({
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: text,
    })}`,
  })
}

function createFinishedWebSocketFrame(): string {
  return JSON.stringify({
    encoded_item: `event: delta\ndata: ${JSON.stringify({
      o: 'patch',
      v: [{ p: '/message/end_turn', o: 'replace', v: true }],
    })}`,
  })
}

test('ChatGPTAdapter.submit returns READY from websocket without waiting for a late HTTP response', async () => {
  const adapter = new TestChatGPTAdapter()
  const websocketFrames = [
    JSON.stringify({
      ref_id: 'turn0search0',
      url: 'https://old.example/reference',
    }),
  ]
  installChatGPTWebSocketFrames(adapter, websocketFrames)

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
      websocketFrames.push(createInitialWebSocketFrame('READY'))
      websocketFrames.push(
        createAppendWebSocketFrame(' \uE200cite\uE202turn0search0\uE202\uE201')
      )
      websocketFrames.push(createFinishedWebSocketFrame())
    },
  }
  const page = createChatGPTPage(sendButton)
  installChatGPTTestPage(adapter, page)
  adapter.setSubmitStatusReporter(null)
  const result = await adapter.submit()

  assert.equal(result, 'READY')
})

function createChatGPTPage(sendButton: {
  isEnabled: () => Promise<boolean>
  isVisible: () => Promise<boolean>
  click: () => Promise<void>
}) {
  const emitter = new EventEmitter()
  const speechButton = {
    first: () => speechButton,
    isVisible: async () => true,
    isEnabled: async () => true,
  }

  return {
    locator: (selector: string) => {
      if (selector === '#composer-submit-button') {
        return sendButton
      }
      if (selector === 'button[style*="--vt-composer-speech-button"]') {
        return {
          count: async () => 1,
          first: () => speechButton,
        }
      }
      if (selector === 'button[data-testid="send-button"]') {
        return {
          count: async () => 0,
          first() {
            return this
          },
          isVisible: async () => false,
          isEnabled: async () => false,
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
