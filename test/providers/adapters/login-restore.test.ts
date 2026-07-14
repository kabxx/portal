import test from 'node:test'
import assert from 'node:assert/strict'

import { ProviderAdapterError } from '../../../src/providers/adapters/adapter-base.ts'
import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { GrokAdapter } from '../../../src/providers/adapters/adapter-grok.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'

function createMockPage({
  afterGotoUrl,
  visibleByTestId = {},
  visibleByLocator = {},
  enabledByLocator = {},
}: {
  afterGotoUrl: string
  visibleByTestId?: Record<string, boolean>
  visibleByLocator?: Record<string, boolean>
  enabledByLocator?: Record<string, boolean>
}) {
  let currentUrl = 'about:blank'

  return {
    goto: async () => {
      currentUrl = afterGotoUrl
    },
    url: () => currentUrl,
    getByTestId: (testId: string) => ({
      isVisible: async () => visibleByTestId[testId] ?? false,
    }),
    getByRole: () => ({
      isVisible: async () => false,
    }),
    locator: (selector: string) => ({
      isVisible: async () => visibleByLocator[selector] ?? false,
      isEnabled: async () => enabledByLocator[selector] ?? false,
      first() {
        return this
      },
    }),
  }
}

test('ChatGPTAdapter.restore reports auth when login button is visible', async () => {
  const adapter = Object.create(ChatGPTAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://chatgpt.com',
    visibleByTestId: { 'login-button': true },
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GeminiAdapter.restore reports auth when signed-out panel is visible', async () => {
  const adapter = Object.create(GeminiAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://gemini.google.com/app',
    visibleByLocator: {
      '[data-test-id="conversations-list-signed-out"]': true,
    },
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GeminiAdapter.restore waits for the microphone ready signal before succeeding', async () => {
  const adapter = Object.create(GeminiAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://gemini.google.com/app',
    locator: (selector: string) => {
      if (selector === '[data-test-id="conversations-list-signed-out"]') {
        return {
          isVisible: async () => false,
        }
      }
      if (
        selector ===
        'button.speech_dictation_mic_button, [data-node-type="speech_dictation_mic_button"] .speech_dictation_mic_button, speech-dictation-mic-button .speech_dictation_mic_button'
      ) {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
          isEnabled: async () => checks >= 3,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})

test('DeepSeekAdapter.restore reports auth when redirected to /sign_in', async () => {
  const adapter = Object.create(DeepSeekAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://chat.deepseek.com/sign_in',
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('DeepSeekAdapter.restore waits for the ready button signal before succeeding', async () => {
  const adapter = Object.create(DeepSeekAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://chat.deepseek.com/a/chat/s/conv-1',
    locator: (selector: string) => {
      if (selector === 'div[role="button"][class*="bd74640a"]') {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})

test('DoubaoAdapter.restore reports auth when login button is visible', async () => {
  const adapter = Object.create(DoubaoAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://www.doubao.com/chat',
    visibleByLocator: { 'button.login-btn-header-CTKsn1': true },
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('DoubaoAdapter.restore waits for the ready container signal before succeeding', async () => {
  const adapter = Object.create(DoubaoAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://www.doubao.com/chat',
    locator: (selector: string) => {
      if (selector === 'button.login-btn-header-CTKsn1') {
        return {
          isVisible: async () => false,
        }
      }
      if (selector === 'div[class*="container-YCWnMI"]') {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})

test('GrokAdapter.restore reports auth when signed-out actions are visible', async () => {
  const adapter = Object.create(GrokAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://grok.com',
    visibleByLocator: {
      '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]': true,
    },
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GrokAdapter.restore waits for the composer ready signal before succeeding', async () => {
  const adapter = Object.create(GrokAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://grok.com',
    locator: (selector: string) => {
      if (
        selector ===
        '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]'
      ) {
        return {
          isVisible: async () => false,
        }
      }
      if (
        selector ===
        '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]'
      ) {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
          getAttribute: async (name: string) =>
            name === 'aria-disabled' ? 'false' : null,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})

test('GlmAdapter.restore reports auth when the signed-out avatar is visible', async () => {
  const adapter = Object.create(GlmAdapter.prototype) as any
  adapter.page = createMockPage({
    afterGotoUrl: 'https://chat.z.ai/',
    visibleByLocator: {
      '#send-message-button': true,
      'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox="0 0 20 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]': true,
    },
  })

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GlmAdapter.restore only requires the send button to be visible', async () => {
  const adapter = Object.create(GlmAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://chat.z.ai/',
    locator: (selector: string) => {
      if (selector === '#send-message-button') {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
          isEnabled: async () => false,
        }
      }
      if (
        selector ===
        'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox="0 0 20 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]'
      ) {
        return {
          first() {
            return this
          },
          isVisible: async () => false,
        }
      }
      if (selector === '[data-dialog-overlay][data-state="open"]') {
        return {
          first() {
            return this
          },
          isVisible: async () => false,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})

test('ChatGPTAdapter.restore waits for the speech button ready signal before succeeding', async () => {
  const adapter = Object.create(ChatGPTAdapter.prototype) as any
  let checks = 0
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://chatgpt.com',
    getByTestId: (testId: string) => ({
      isVisible: async () => {
        assert.equal(testId, 'login-button')
        return false
      },
    }),
    locator: (selector: string) => {
      if (
        selector === '#modal-no-auth-login' ||
        selector === '#modal-expired-session'
      ) {
        return {
          isVisible: async () => false,
        }
      }
      if (selector === 'button[style*="--vt-composer-speech-button"]') {
        return {
          first() {
            return this
          },
          isVisible: async () => {
            checks += 1
            return checks >= 3
          },
          isEnabled: async () => checks >= 3,
        }
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
  }

  await adapter.restore()

  assert.ok(checks >= 3)
})
