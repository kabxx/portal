import {
  ProviderAdapter,
  type AbortOptions,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from './adapter-base.ts'
import {
  abortable,
  isAbortError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { retryAsync } from '../../shared/retry.ts'
import { waitAsync } from '../../shared/wait.ts'
import {
  emptyHistoryResult,
  parseGrokHistory,
} from '../conversation-history.ts'

const GROK_CHAT_URL = 'https://grok.com'
const GROK_SUBSCRIBE_URL = 'https://grok.com/#subscribe'
const GROK_SIGNED_OUT_ACTIONS_SELECTOR =
  '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]'
const GROK_INPUT_SELECTOR =
  '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]'
const GROK_SUBMIT_BUTTON_SELECTOR = '[data-testid="chat-submit"]'
const GROK_FILE_INPUT_SELECTOR = 'input[type="file"][name="files"]'
const GROK_MODEL_TRIGGER_SELECTOR = '#model-select-trigger'
const GROK_MODEL_MENU_SELECTOR =
  '[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]'
const GROK_MODEL_ITEM_SELECTOR =
  'xpath=./div[@role="menuitem" and contains(@class, "ps-2.5") and contains(@class, "flex-row")]'
const GROK_WEBSOCKET_URL = 'wss://grok.com/ws/mgw/'
const GROK_STOP_ICON_PATH_PREFIX = 'M4 9.2v5.6c0 1.116 0 1.673.11 2.134'

function normalizeToPathArray(path: string | readonly string[]): string[] {
  if (typeof path === 'string') {
    return [path]
  }
  return [...path]
}

function readGrokConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'grok.com') {
      return undefined
    }
    const match = url.pathname.match(/^\/(?:chat|c)\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

export class GrokAdapter extends ProviderAdapter {
  private conversationIdVal!: string | null
  private websocketFrames: string[] = []

  private getInput() {
    return this.page.locator(GROK_INPUT_SELECTOR).first()
  }

  private getSubmitButton() {
    return this.page.locator(GROK_SUBMIT_BUTTON_SELECTOR).first()
  }

  private async waitForComposerReady(
    action: 'restore' | 'submit',
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const input = this.getInput()
    await waitAsync(
      async () =>
        (await input.isVisible().catch(() => false)) &&
        (await input.getAttribute('aria-disabled').catch(() => null)) !==
          'true',
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'Grok did not become ready after loading.'
              : 'Grok finished responding, but the page did not become ready for the next message.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'grok_composer_missing',
            }
          )
        },
      }
    )
  }

  private async isSubmitButtonReady(): Promise<boolean> {
    const submitButton = this.getSubmitButton()
    return (
      (await submitButton.isVisible().catch(() => false)) &&
      (await submitButton.isEnabled().catch(() => false))
    )
  }

  private async isComposerIdle(): Promise<boolean> {
    const input = this.getInput()
    if (
      !(await input.isVisible().catch(() => false)) ||
      (await input.getAttribute('aria-disabled').catch(() => null)) === 'true'
    ) {
      return false
    }

    const submitButtonLocator = this.page.locator(GROK_SUBMIT_BUTTON_SELECTOR)
    if ((await submitButtonLocator.count().catch(() => 0)) === 0) {
      return true
    }

    const submitButton = submitButtonLocator.first()
    return (
      !(await submitButton.isVisible().catch(() => false)) ||
      !(await submitButton.isEnabled().catch(() => true))
    )
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ProviderAdapterUnsupportedError) {
      return false
    }
    if (error instanceof ProviderAdapterError) {
      if (error.retryable) {
        return true
      }
      return this.isRetryableError(error.cause)
    }
    if (!(error instanceof Error)) {
      return false
    }
    const message = error.message.toLowerCase()
    return (
      message.includes('timed out') ||
      message.includes('timeout') ||
      message.includes('net::') ||
      message.includes('network') ||
      message.includes('socket') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('connection closed') ||
      message.includes('connection reset') ||
      message.includes('target page, context or browser has been closed')
    )
  }

  protected async init(options: AbortOptions = {}) {
    await super.init(options)
    this.bindWebSocketListener()
    const { signal } = options
    this.conversationIdVal =
      readGrokConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore({ signal })
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      return this.page.url().startsWith(GROK_CHAT_URL)
    }
    try {
      await retryAsync(async () => {
        await this.wrapAdapterActionErrorAsync('restore', async () => {
          await abortable(
            this.page.goto(this.conversationUrl, {
              waitUntil: 'commit',
              timeout: this.getRestoreTimeoutMs(),
            }),
            signal
          )
          await waitAsync(async () => await isAvailable(), {
            timeoutMs: this.getRestoreTimeoutMs(),
            signal,
          })
        })
      })
      await waitAsync(async () => await isAvailable(), {
        timeoutMs: this.getRestoreTimeoutMs(),
        signal,
      })
      if (!(await this.isLoggedIn())) {
        throw new ProviderAdapterError(
          'restore',
          'Grok is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'grok_signed_out',
          }
        )
      }
      await this.waitForComposerReady(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'Grok restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'grok_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    throwIfAborted(options.signal)
    const nodeEntries = await this.getCapturedHistoryEntries(
      (entry) =>
        entry.method === 'GET' &&
        entry.status === 200 &&
        entry.url.includes('/response-node'),
      options
    )
    const responseEntries = await this.getCapturedHistoryEntries(
      (entry) =>
        entry.method === 'POST' &&
        entry.status === 200 &&
        entry.url.includes('/load-responses'),
      options
    )
    const nodes = nodeEntries.find((entry) => entry.chunks.join('').trim())
    const responses = responseEntries.find((entry) =>
      entry.chunks.join('').trim()
    )
    if (nodes === undefined || responses === undefined) {
      return emptyHistoryResult('Grok history response was not captured.')
    }
    return parseGrokHistory(nodes.chunks.join(''), responses.chunks.join(''))
  }

  public async isLoggedIn(): Promise<boolean> {
    if (!this.page.url().startsWith(GROK_CHAT_URL)) {
      return false
    }

    const signedOutActionsVisible = await this.page
      .locator(GROK_SIGNED_OUT_ACTIONS_SELECTOR)
      .isVisible()
      .catch(() => false)

    return !signedOutActionsVisible
  }

  public async changeModel(model: string): Promise<void> {
    const modelNumber = Number(model.trim())
    if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok does not support model "${model}".`
      )
    }
    const modelIndex = modelNumber - 1

    await this.page.locator(GROK_MODEL_TRIGGER_SELECTOR).first().click()
    const modelMenu = this.page.locator(GROK_MODEL_MENU_SELECTOR).last()
    await waitAsync(
      async () => await modelMenu.isVisible().catch(() => false),
      {
        timeoutMs: 5000,
      }
    )
    const modelItems = modelMenu.locator(GROK_MODEL_ITEM_SELECTOR)
    if ((await modelItems.count()) <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok does not have model ${modelNumber}.`
      )
    }
    await modelItems.nth(modelIndex).click()
    if (this.page.url() === GROK_SUBSCRIBE_URL) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok model ${modelNumber} requires a subscription.`
      )
    }
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      const input = this.getInput()
      await input.click()
      await this.page.keyboard.insertText(text)
    })
  }

  public async attachFile(_path: string | readonly string[]): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      const fileInput = this.page.locator(GROK_FILE_INPUT_SELECTOR).first()
      if ((await fileInput.count().catch(() => 0)) === 0) {
        throw new ProviderAdapterUnsupportedError(
          'attachFile',
          'Grok file upload is not available in the current conversation.'
        )
      }
      await fileInput.setInputFiles(normalizeToPathArray(_path))
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    const stopButton = this.page.locator(
      `button:has(svg[viewBox="0 0 24 24"] path[d^="${GROK_STOP_ICON_PATH_PREFIX}"])`
    )
    await this.clickLocatorIfReady(stopButton)
  }

  private bindWebSocketListener(): void {
    this.page.on('websocket', (websocket) => {
      if (!websocket.url().startsWith(GROK_WEBSOCKET_URL)) {
        return
      }
      websocket.on('framereceived', (event) => {
        const payload =
          typeof event.payload === 'string'
            ? event.payload
            : event.payload.toString('utf8')
        if (payload.trim()) {
          this.websocketFrames.push(payload)
        }
      })
    })
  }

  private parseWebSocketResponse(frames: readonly string[]): {
    conversationId: string | null
    text: string
    isFinished: boolean
  } {
    let conversationId: string | null = null
    let text = ''
    let isFinished = false

    for (const frame of frames) {
      let payload: unknown
      try {
        payload = JSON.parse(frame)
      } catch {
        continue
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        continue
      }
      const root = payload as Record<string, unknown>
      if (typeof root.session_id === 'string') {
        conversationId = root.session_id
      }
      const event = root.event
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        continue
      }
      const eventRecord = event as Record<string, unknown>
      if (eventRecord.type === 'response.done') {
        const response = eventRecord.response
        if (
          response &&
          typeof response === 'object' &&
          !Array.isArray(response) &&
          (response as Record<string, unknown>).status === 'completed'
        ) {
          isFinished = true
        }
        continue
      }
      if (eventRecord.type !== 'response.chunk') {
        continue
      }
      const chunk = eventRecord.chunk
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
        continue
      }
      const textRecord = (chunk as Record<string, unknown>).text
      if (
        !textRecord ||
        typeof textRecord !== 'object' ||
        Array.isArray(textRecord)
      ) {
        continue
      }
      const textPayload = textRecord as Record<string, unknown>
      if (
        textPayload.channel === 'CHANNEL_ASSISTANT_RESPONSE' &&
        typeof textPayload.text === 'string'
      ) {
        text += textPayload.text
      }
    }

    return { conversationId, text, isFinished }
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await waitAsync(async () => await this.isSubmitButtonReady(), {
          timeoutMs: this.getSubmitResponseTimeoutMs(),
          signal,
        })
        const websocketStartIndex = this.websocketFrames.length
        let warningTimer: NodeJS.Timeout | null = null
        const stopWarningTimer = () => {
          if (warningTimer !== null) {
            clearInterval(warningTimer)
            warningTimer = null
          }
        }
        const stopSubmitTextPolling = this.startSubmitTextPolling(async () => {
          const parsed = this.parseWebSocketResponse(
            this.websocketFrames.slice(websocketStartIndex)
          )
          return parsed.text.trim() ? parsed.text : null
        })
        try {
          await this.getSubmitButton().click()
          throwIfAborted(signal)
          await waitAsync(
            async () => {
              const parsed = this.parseWebSocketResponse(
                this.websocketFrames.slice(websocketStartIndex)
              )
              const responseStarted = parsed.text.trim() || parsed.isFinished
              if (responseStarted) {
                stopWarningTimer()
              }
              return Boolean(responseStarted)
            },
            {
              timeoutMs: this.getSubmitRequestStartGraceMs(),
              signal,
              onTimeout: async () => {
                const warningMessage = buildGrokSubmitBlockedWarningMessage()
                await this.emitSubmitStatus(warningMessage)
                warningTimer = setInterval(() => {
                  void this.emitSubmitStatusSafely(warningMessage)
                }, this.getSubmitBlockedWarningIntervalMs())
              },
            }
          )

          let parsedResponse = {
            conversationId: null as string | null,
            text: '',
            isFinished: false,
          }
          await waitAsync(
            async () => {
              throwIfAborted(signal)
              parsedResponse = this.parseWebSocketResponse(
                this.websocketFrames.slice(websocketStartIndex)
              )
              stopWarningTimer()
              return parsedResponse.isFinished
            },
            {
              timeoutMs: this.getSubmitResponseTimeoutMs(),
              signal,
              onTimeout: async () => {
                throw new ProviderAdapterError(
                  'submit',
                  'Timed out waiting for Grok websocket response to finish.',
                  {
                    kind: 'protocol',
                    recovery: 'restore',
                    retryable: true,
                    maxAttempts: 2,
                    detailCode: 'grok_response_finish_timeout',
                  }
                )
              },
            }
          )
          if (!parsedResponse.text.trim()) {
            throw new ProviderAdapterError(
              'submit',
              'Grok websocket response finished without assistant text.',
              {
                kind: 'protocol',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'grok_response_text_missing',
              }
            )
          }
          await waitAsync(async () => await this.isComposerIdle(), {
            timeoutMs: this.getSubmitResponseTimeoutMs(),
            signal,
          })
          await this.waitForComposerReady(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          this.conversationIdVal =
            this.conversationIdVal ??
            parsedResponse.conversationId ??
            readGrokConversationIdFromUrl(this.page.url()) ??
            null
          await this.emitSubmitText(parsedResponse.text)
          throwIfAborted(signal)
          return parsedResponse.text
        } finally {
          stopSubmitTextPolling()
          stopWarningTimer()
        }
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'Grok submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'grok_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    if (this.options?.conversationUrl) {
      return this.options.conversationUrl
    }
    return this.conversationId === null
      ? GROK_CHAT_URL
      : `${GROK_CHAT_URL}/chat/${encodeURIComponent(this.conversationId)}`
  }
}

function buildGrokSubmitBlockedWarningMessage(): string {
  return [
    'Grok submit has not started rendering a user message yet.',
    'Check the browser and complete any verification if needed.',
    'Waiting for the page to resume or for a response to start.',
  ].join('\n')
}
