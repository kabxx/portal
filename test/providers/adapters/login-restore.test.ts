import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderAdapter,
  ProviderAdapterError,
  type ProviderBrowserContext,
} from '../../../src/providers/adapters/adapter-base.ts'
import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { GrokAdapter } from '../../../src/providers/adapters/adapter-grok.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'
import { KimiAdapter } from '../../../src/providers/adapters/adapter-kimi.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

interface RestoreTestLocator {
  count?(): Promise<number>
  first?(): RestoreTestLocator
  nth?(index: number): RestoreTestLocator
  isVisible?(): Promise<boolean>
  isEnabled?(): Promise<boolean>
  getAttribute?(name: string): Promise<string | null>
}

interface RestoreTestPage {
  goto(): Promise<void>
  url(): string
  getByTestId?(testId: string): RestoreTestLocator
  getByRole?(): RestoreTestLocator
  locator(selector: string): RestoreTestLocator
}

function createRestorableAdapter(
  Adapter: new (context: ProviderBrowserContext) => ProviderAdapter,
  page: RestoreTestPage
): ProviderAdapter {
  const adapter = new Adapter(createBrowserContextStub())
  if (!Reflect.set(adapter, 'page', page)) {
    throw new Error('Failed to install the provider restore test page.')
  }
  return adapter
}

const GROK_VOICE_MODE_READY_SELECTOR =
  'form:has([data-testid="chat-input"]) div:has(> [data-query-bar-mode-select]) button[type="button"]:has(> div > div:nth-child(6):last-child)'

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
      count: async () => (visibleByLocator[selector] ? 1 : 0),
      isVisible: async () => visibleByLocator[selector] ?? false,
      isEnabled: async () => enabledByLocator[selector] ?? false,
      first() {
        return this
      },
      nth() {
        return this
      },
    }),
  }
}

test('ChatGPTAdapter.restore reports auth when login button is visible', async () => {
  const adapter = createRestorableAdapter(
    ChatGPTAdapter,
    createMockPage({
      afterGotoUrl: 'https://chatgpt.com',
      visibleByLocator: { '[data-testid="login-button"]': true },
    })
  )

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
  const adapter = createRestorableAdapter(
    GeminiAdapter,
    createMockPage({
      afterGotoUrl: 'https://gemini.google.com/app',
      visibleByLocator: {
        '[data-test-id="conversations-list-signed-out"]': true,
      },
    })
  )

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
  let countChecks = 0
  let checks = 0
  const adapter = createRestorableAdapter(GeminiAdapter, {
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
          count: async () => {
            countChecks += 1
            return countChecks >= 3 ? 1 : 2
          },
          first() {
            return this
          },
          nth() {
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
  })

  await adapter.restore()

  assert.ok(checks >= 3)
  assert.ok(countChecks >= 2)
})

test('DeepSeekAdapter.restore reports auth when redirected to /sign_in', async () => {
  const adapter = createRestorableAdapter(
    DeepSeekAdapter,
    createMockPage({
      afterGotoUrl: 'https://chat.deepseek.com/sign_in',
    })
  )

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
  let countChecks = 0
  let checks = 0
  const adapter = createRestorableAdapter(DeepSeekAdapter, {
    goto: async () => undefined,
    url: () => 'https://chat.deepseek.com/a/chat/s/conv-1',
    locator: (selector: string) => {
      if (selector === 'div[role="button"][class*="bd74640a"]') {
        return {
          count: async () => {
            countChecks += 1
            return countChecks >= 3 ? 1 : 2
          },
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
  })

  await adapter.restore()

  assert.ok(checks >= 3)
  assert.ok(countChecks >= 3)
})

test('DoubaoAdapter.restore reports auth when login button is visible', async () => {
  const adapter = createRestorableAdapter(
    DoubaoAdapter,
    createMockPage({
      afterGotoUrl: 'https://www.doubao.com/chat',
      visibleByLocator: { 'button.login-btn-header-CTKsn1': true },
    })
  )

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
  let countChecks = 0
  let checks = 0
  const adapter = createRestorableAdapter(DoubaoAdapter, {
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
          count: async () => {
            countChecks += 1
            return countChecks >= 3 ? 1 : 2
          },
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
  })

  await adapter.restore()

  assert.ok(checks >= 3)
  assert.ok(countChecks >= 3)
})

test('GrokAdapter.restore reports auth when signed-out actions are visible', async () => {
  const adapter = createRestorableAdapter(
    GrokAdapter,
    createMockPage({
      afterGotoUrl: 'https://grok.com',
      visibleByLocator: {
        '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]': true,
      },
    })
  )

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GrokAdapter.restore ignores an editable Composer and waits for one visible voice mode control', async () => {
  let countChecks = 0
  let visibilityChecks = 0
  const adapter = createRestorableAdapter(GrokAdapter, {
    goto: async () => undefined,
    url: () => 'https://grok.com',
    locator: (selector: string) => {
      if (
        selector ===
        '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]'
      ) {
        return {
          count: async () => 0,
          nth() {
            return this
          },
          isVisible: async () => false,
        }
      }
      if (
        selector ===
        '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]'
      ) {
        return {
          count: async () => 1,
          first() {
            return this
          },
          nth() {
            return this
          },
          isVisible: async () => true,
          getAttribute: async () => 'false',
        }
      }
      if (selector === GROK_VOICE_MODE_READY_SELECTOR) {
        return {
          count: async () => {
            countChecks += 1
            if (countChecks === 1) {
              return 0
            }
            return countChecks === 2 ? 2 : 1
          },
          first() {
            return this
          },
          nth() {
            return this
          },
          isVisible: async () => {
            visibilityChecks += 1
            return visibilityChecks >= 2
          },
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  })

  await adapter.restore()

  assert.ok(countChecks >= 2)
  assert.ok(visibilityChecks >= 2)
})

test('GlmAdapter.restore gives signed-out state priority over ready', async () => {
  const adapter = createRestorableAdapter(
    GlmAdapter,
    createMockPage({
      afterGotoUrl: 'https://chat.z.ai/',
      visibleByLocator: {
        '#send-message-button': true,
        'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox^="0 0 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]': true,
      },
    })
  )

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('KimiAdapter.restore gives the signed-out entry priority over its Composer', async () => {
  const adapter = createRestorableAdapter(
    KimiAdapter,
    createMockPage({
      afterGotoUrl: 'https://www.kimi.com/',
      visibleByLocator: {
        'button.next-sidebar-history-list__login': true,
        '.chat-editor .chat-input-editor[contenteditable="true"]': true,
        '.chat-editor .send-button-container': true,
        '.chat-editor .current-model': true,
      },
    })
  )

  let capturedError: unknown
  try {
    await adapter.restore()
  } catch (error) {
    capturedError = error
  }

  assert.ok(capturedError instanceof ProviderAdapterError)
  assert.equal(capturedError.kind, 'auth')
})

test('GlmAdapter.restore keeps waiting while the signed-out indicator is ambiguous', async () => {
  let signedOutCountChecks = 0
  let readyCountChecks = 0
  const adapter = createRestorableAdapter(GlmAdapter, {
    goto: async () => undefined,
    url: () => 'https://chat.z.ai/',
    locator: (selector: string) => {
      if (
        selector ===
        'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox^="0 0 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]'
      ) {
        return {
          count: async () => {
            signedOutCountChecks += 1
            return signedOutCountChecks <= 3 ? 2 : 0
          },
          first: () => ({
            isVisible: async () => {
              throw new Error('Ambiguous auth target must not be selected.')
            },
          }),
        }
      }
      if (selector === '#send-message-button') {
        return {
          count: async () => {
            assert.ok(signedOutCountChecks > 3)
            readyCountChecks += 1
            return 1
          },
          first() {
            return this
          },
          nth() {
            return this
          },
          isVisible: async () => true,
        }
      }
      if (selector === '[data-dialog-overlay][data-state="open"]') {
        return {
          first() {
            return this
          },
          nth() {
            return this
          },
          isVisible: async () => false,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  })

  await adapter.restore()

  assert.ok(signedOutCountChecks >= 4)
  assert.ok(readyCountChecks >= 2)
})

test('GlmAdapter.isLoggedIn fails closed for an ambiguous signed-out indicator', async () => {
  const adapter = createRestorableAdapter(GlmAdapter, {
    goto: async () => undefined,
    url: () => 'https://chat.z.ai/',
    locator: () => ({
      count: async () => 2,
      first: () => ({
        isVisible: async () => {
          throw new Error('Ambiguous auth target must not be selected.')
        },
      }),
    }),
  })

  assert.equal(await adapter.isLoggedIn(), false)
})

test('GlmAdapter.restore only requires the send button to be visible', async () => {
  let countChecks = 0
  let checks = 0
  const adapter = createRestorableAdapter(GlmAdapter, {
    goto: async () => undefined,
    url: () => 'https://chat.z.ai/',
    locator: (selector: string) => {
      if (selector === '#send-message-button') {
        return {
          count: async () => {
            countChecks += 1
            return countChecks >= 3 ? 1 : 2
          },
          first() {
            return this
          },
          nth() {
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
        'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox^="0 0 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]'
      ) {
        return {
          count: async () => 0,
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
  })

  await adapter.restore()

  assert.ok(checks >= 3)
  assert.ok(countChecks >= 3)
})

test('ChatGPTAdapter.restore waits for the speech button ready signal before succeeding', async () => {
  let countChecks = 0
  let checks = 0
  const adapter = createRestorableAdapter(ChatGPTAdapter, {
    goto: async () => undefined,
    url: () => 'https://chatgpt.com',
    getByTestId: (testId: string) => ({
      isVisible: async () => {
        assert.equal(testId, 'login-button')
        return false
      },
    }),
    locator: (selector: string) => {
      if (selector === '[data-testid="login-button"]') {
        return {
          isVisible: async () => false,
        }
      }
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
          count: async () => {
            countChecks += 1
            return countChecks >= 3 ? 1 : 2
          },
          first() {
            return this
          },
          nth() {
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
          count: async () => 0,
          first() {
            return this
          },
          nth() {
            return this
          },
          isVisible: async () => false,
          isEnabled: async () => false,
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  })

  await adapter.restore()

  assert.ok(checks >= 3)
  assert.ok(countChecks >= 3)
})
