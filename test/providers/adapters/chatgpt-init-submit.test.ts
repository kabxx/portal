import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { createPrototypeObject } from '../../helpers/fakes.ts'

type ChatGPTInitHarness = Pick<ChatGPTAdapter, keyof ChatGPTAdapter> & {
  page: unknown
  websocketFrames: string[]
  parseHttpResponse: unknown
  parseWebsocketResponse: unknown
  getSubmitRequestStartGraceMs(): number
  getSubmitBlockedWarningIntervalMs(): number
}

test('ChatGPTAdapter.submit returns READY from websocket without waiting for a late HTTP response', async () => {
  const adapter = createPrototypeObject(
    ChatGPTAdapter.prototype
  ) as ChatGPTInitHarness
  adapter.websocketFrames = ['frame-ready']
  adapter.parseWebsocketResponse = () => ({
    text: 'READY',
    isFinished: true,
  })
  adapter.parseHttpResponse = () => null

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
    },
  }
  const page = createChatGPTPage(sendButton)
  adapter.page = page
  adapter.setSubmitStatusReporter(null)
  adapter.getSubmitRequestStartGraceMs = () => 10
  adapter.getSubmitBlockedWarningIntervalMs = () => 10
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
        return speechButton
      }
      if (selector === 'button[data-testid="send-button"]') {
        return {
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
