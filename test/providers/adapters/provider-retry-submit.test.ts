import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { GrokAdapter } from '../../../src/providers/adapters/adapter-grok.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'
import { KimiAdapter } from '../../../src/providers/adapters/adapter-kimi.ts'
import { QwenAdapter } from '../../../src/providers/adapters/adapter-qwen.ts'
import type { ProviderAdapter } from '../../../src/providers/adapters/adapter-base.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

type ControlKind = 'composer' | 'send' | 'stop' | 'other'

interface ProviderRetryHarnessCase {
  name: string
  create(): ProviderAdapter
  composer: readonly string[]
  send: readonly string[]
  stop: readonly string[]
}

class RetryPageHarness {
  public text = ''
  public readonly keyboard = {
    insertText: async (value: string) => {
      this.text += value
    },
  }

  public constructor(private readonly config: ProviderRetryHarnessCase) {}

  public locator(selector: string): RetryLocatorHarness {
    return new RetryLocatorHarness(this, selector)
  }

  public classify(selector: string): ControlKind {
    if (this.config.stop.some((value) => selector.includes(value)))
      return 'stop'
    if (this.config.composer.some((value) => selector.includes(value))) {
      return 'composer'
    }
    if (this.config.send.some((value) => selector.includes(value)))
      return 'send'
    return 'other'
  }
}

class RetryLocatorHarness {
  public constructor(
    private readonly page: RetryPageHarness,
    private readonly selector: string
  ) {}

  private get kind(): ControlKind {
    return this.page.classify(this.selector)
  }

  public first(): this {
    return this
  }

  public last(): this {
    return this
  }

  public nth(_index: number): this {
    return this
  }

  public locator(selector: string): RetryLocatorHarness {
    return new RetryLocatorHarness(this.page, `${this.selector} ${selector}`)
  }

  public async count(): Promise<number> {
    return this.kind === 'composer' || this.kind === 'send' ? 1 : 0
  }

  public async isVisible(): Promise<boolean> {
    return this.kind === 'composer' || this.kind === 'send'
  }

  public async isEnabled(): Promise<boolean> {
    return this.kind === 'composer' || this.kind === 'send'
  }

  public async isEditable(): Promise<boolean> {
    return this.kind === 'composer'
  }

  public async click(): Promise<void> {}

  public async evaluate(pageFunction: unknown): Promise<unknown> {
    if (String(pageFunction).includes('dispatchEvent')) {
      this.page.text = ''
      return undefined
    }
    return this.page.text
  }
}

const context = createBrowserContextStub()
const cases: ProviderRetryHarnessCase[] = [
  {
    name: 'ChatGPT',
    create: () => new ChatGPTAdapter(context),
    composer: ['#prompt-textarea'],
    send: ['#composer-submit-button'],
    stop: ['stop-button'],
  },
  {
    name: 'Gemini',
    create: () => new GeminiAdapter(context),
    composer: ['textarea-wrapper', 'textarea-inner', 'rich-textarea'],
    send: ['send-button-container'],
    stop: [' normalize-space(@class)', ' stop '],
  },
  {
    name: 'DeepSeek',
    create: () => new DeepSeekAdapter(context),
    composer: ['textarea'],
    send: ['div._52c986b'],
    stop: ['M14.456 8.012'],
  },
  {
    name: 'Doubao',
    create: () => new DoubaoAdapter(context),
    composer: ['semi-input-textarea', 'role="textbox"'],
    send: ['bg-g-send-msg-btn-bg'],
    stop: ['break-btn-fISNgC'],
  },
  {
    name: 'Grok',
    create: () => new GrokAdapter(context),
    composer: ['data-testid="chat-input"'],
    send: ['data-testid="chat-submit"'],
    stop: ['M4 9.2v5.6'],
  },
  {
    name: 'GLM',
    create: () => new GlmAdapter(context),
    composer: ['#chat-input'],
    send: ['#send-message-button'],
    stop: ['messageInputContainer'],
  },
  {
    name: 'Kimi',
    create: () => new KimiAdapter(context),
    composer: ['chat-input-editor'],
    send: ['send-button-container:not'],
    stop: ['send-button-container.stop'],
  },
  {
    name: 'Qwen',
    create: () => new QwenAdapter(context),
    composer: ['message-input-textarea'],
    send: ['button.send-button'],
    stop: ['button.stop-button'],
  },
]

for (const providerCase of cases) {
  test(`${providerCase.name} retry transaction writes, verifies, and clears its Composer`, async () => {
    const adapter = providerCase.create()
    const page = new RetryPageHarness(providerCase)
    Reflect.set(adapter, 'page', page)
    const prepare: unknown = Reflect.get(adapter, 'prepareRetrySubmit')
    if (typeof prepare !== 'function') {
      assert.fail('Adapter retry preparation is unavailable.')
    }

    const clear: unknown = await Reflect.apply(prepare, adapter, [
      'retry payload',
      {},
    ])
    if (typeof clear !== 'function') {
      assert.fail('Adapter retry cleanup is unavailable.')
    }
    assert.equal(page.text, 'retry payload')

    await Reflect.apply(clear, undefined, [])
    assert.equal(page.text, '')
  })
}
