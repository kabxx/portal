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
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import { GrokUi } from '../ui/grok/grok-ui.ts'

const GROK_CHAT_URL = 'https://grok.com'
const GROK_WEBSOCKET_URL = 'wss://grok.com/ws/mgw/'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  protected override get composerLimitProvider() {
    return 'grok' as const
  }

  private conversationIdVal!: string | null
  private websocketFrames: string[] = []
  private get providerUi(): GrokUi {
    return new GrokUi(this.page)
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
      await this.providerUi.waitForVoiceModeReady(
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

    return !(await this.providerUi.isSignedOutVisible())
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.providerUi.selectModel(model)
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.providerUi.attachText(text)
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const getLocators = () => this.providerUi.getRetryLocators()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Grok',
      isComposerReady: async () =>
        await this.isRetryComposerReady(getLocators().composer),
      readComposerText: async () =>
        await this.readRetryComposerText(getLocators().composer),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(getLocators().composer),
      isStopActive: async () =>
        await this.isRetryControlActive(getLocators().stop),
      isSendReady: async () =>
        await this.isRetryControlReady(getLocators().send),
    })
  }

  public async attachFile(_path: string | readonly string[]): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.providerUi.attachFile(_path)
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.providerUi.stopGeneration()
  }

  private bindWebSocketListener(): void {
    this.page.on('websocket', (websocket) => {
      if (!websocket.url().startsWith(GROK_WEBSOCKET_URL)) {
        return
      }
      websocket.on('framereceived', (event) => {
        this.emitSubmitActivitySafely()
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
      if (!isRecord(payload)) {
        continue
      }
      if (typeof payload.session_id === 'string') {
        conversationId = payload.session_id
      }
      const event = payload.event
      if (!isRecord(event)) {
        continue
      }
      if (event.type === 'response.done') {
        const response = event.response
        if (isRecord(response) && response.status === 'completed') {
          isFinished = true
        }
        continue
      }
      if (event.type !== 'response.chunk') {
        continue
      }
      const chunk = event.chunk
      if (!isRecord(chunk)) {
        continue
      }
      const textRecord = chunk.text
      if (!isRecord(textRecord)) {
        continue
      }
      if (
        textRecord.channel === 'CHANNEL_ASSISTANT_RESPONSE' &&
        typeof textRecord.text === 'string'
      ) {
        text += textRecord.text
      }
    }

    return { conversationId, text, isFinished }
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await waitAsync(async () => await this.providerUi.isSubmitReady(), {
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
          this.emitSubmitDispatching(signal)
          await this.providerUi.clickSubmit()
          this.emitSubmitSent()
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
          await waitAsync(async () => await this.providerUi.isComposerIdle(), {
            timeoutMs: this.getSubmitResponseTimeoutMs(),
            signal,
          })
          await this.providerUi.waitForVoiceModeReady(
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
