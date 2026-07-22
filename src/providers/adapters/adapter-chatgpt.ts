import {
  ProviderAdapter,
  type AbortOptions,
  awaitWithTimeout,
  buildSubmitBlockedWarningMessage,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  createDeferred,
  delayAsync,
} from './adapter-base.ts'
import {
  abortable,
  isAbortError,
  toError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { retryAsync } from '../../shared/retry.ts'
import { waitAsync } from '../../shared/wait.ts'
import {
  emptyHistoryResult,
  parseChatGptHistory,
} from '../conversation-history.ts'
import {
  parseChatGptHttpResponse,
  parseChatGptWebSocketFrames,
  type ChatGPTParsedResponse,
} from '../chatgpt-response-parser.ts'

const CHATGPT_CHAT_URL = 'https://chatgpt.com'
const CHATGPT_CHAT_WS_URL = 'wss://ws.chatgpt.com/p18/ws/user'
const CHATGPT_PLUS_MENU_GROUP_SELECTOR =
  'div[role="group"][class*="empty:hidden"]'
const CHATGPT_INTELLIGENCE_PICKER_SELECTOR =
  'div[data-testid="composer-intelligence-picker-content"]'
const CHATGPT_ACTION_CAPABILITIES = [
  'image_create',
  'web_search',
  'deep_research',
  'openai_platform',
] as const
const CHATGPT_RESPONSE_IDLE_TIMEOUT_MS = 60000
const CHATGPT_FINISHED_RESPONSE_SETTLE_MS = 1000

function toCssString(value: string): string {
  return JSON.stringify(value)
}

export type ChatGPTActionCapability =
  (typeof CHATGPT_ACTION_CAPABILITIES)[number]

export type ChatGPTActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

export interface ChatGPTActionCapabilityInfo {
  name: ChatGPTActionCapability
  state: ChatGPTActionCapabilityState
}

const CHATGPT_RESPONSE_STABLE_POLLS = 3

function readChatGPTConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com') {
      return undefined
    }
    const match = url.pathname.match(/^\/c\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

export class ChatGPTAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'chatgpt' as const
  }

  private lastParsedResponse!: ChatGPTParsedResponse | null
  private websocketFrames!: string[]

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
    const { signal } = options
    const initialConversationId = readChatGPTConversationIdFromUrl(
      this.options.conversationUrl
    )
    this.lastParsedResponse = initialConversationId
      ? {
          conversationId: initialConversationId,
          text: '',
          isFinished: true,
        }
      : null
    this.websocketFrames = []
    this.bindWebSocketListener()
    await this.restore({ signal })
  }

  private bindWebSocketListener(): void {
    this.page.on('websocket', (websocket) => {
      if (!websocket.url().startsWith(CHATGPT_CHAT_WS_URL)) {
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

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      return this.page.url().startsWith(CHATGPT_CHAT_URL)
    }
    try {
      await retryAsync(async () => {
        await this.wrapAdapterActionErrorAsync('restore', async () => {
          await abortable(this.page.goto(this.conversationUrl), signal)
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
          'ChatGPT is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_signed_out',
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
          'ChatGPT restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'chatgpt_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    throwIfAborted(options.signal)
    const entries = await this.getCapturedHistoryEntries(
      (entry) =>
        entry.method === 'GET' &&
        entry.status === 200 &&
        /\/backend-api\/conversation\/[^/?#]+$/.test(entry.url),
      options
    )
    for (const entry of entries) {
      const result = parseChatGptHistory(entry.chunks.join(''))
      if (result.complete) return result
    }
    return emptyHistoryResult('ChatGPT history response was not captured.')
  }

  public async isLoggedIn(): Promise<boolean> {
    if (!this.page.url().startsWith(CHATGPT_CHAT_URL)) {
      return false
    }

    const loginButtonVisible = await this.page
      .getByTestId('login-button')
      .isVisible()
      .catch(() => false)
    const noAuthModalVisible = await this.page
      .locator('#modal-no-auth-login')
      .isVisible()
      .catch(() => false)
    const expiredSessionVisible = await this.page
      .locator('#modal-expired-session')
      .isVisible()
      .catch(() => false)

    return !loginButtonVisible && !noAuthModalVisible && !expiredSessionVisible
  }

  public async changeModel(model: string): Promise<void> {
    const normalized = model.trim()
    const match = normalized.match(/^([1-9]\d*)(?:\+([1-9]\d*))?$/)
    if (match === null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `ChatGPT does not support model "${model}".`
      )
    }
    const modelNumber = Number(match[1])
    const modeNumber = match[2] === undefined ? null : Number(match[2])
    const modelIndex = modelNumber - 1
    const modeIndex = modeNumber === null ? null : modeNumber - 1
    const directMenus = this.page.locator('[role="menu"]:visible')

    const openPicker = async () => {
      const triggers = this.page.locator(
        'button.__composer-pill:visible, button[aria-label="模型选择器"]:visible'
      )
      if ((await triggers.count()) !== 1) {
        throw new ProviderAdapterError(
          'changeModel',
          'ChatGPT model selector was missing or ambiguous.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_model_trigger_invalid',
          }
        )
      }
      await triggers.first().click()
      const picker = this.page.locator(
        `${CHATGPT_INTELLIGENCE_PICKER_SELECTOR}:visible`
      )
      await waitAsync(
        async () =>
          (await picker.count().catch(() => 0)) > 0 ||
          (await directMenus.count().catch(() => 0)) > 0,
        { timeoutMs: 5000 }
      )
      if ((await picker.count()) > 1 || (await directMenus.count()) > 1) {
        throw new ProviderAdapterError(
          'changeModel',
          'ChatGPT model menu was ambiguous.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_model_menu_ambiguous',
          }
        )
      }
      return picker.first()
    }

    let picker = await openPicker()
    if (!(await picker.isVisible().catch(() => false))) {
      if (modeIndex !== null) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          'ChatGPT model modes are unavailable.'
        )
      }
      const directModelItems = directMenus
        .first()
        .locator('[role="menuitemradio"]')
      if ((await directModelItems.count()) <= modelIndex) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `ChatGPT does not have model ${modelNumber}.`
        )
      }
      await directModelItems.nth(modelIndex).click()
      return
    }

    if (modeIndex !== null) {
      const modeItems = picker.locator(
        'div[role="group"] div[role="menuitemradio"]'
      )
      if ((await modeItems.count()) <= modeIndex) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `ChatGPT does not have model mode ${modeNumber}.`
        )
      }
      await modeItems.nth(modeIndex).click()
      picker = await openPicker()
    }

    const modelMenuItems = picker.locator('div[role="menuitem"]')
    if ((await modelMenuItems.count()) === 0) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'ChatGPT model menu is unavailable.'
      )
    }
    const modelMenuItem = modelMenuItems.first()
    const modelMenuId = await modelMenuItem
      .getAttribute('aria-controls')
      .catch(() => null)
    if (modelMenuId === null || modelMenuId.trim() === '') {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'ChatGPT model menu is unavailable.'
      )
    }
    await modelMenuItem.click()

    const modelItems = this.page.locator(
      `[id=${toCssString(modelMenuId)}] div[role="menuitemradio"]`
    )
    await waitAsync(async () => (await modelItems.count().catch(() => 0)) > 0, {
      timeoutMs: 5000,
    })
    if ((await modelItems.count()) <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `ChatGPT does not have model ${modelNumber}.`
      )
    }
    await modelItems.nth(modelIndex).click()
  }

  public async attachText(text: string) {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.page.locator('#prompt-textarea').click()
      await this.page.keyboard.insertText(text)
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const composer = () => this.page.locator('#prompt-textarea')
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'ChatGPT',
      isComposerReady: async () => await this.isRetryComposerReady(composer()),
      readComposerText: async () =>
        await this.readRetryComposerText(composer()),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(composer()),
      isStopActive: async () =>
        await this.isRetryControlActive(
          this.page.locator('button[data-testid="stop-button"]')
        ),
      isSendReady: async () =>
        await this.isRetryControlReady(
          this.page.locator('#composer-submit-button')
        ),
    })
  }

  public async attachFile(path: string | readonly string[]) {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.page.getByTestId('composer-plus-btn').click()
      const [fileChooser] = await Promise.all([
        this.page.waitForEvent('filechooser'),
        this.page
          .locator(CHATGPT_PLUS_MENU_GROUP_SELECTOR)
          .nth(0)
          .locator('xpath=./div')
          .nth(0)
          .click(),
      ])
      await fileChooser.setFiles(path)
    })
  }

  private getCapabilityGroup() {
    return this.page.locator(CHATGPT_PLUS_MENU_GROUP_SELECTOR).nth(1)
  }

  private getCapabilityOption(index: number) {
    return this.getCapabilityGroup().locator('xpath=./div').nth(index)
  }

  private async openCapabilityMenu(): Promise<void> {
    const capabilityGroup = this.getCapabilityGroup()
    if ((await capabilityGroup.count().catch(() => 0)) > 0) {
      return
    }

    await this.page.getByTestId('composer-plus-btn').click()
    await waitAsync(
      async () => (await capabilityGroup.count().catch(() => 0)) > 0,
      {
        timeoutMs: 1000,
      }
    ).catch(() => {})
  }

  public async listActionCapabilities(): Promise<
    ChatGPTActionCapabilityInfo[]
  > {
    await this.openCapabilityMenu()
    const capabilityGroup = this.getCapabilityGroup()
    if ((await capabilityGroup.count().catch(() => 0)) === 0) {
      return []
    }

    return CHATGPT_ACTION_CAPABILITIES.map((name) => ({
      name,
      state: 'available',
    }))
  }

  public async selectActionCapability(
    capability: ChatGPTActionCapability
  ): Promise<ChatGPTActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => {
        const capabilityIndex = CHATGPT_ACTION_CAPABILITIES.indexOf(capability)
        if (capabilityIndex < 0) {
          return 'unavailable'
        }

        await this.openCapabilityMenu()
        const capabilityGroup = this.getCapabilityGroup()
        if ((await capabilityGroup.count().catch(() => 0)) === 0) {
          return 'unavailable'
        }

        await this.getCapabilityOption(capabilityIndex).click()
        return 'selected'
      }
    )
  }

  public async attachImage(path: string | readonly string[]) {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(
      this.page.locator('button[data-testid="stop-button"]')
    )
  }

  private isTargetConversationRequest(
    request: import('playwright').Request
  ): boolean {
    if (request.method() !== 'POST') {
      return false
    }

    let url: URL
    try {
      url = new URL(request.url())
    } catch {
      return false
    }

    if (url.origin !== CHATGPT_CHAT_URL) {
      return false
    }

    return (
      url.pathname === '/backend-api/f/conversation' ||
      url.pathname.startsWith('/backend-api/conversation/')
    )
  }

  private isTargetCapturedConversationEntry(entry: {
    method: string
    url: string
    status: number | null
  }): boolean {
    if (entry.method !== 'POST') {
      return false
    }
    if (entry.status !== null && entry.status !== 200) {
      return false
    }

    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      return false
    }

    if (url.origin !== CHATGPT_CHAT_URL) {
      return false
    }

    return (
      url.pathname === '/backend-api/f/conversation' ||
      url.pathname.startsWith('/backend-api/conversation/')
    )
  }

  private async readCurrentCapturedResponse(
    fetchCaptureStartIndex: number
  ): Promise<ChatGPTParsedResponse | null> {
    const raw = await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) => this.isTargetCapturedConversationEntry(entry)
    )
    if (!raw) {
      return null
    }

    return parseChatGptHttpResponse(raw)
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('ChatGPT')
  }

  protected getSubmitResponseIdleTimeoutMs(): number {
    return CHATGPT_RESPONSE_IDLE_TIMEOUT_MS
  }

  protected getFinishedResponseSettleMs(): number {
    return CHATGPT_FINISHED_RESPONSE_SETTLE_MS
  }

  private getComposerSpeechButton() {
    return this.page.locator('button[style*="--vt-composer-speech-button"]')
  }

  private getComposerDataTestIdSendButton() {
    return this.page.locator('button[data-testid="send-button"]')
  }

  private async isLocatorReady(locator: {
    count: () => Promise<number>
    first: () => {
      isVisible: () => Promise<boolean>
      isEnabled: () => Promise<boolean>
    }
  }): Promise<boolean> {
    if ((await locator.count().catch(() => 0)) !== 1) return false
    const target = locator.first()
    return (
      (await target.isVisible().catch(() => false)) &&
      (await target.isEnabled().catch(() => false))
    )
  }

  private async waitForComposerReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    const speechButton = this.getComposerSpeechButton()
    const dataTestIdSendButton = this.getComposerDataTestIdSendButton()
    await waitAsync(
      async () =>
        (await this.isLocatorReady(speechButton)) ||
        (await this.isLocatorReady(dataTestIdSendButton)),
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'ChatGPT did not become ready after loading.'
              : 'ChatGPT finished responding, but the page did not become ready for the next message.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'chatgpt_composer_ready_button_missing',
            }
          )
        },
      }
    )
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        const sendButton = this.page.locator('#composer-submit-button')
        const frameStart = this.websocketFrames.length
        let requestStartedAt: number | null = null
        await waitAsync(
          async () =>
            (await sendButton.isEnabled()) && (await sendButton.isVisible()),
          {
            timeoutMs: this.getSubmitResponseTimeoutMs(),
            signal,
          }
        )
        throwIfAborted(signal)
        const fetchCaptureStartIndex = await this.getCapturedFetchEntryCount()

        const requestStarted = createDeferred<void>()
        const httpResponseDeferred = createDeferred<void>()
        let requestObserved = false
        let responseObserved = false
        let httpParsedResponse: ChatGPTParsedResponse | null = null
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let settled = false
        let lastStreamedText = ''

        const stopWarningTimer = () => {
          if (warningTimer !== null) {
            clearInterval(warningTimer)
            warningTimer = null
          }
        }

        const resolveRequestStarted = () => {
          if (requestObserved) {
            return
          }
          requestObserved = true
          requestStartedAt ??= Date.now()
          stopWarningTimer()
          requestStarted.resolve()
        }

        const settleHttpResponse = (
          resolution: { kind: 'resolve' } | { kind: 'reject'; error: unknown }
        ) => {
          if (settled) {
            return
          }
          settled = true
          stopWarningTimer()
          if (resolution.kind === 'resolve') {
            responseObserved = true
            requestStartedAt ??= Date.now()
            httpResponseDeferred.resolve()
            return
          }
          terminalError = resolution.error
          httpResponseDeferred.reject(resolution.error)
        }

        const updateHttpParsedResponse = (response: ChatGPTParsedResponse) => {
          if (
            httpParsedResponse === null ||
            response.text.length > httpParsedResponse.text.length ||
            (response.isFinished && !httpParsedResponse.isFinished)
          ) {
            httpParsedResponse = response
          }
        }

        const updateCapturedHttpResponse = async () => {
          const capturedResponse = await this.readCurrentCapturedResponse(
            fetchCaptureStartIndex
          )
          if (
            capturedResponse !== null &&
            capturedResponse.text.trim().length > 0
          ) {
            updateHttpParsedResponse(capturedResponse)
          }
          return capturedResponse
        }

        const onRequest = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          resolveRequestStarted()
        }

        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          resolveRequestStarted()
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          settleHttpResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `ChatGPT request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'chatgpt_submit_request_failed',
              }
            ),
          })
        }

        const onResponse = (response: import('playwright').Response) => {
          if (!this.isTargetConversationRequest(response.request())) {
            return
          }
          this.emitSubmitActivitySafely()
          resolveRequestStarted()
          if (response.status() !== 200) {
            return
          }
          responseObserved = true
          settleHttpResponse({ kind: 'resolve' })
          void (async () => {
            try {
              const parsedResponse = parseChatGptHttpResponse(
                await response.text()
              )
              if (
                parsedResponse !== null &&
                parsedResponse.text.trim().length > 0
              ) {
                updateHttpParsedResponse(parsedResponse)
              }
            } catch {
              // Another response channel may still provide the final result.
            }
          })()
        }

        const onClose = () => {
          settleHttpResponse({
            kind: 'reject',
            error: new Error(
              'Target page, context or browser has been closed.'
            ),
          })
        }

        const emitCurrentStreamText = async (
          response: ChatGPTParsedResponse | null
        ) => {
          const currentText = response?.text?.trim() ?? ''
          if (!currentText || currentText === lastStreamedText) {
            return
          }
          lastStreamedText = currentText
          await this.emitSubmitText(response!.text)
        }

        const pickCurrentResponse = (): ChatGPTParsedResponse | null => {
          const websocketParsedResponse = parseChatGptWebSocketFrames(
            this.websocketFrames.slice(frameStart)
          )
          const candidates = [
            websocketParsedResponse,
            httpParsedResponse,
          ].filter(
            (response): response is ChatGPTParsedResponse =>
              response !== null && response.text.trim().length > 0
          )
          if (candidates.length === 0) {
            return null
          }
          let best = candidates[0]!
          for (const current of candidates.slice(1)) {
            if (current.isFinished !== best.isFinished) {
              best = current.isFinished ? current : best
              continue
            }
            best = current.text.length >= best.text.length ? current : best
          }
          return best
        }

        this.page.on('request', onRequest)
        this.page.on('requestfailed', onRequestFailed)
        this.page.on('response', onResponse)
        this.page.on('close', onClose)

        let stopSubmitTextPolling = () => {}
        try {
          let submitTextPollInFlight = false
          const pollSubmitText = async () => {
            if (submitTextPollInFlight) {
              return
            }
            submitTextPollInFlight = true
            try {
              await updateCapturedHttpResponse()
              await emitCurrentStreamText(pickCurrentResponse())
            } finally {
              submitTextPollInFlight = false
            }
          }
          const submitTextPollTimer = setInterval(() => {
            void pollSubmitText().catch(() => {})
          }, 50)
          stopSubmitTextPolling = () => {
            clearInterval(submitTextPollTimer)
          }
          void pollSubmitText().catch(() => {})
          this.emitSubmitDispatching(signal)
          await sendButton.click()
          this.emitSubmitSent()
          throwIfAborted(signal)

          await abortable(
            Promise.race([
              delayAsync(this.getSubmitRequestStartGraceMs()),
              requestStarted.promise,
              httpResponseDeferred.promise,
            ]).catch(() => {}),
            signal
          )

          if (!requestObserved && !responseObserved && terminalError === null) {
            const warningMessage = this.getSubmitBlockedWarningMessage()
            await this.emitSubmitStatus(warningMessage)
            warningTimer = setInterval(() => {
              void this.emitSubmitStatusSafely(warningMessage)
            }, this.getSubmitBlockedWarningIntervalMs())

            await abortable(
              Promise.race([
                requestStarted.promise,
                httpResponseDeferred.promise,
              ]),
              signal
            )
          }

          const httpParsedResponsePromise = httpResponseDeferred.promise.catch(
            (error) => {
              terminalError = error
            }
          )

          let parsedResponse = pickCurrentResponse()
          await emitCurrentStreamText(parsedResponse)
          if (parsedResponse === null && terminalError === null) {
            const submitTimeoutMs = this.getSubmitResponseTimeoutMs()
            const responseDeadlineAt =
              submitTimeoutMs === null
                ? null
                : (requestStartedAt ?? Date.now()) + submitTimeoutMs
            await waitAsync(
              async () => {
                await updateCapturedHttpResponse()
                parsedResponse = pickCurrentResponse()
                await emitCurrentStreamText(parsedResponse)
                return parsedResponse !== null || terminalError !== null
              },
              {
                timeoutMs:
                  responseDeadlineAt === null
                    ? null
                    : Math.max(1, responseDeadlineAt - Date.now()),
                continueIf: async (startedAt, currentAt) =>
                  responseDeadlineAt === null || currentAt < responseDeadlineAt,
                onPending: async () => {
                  await delayAsync(10, signal)
                },
                signal,
              }
            )
          }

          if (parsedResponse !== null) {
            let lastResponseKey = `${parsedResponse.isFinished}:${parsedResponse.text}`
            let stablePolls = 0
            let lastProgressAt = Date.now()
            const submitTimeoutMs = this.getSubmitResponseTimeoutMs()
            const responseDeadlineAt =
              submitTimeoutMs === null
                ? null
                : (requestStartedAt ?? Date.now()) + submitTimeoutMs
            await waitAsync(
              async () => {
                await updateCapturedHttpResponse()
                const current = pickCurrentResponse()
                if (current === null) {
                  return false
                }

                parsedResponse = current
                await emitCurrentStreamText(current)
                const currentKey = `${current.isFinished}:${current.text}`
                if (currentKey === lastResponseKey) {
                  stablePolls += 1
                } else {
                  lastResponseKey = currentKey
                  stablePolls = 0
                  lastProgressAt = Date.now()
                }

                if (
                  current.isFinished &&
                  stablePolls >= CHATGPT_RESPONSE_STABLE_POLLS &&
                  Date.now() - lastProgressAt >=
                    this.getFinishedResponseSettleMs()
                ) {
                  return true
                }

                return false
              },
              {
                timeoutMs:
                  responseDeadlineAt === null
                    ? null
                    : Math.max(1, responseDeadlineAt - Date.now()),
                continueIf: async (startedAt, currentAt) =>
                  (responseDeadlineAt === null ||
                    currentAt < responseDeadlineAt) &&
                  currentAt - lastProgressAt <
                    this.getSubmitResponseIdleTimeoutMs(),
                onPending: async () => {
                  await delayAsync(10, signal)
                },
                onTimeout: async () => {},
                signal,
              }
            )
          }

          if (parsedResponse === null) {
            await awaitWithTimeout(
              httpParsedResponsePromise,
              this.getSubmitResponseTimeoutMs(),
              () =>
                new Error(
                  'Timed out waiting for ChatGPT response after the request started.'
                ),
              { signal }
            )
            if (terminalError !== null) {
              throw toError(terminalError, 'ChatGPT response capture failed.')
            }
            parsedResponse = pickCurrentResponse()
            await emitCurrentStreamText(parsedResponse)
          }

          if (parsedResponse !== null && !parsedResponse.isFinished) {
            throw new Error(
              'Timed out waiting for ChatGPT response to reach finished state.'
            )
          }

          if (
            parsedResponse === null ||
            parsedResponse.text.trim().length === 0
          ) {
            if (terminalError !== null) {
              throw toError(terminalError, 'ChatGPT response capture failed.')
            }
            throw new ProviderAdapterError(
              'submit',
              'Failed to capture ChatGPT response.',
              {
                kind: 'protocol',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'chatgpt_response_capture_failed',
              }
            )
          }
          this.lastParsedResponse = parsedResponse
          this.websocketFrames = this.websocketFrames.slice(frameStart)
          await this.waitForComposerReady(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          throwIfAborted(signal)
          return parsedResponse.text
        } finally {
          stopSubmitTextPolling()
          stopWarningTimer()
          this.page.off('request', onRequest)
          this.page.off('requestfailed', onRequestFailed)
          this.page.off('response', onResponse)
          this.page.off('close', onClose)
        }
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'ChatGPT submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'chatgpt_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public get conversationId(): string | null {
    return this.lastParsedResponse?.conversationId ?? null
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${CHATGPT_CHAT_URL}/c/${this.conversationId}`
        : CHATGPT_CHAT_URL
    ).toString()
  }
}
