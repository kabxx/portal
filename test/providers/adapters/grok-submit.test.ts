import test from 'node:test'
import assert from 'node:assert/strict'

import { ProviderAdapterUnsupportedError } from '../../../src/providers/adapters/adapter-base.ts'
import { GrokAdapter } from '../../../src/providers/adapters/adapter-grok.ts'
import { createPrototypeObject } from '../../helpers/fakes.ts'

const GROK_VOICE_MODE_READY_SELECTOR =
  'form:has([data-testid="chat-input"]) div:has(> [data-query-bar-mode-select]) button[type="button"]:has(> div > div:nth-child(6):last-child)'

type GrokAdapterHarness = Pick<GrokAdapter, keyof GrokAdapter> & {
  page: unknown
  websocketFrames: string[]
  parseWebSocketResponse(frames: readonly string[]): {
    conversationId?: string
    text: string
    isFinished: boolean
  } | null
}

function createTestGrokAdapter(): GrokAdapterHarness {
  return createPrototypeObject(GrokAdapter.prototype) as GrokAdapterHarness
}

test('GrokAdapter.submit waits for Grok websocket response.done', async () => {
  const adapter = createTestGrokAdapter()
  const page = createGrokPage()
  const streamedTexts: string[] = []
  adapter.websocketFrames = page.websocketFrames
  adapter.page = page
  adapter.setSubmitTextReporter(async (message: string) => {
    streamedTexts.push(message)
  })

  const result = await adapter.submit()

  assert.equal(result, 'Grok response complete.')
  assert.deepEqual(page.events, ['click:submit'])
  assert.equal(streamedTexts.at(-1), 'Grok response complete.')
})

test('GrokAdapter websocket parsing does not finish from text chunks alone', () => {
  const adapter = createTestGrokAdapter()

  const parsed = adapter.parseWebSocketResponse([
    buildResponseFrame('conv-1', 'partial text', false),
  ])

  assert.deepEqual(parsed, {
    conversationId: 'conv-1',
    text: 'partial text',
    isFinished: false,
  })
})

test('GrokAdapter changes model through the model menu', async () => {
  const adapter = createTestGrokAdapter()
  const page = createGrokPage({
    modelItemCount: 4,
  })
  adapter.page = page

  await adapter.changeModel('2')

  assert.deepEqual(page.events, ['click:model-trigger', 'click:model:1'])
})

test('GrokAdapter rejects unsupported model names', async () => {
  const adapter = createTestGrokAdapter()
  adapter.page = createGrokPage({
    modelItemCount: 2,
  })

  await assert.rejects(
    adapter.changeModel('auto'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message === 'Grok does not support model "auto".'
  )
  await assert.rejects(
    adapter.changeModel('3'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message === 'Grok does not have model 3.'
  )
})

test('GrokAdapter rejects model selection that redirects to subscribe', async () => {
  const adapter = createTestGrokAdapter()
  adapter.page = createGrokPage({
    modelItemCount: 4,
    subscribeModelIndex: 2,
  })

  await assert.rejects(
    adapter.changeModel('3'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message === 'Grok model 3 requires a subscription.'
  )
})

test('GrokAdapter.attachFile writes files into the hidden Grok file input', async () => {
  const adapter = createTestGrokAdapter()
  const page = createGrokPage({
    fileInputAvailable: true,
  })
  adapter.page = page

  await adapter.attachFile(['C:/tmp/a.png', 'C:/tmp/b.txt'])

  assert.deepEqual(page.files, ['C:/tmp/a.png', 'C:/tmp/b.txt'])
})

test('GrokAdapter.attachFile reports unsupported when the file input is missing', async () => {
  const adapter = createTestGrokAdapter()
  adapter.page = createGrokPage()

  await assert.rejects(
    adapter.attachFile('C:/tmp/a.png'),
    (error) =>
      error instanceof ProviderAdapterUnsupportedError &&
      error.message ===
        'Grok file upload is not available in the current conversation.'
  )
})

test('GrokAdapter.stopGeneration clicks the visible stop icon button when present', async () => {
  const adapter = createTestGrokAdapter()
  const page = createGrokPage({
    stopButtonAvailable: true,
  })
  adapter.page = page

  await adapter.stopGeneration()

  assert.deepEqual(page.events, ['click:stop'])
})

test('GrokAdapter.stopGeneration is a no-op when the stop icon is missing', async () => {
  const adapter = createTestGrokAdapter()
  const page = createGrokPage()
  adapter.page = page

  await adapter.stopGeneration()

  assert.deepEqual(page.events, [])
})

function createGrokPage({
  fileInputAvailable = false,
  modelItemCount = 0,
  subscribeModelIndex = null,
  stopButtonAvailable = false,
}: {
  fileInputAvailable?: boolean
  modelItemCount?: number
  subscribeModelIndex?: number | null
  stopButtonAvailable?: boolean
} = {}) {
  const events: string[] = []
  const files: string[] = []
  let currentUrl = 'https://grok.com/chat/conv-1'
  let submitEnabled = true
  let submitVisible = true

  const input = {
    click: async () => undefined,
    isVisible: async () => true,
    getAttribute: async (name: string) =>
      name === 'aria-disabled' ? 'false' : null,
  }
  const submitButton = {
    isVisible: async () => true,
    isEnabled: async () => submitEnabled,
    click: async () => {
      events.push('click:submit')
      setTimeout(() => {
        page.websocketFrames.push(
          buildResponseFrame('conv-1', 'Grok response', false)
        )
      }, 20)
      setTimeout(() => {
        page.websocketFrames.push(
          buildResponseFrame('conv-1', ' complete.', false)
        )
      }, 60)
      setTimeout(() => {
        page.websocketFrames.push(buildResponseFrame('conv-1', '', true))
        submitVisible = false
        submitEnabled = false
      }, 90)
    },
  }
  const fileInput = {
    count: async () => (fileInputAvailable ? 1 : 0),
    first: () => fileInput,
    setInputFiles: async (path: string | readonly string[]) => {
      files.splice(
        0,
        files.length,
        ...(typeof path === 'string' ? [path] : [...path])
      )
    },
  }
  const modelTrigger = {
    first: () => modelTrigger,
    click: async () => {
      events.push('click:model-trigger')
    },
  }
  const modelItems = Array.from({ length: modelItemCount }, (_, index) => ({
    click: async () => {
      events.push(`click:model:${index}`)
      if (subscribeModelIndex === index) {
        currentUrl = 'https://grok.com/#subscribe'
      }
    },
  }))
  const modelMenu = {
    last: () => modelMenu,
    isVisible: async () => true,
    locator: (selector: string) => {
      if (
        selector ===
        'xpath=./div[@role="menuitem" and contains(@class, "ps-2.5") and contains(@class, "flex-row")]'
      ) {
        return {
          count: async () => modelItems.length,
          nth: (index: number) => modelItems[index] ?? missingModelItem,
        }
      }
      throw new Error(`Unexpected model menu selector: ${selector}`)
    },
  }
  const stopButton = {
    isVisible: async () => true,
    click: async () => {
      events.push('click:stop')
    },
  }

  const page = {
    events,
    files,
    websocketFrames: [] as string[],
    url: () => currentUrl,
    keyboard: {
      insertText: async () => undefined,
    },
    locator: (selector: string) => {
      if (
        selector ===
        '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]'
      ) {
        return {
          first: () => input,
        }
      }
      if (selector === '[data-testid="chat-submit"]') {
        return {
          count: async () => (submitVisible ? 1 : 0),
          first: () => submitButton,
        }
      }
      if (selector === GROK_VOICE_MODE_READY_SELECTOR) {
        return {
          count: async () => 1,
          first: () => ({
            isVisible: async () => true,
          }),
        }
      }
      if (selector === 'input[type="file"][name="files"]') {
        return fileInput
      }
      if (selector === '#model-select-trigger') {
        return modelTrigger
      }
      if (
        selector ===
        '[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]'
      ) {
        return modelMenu
      }
      if (
        selector.startsWith('button:has(svg[viewBox^="0 0 24"]') &&
        selector.includes('path[d^=')
      ) {
        return {
          count: async () => (stopButtonAvailable ? 1 : 0),
          first: () => (stopButtonAvailable ? stopButton : missingStopButton),
        }
      }
      throw new Error(`Unexpected selector: ${selector}`)
    },
  }

  return page
}

const missingModelItem = {
  click: async () => {
    throw new Error('Missing model item.')
  },
}

const missingStopButton = {
  isVisible: async () => false,
  click: async () => {
    throw new Error('Missing stop button.')
  },
}

function buildResponseFrame(
  conversationId: string,
  text: string,
  done: boolean
): string {
  return JSON.stringify({
    session_id: conversationId,
    event: done
      ? {
          type: 'response.done',
          response: {
            status: 'completed',
          },
        }
      : {
          type: 'response.chunk',
          chunk: {
            text: {
              channel: 'CHANNEL_ASSISTANT_RESPONSE',
              text,
            },
          },
        },
  })
}
