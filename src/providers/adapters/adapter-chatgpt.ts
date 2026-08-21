import {
  ProviderAdapter,
  type AbortOptions,
  awaitWithTimeout,
  buildResponseOwnershipErrorMessage,
  buildSubmitOutcomeUnknownMessage,
  buildSubmitBlockedWarningMessage,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  requestBodyContainsSubmittedText,
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
  ChatGptWebSocketResponseTracker,
  parseChatGptHttpResponse,
  type ChatGPTParsedResponse,
} from '../chatgpt-response-parser.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import { ChatGPTUi } from '../ui/chatgpt/chatgpt-ui.ts'
import {
  buildChatGptSubmitDiagnosticRecord,
  type ChatGptSubmitDiagnosticOutcome,
  type ChatGptSubmitObservation,
  writeChatGptSubmitDiagnostic,
} from './chatgpt-submit-diagnostics.ts'

const CHATGPT_CHAT_URL = 'https://chatgpt.com'
const CHATGPT_CHAT_WS_URL = 'wss://ws.chatgpt.com/p18/ws/user'
const CHATGPT_RESPONSE_STALL_TIMEOUT_MS = 60000
const CHATGPT_COMPOSER_READY_TIMEOUT_MS = 30000
const CHATGPT_FINISHED_RESPONSE_SETTLE_MS = 1000
const CHATGPT_REQUEST_OWNERSHIP_SETTLE_MS = 100

export type ChatGPTActionCapability = string

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type ChatGPTActionCapabilityState =
  'available' | 'selected' | 'disabled' | 'unavailable'

export interface ChatGPTActionCapabilityInfo {
  name: ChatGPTActionCapability
  state: ChatGPTActionCapabilityState
}

const CHATGPT_RESPONSE_STABLE_POLLS = 3

interface ActiveChatGptSubmitObservation extends ChatGptSubmitObservation {
  timeoutPhase: 'start' | 'stall' | null
}

function createSubmitObservation(): ActiveChatGptSubmitObservation {
  return {
    phase: 'pre-dispatch',
    candidateRequestCount: 0,
    requestAmbiguous: false,
    ownedRequest: false,
    ownedUserMessageId: false,
    ownedHttpResponse: false,
    rawWebSocketFrameCount: 0,
    ownedWebSocketProgress: false,
    parsedHttpText: false,
    parsedWebSocketText: false,
    parsedOwnedText: false,
    parsedFinished: false,
    composerReady: false,
    timeoutPhase: null,
  }
}

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

function readChatGPTSubmittedMessageId(
  raw: string | null,
  submittedText: string
): string | undefined {
  if (raw === null || submittedText === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }

  const ids = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!isRecord(value)) return
    const node = value
    const author = isRecord(node.author) ? node.author : null
    const role =
      typeof node.role === 'string'
        ? node.role
        : typeof author?.role === 'string'
          ? author.role
          : null
    const id =
      typeof node.id === 'string'
        ? node.id
        : typeof node.message_id === 'string'
          ? node.message_id
          : typeof node.messageId === 'string'
            ? node.messageId
            : null
    if (
      role === 'user' &&
      id !== null &&
      requestBodyContainsSubmittedText(
        JSON.stringify(node.content ?? node),
        submittedText
      )
    ) {
      ids.add(id)
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(parsed)
  return ids.size === 1 ? [...ids][0] : undefined
}

export class ChatGPTAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'chatgpt' as const
  }

  private lastParsedResponse!: ChatGPTParsedResponse | null
  private pendingText = ''
  private websocketFrames!: string[]
  private authenticationConfirmed = false
  private activeSubmitObservation: ActiveChatGptSubmitObservation | null = null

  private get ui(): ChatGPTUi {
    return new ChatGPTUi(this.page)
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
        if (this.activeSubmitObservation !== null) {
          this.activeSubmitObservation.rawWebSocketFrameCount += 1
        }
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
      try {
        const url = new URL(this.page.url())
        return (
          url.protocol === 'https:' &&
          (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com')
        )
      } catch {
        return false
      }
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
      if (
        !this.authenticationConfirmed &&
        !(await this.confirmAuthentication({ signal }))
      ) {
        throw new ProviderAdapterError(
          'restore',
          'ChatGPT is not logged in for the current browser profile.',
          {
            adapter: this,
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_signed_out',
          }
        )
      }
      await this.ui.waitForComposerReady(
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

  private async confirmAuthentication(
    options: AbortOptions = {}
  ): Promise<boolean> {
    if (this.authenticationConfirmed) return true
    const authenticated = await this.ui.isLoggedIn(options)
    if (authenticated) this.authenticationConfirmed = true
    return authenticated
  }

  public async isLoggedIn(options: AbortOptions = {}): Promise<boolean> {
    return await this.confirmAuthentication(options)
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.ui.changeModel(model)
  }

  public async attachText(text: string) {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.ui.attachText(text)
      this.pendingText += text
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const ui = this.ui
    const composer = () => ui.getRetryComposer()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'ChatGPT',
      isComposerReady: async () => await this.isRetryComposerReady(composer()),
      readComposerText: async () =>
        await this.readRetryComposerText(composer()),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(composer()).finally(() => {
          this.pendingText = ''
        }),
      isStopActive: async () =>
        await this.isRetryControlActive(ui.getRetryStopButton()),
      isSendReady: async () =>
        await this.isRetryControlReady(ui.getRetrySendButton()),
    })
  }

  public async attachFile(path: string | readonly string[]) {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.ui.attachFile(path)
    })
  }

  public async listActionCapabilities(): Promise<
    ChatGPTActionCapabilityInfo[]
  > {
    return await this.ui.listActionCapabilities()
  }

  public async selectActionCapability(
    capability: ChatGPTActionCapability
  ): Promise<ChatGPTActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => await this.ui.selectActionCapability(capability)
    )
  }

  public async attachImage(path: string | readonly string[]) {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.ui.stopGeneration()
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
    fetchCaptureStartIndex: number,
    requestBody?: string | null
  ): Promise<ChatGPTParsedResponse | null> {
    const raw = await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) =>
        this.isTargetCapturedConversationEntry(entry) &&
        requestBody !== undefined &&
        entry.requestBody === requestBody
    )
    if (!raw) {
      return null
    }

    return parseChatGptHttpResponse(raw)
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('ChatGPT')
  }

  protected override getSubmitResponseStallTimeoutMs(): number {
    return (
      this.options.timings?.responseStallTimeoutMs ??
      CHATGPT_RESPONSE_STALL_TIMEOUT_MS
    )
  }

  protected getPostResponseComposerReadyTimeoutMs(): number {
    return CHATGPT_COMPOSER_READY_TIMEOUT_MS
  }

  protected override createSubmitResponseTimeoutError(
    phase: 'start' | 'stall',
    timeoutMs: number
  ): ProviderAdapterError {
    const observation = this.activeSubmitObservation
    if (observation === null) {
      return super.createSubmitResponseTimeoutError(phase, timeoutMs)
    }
    observation.timeoutPhase = phase
    const diagnostic = buildChatGptSubmitDiagnosticRecord(
      observation,
      'timeout',
      phase
    )
    const message =
      diagnostic.detailCode === 'owned-request-missing'
        ? 'Portal could not identify the ChatGPT request after it was sent.'
        : diagnostic.detailCode === 'owned-request-ambiguous'
          ? buildResponseOwnershipErrorMessage('ChatGPT')
          : diagnostic.detailCode === 'owned-response-missing'
            ? 'ChatGPT did not return a response for this request.'
            : diagnostic.detailCode === 'owned-response-unparsed'
              ? 'Portal received the ChatGPT response but could not read it.'
              : diagnostic.detailCode === 'terminal-marker-missing'
                ? 'Portal received the ChatGPT response but could not confirm it finished.'
                : `ChatGPT response activity stopped for ${timeoutMs}ms.`
    return new ProviderAdapterError('submit', message, {
      kind: 'protocol',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
      detailCode: `chatgpt_${diagnostic.detailCode.replaceAll('-', '_')}`,
    })
  }

  protected getFinishedResponseSettleMs(): number {
    return CHATGPT_FINISHED_RESPONSE_SETTLE_MS
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    const observation = createSubmitObservation()
    this.activeSubmitObservation = observation
    let diagnosticOutcome: ChatGptSubmitDiagnosticOutcome = 'error'
    let dispatchAttempted = false
    let terminalEvidenceObserved = false
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        const sendButton = this.ui.getSendButton()
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
        let dispatchStarted = false
        const submittedText = this.pendingText
        let ownedRequest: import('playwright').Request | null = null
        let ownedRequestBody: string | null = null
        const candidateRequests = new Set<import('playwright').Request>()
        let ambiguousRequest = false
        let ownedUserMessageId: string | null = null
        let ownedFrameStartIndex = frameStart
        let httpParsedResponse: ChatGPTParsedResponse | null = null
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let settled = false
        let lastStreamedText = ''
        let lastOwnedWebSocketProgressCount = 0
        let finishedProgressReported = false
        let websocketTracker: ChatGptWebSocketResponseTracker | null = null
        let websocketTrackerKey: string | null = null
        let websocketTrackerFrameIndex = frameStart
        let requestOwnershipSettled: Promise<void> | null = null

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
          if (response.text.trim().length > 0) {
            observation.parsedHttpText = true
          }
        }

        const updateCapturedHttpResponse = async () => {
          if (ambiguousRequest) {
            return null
          }
          const capturedResponse = await this.readCurrentCapturedResponse(
            fetchCaptureStartIndex,
            ownedRequestBody
          )
          if (
            capturedResponse !== null &&
            capturedResponse.text.trim().length > 0
          ) {
            updateHttpParsedResponse(capturedResponse)
          }
          return capturedResponse
        }

        const adoptRequest = (request: import('playwright').Request) => {
          if (!dispatchStarted) return
          const candidate = request as import('playwright').Request & {
            postData?: () => string | null
          }
          const requestBody =
            typeof candidate.postData === 'function'
              ? candidate.postData()
              : null
          if (
            submittedText !== '' &&
            !requestBodyContainsSubmittedText(requestBody, submittedText)
          ) {
            return
          }
          if (!candidateRequests.has(request)) {
            candidateRequests.add(request)
            observation.candidateRequestCount = candidateRequests.size
            if (candidateRequests.size > 1) {
              ambiguousRequest = true
              observation.requestAmbiguous = true
              ownedRequest = null
              ownedRequestBody = null
              return
            }
            requestOwnershipSettled = delayAsync(
              CHATGPT_REQUEST_OWNERSHIP_SETTLE_MS,
              signal
            ).catch(() => {})
          }
          if (ambiguousRequest) return
          ownedRequest = request
          observation.ownedRequest = true
          observation.phase = 'awaiting-response'
          ownedRequestBody = requestBody
          ownedUserMessageId =
            readChatGPTSubmittedMessageId(requestBody, submittedText) ?? null
          observation.ownedUserMessageId = ownedUserMessageId !== null
          // Keep every frame observed after dispatch. A background response can
          // arrive before the matching Request event, so slicing at adoption
          // time would silently discard evidence needed for ownership checks.
          ownedFrameStartIndex = frameStart
          this.pendingText = ''
        }

        const onRequest = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          adoptRequest(request)
          resolveRequestStarted()
        }

        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          adoptRequest(request)
          if (ownedRequest !== request) {
            resolveRequestStarted()
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
          if (
            !this.isTargetConversationRequest(response.request()) ||
            ownedRequest !== response.request()
          ) {
            return
          }
          this.emitSubmitActivitySafely()
          resolveRequestStarted()
          if (response.status() !== 200) {
            return
          }
          observation.ownedHttpResponse = true
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
          if (requestOwnershipSettled !== null) {
            await requestOwnershipSettled
            throwIfAborted(signal)
            if (ambiguousRequest) {
              return
            }
          }
          const currentText = response?.text?.trim() ?? ''
          if (response?.isFinished === true && !finishedProgressReported) {
            finishedProgressReported = true
            this.emitSubmitActivitySafely()
          }
          if (!currentText || currentText === lastStreamedText) {
            return
          }
          lastStreamedText = currentText
          observation.parsedOwnedText = true
          observation.parsedFinished ||= response?.isFinished === true
          observation.phase = response?.isFinished
            ? 'response-complete'
            : 'streaming'
          await this.emitSubmitText(response!.text)
        }

        const pickCurrentResponse = (): ChatGPTParsedResponse | null => {
          if (ambiguousRequest) {
            return null
          }
          const currentPageUrl =
            typeof this.page.url === 'function' ? this.page.url() : null
          const websocketCorrelationAvailable =
            httpParsedResponse?.messageId !== undefined ||
            ownedUserMessageId !== null
          let websocketParsedResponse: ChatGPTParsedResponse | null = null
          if (websocketCorrelationAvailable) {
            const expectedConversationId =
              httpParsedResponse?.conversationId ??
              readChatGPTConversationIdFromUrl(currentPageUrl) ??
              this.conversationId ??
              null
            const expectedMessageId = httpParsedResponse?.messageId
            const trackerKey = JSON.stringify([
              expectedConversationId,
              expectedMessageId ?? null,
              ownedUserMessageId,
            ])
            if (
              websocketTracker === null ||
              websocketTrackerKey !== trackerKey
            ) {
              websocketTracker = new ChatGptWebSocketResponseTracker(
                expectedConversationId,
                {
                  requireExpectedConversationId: true,
                  requireSingleMessageId: true,
                  ...(expectedMessageId === undefined
                    ? {}
                    : { expectedMessageId }),
                  ...(ownedUserMessageId === null
                    ? {}
                    : { expectedParentMessageId: ownedUserMessageId }),
                }
              )
              websocketTrackerKey = trackerKey
              websocketTrackerFrameIndex = ownedFrameStartIndex
              lastOwnedWebSocketProgressCount = 0
            }
            websocketParsedResponse = websocketTracker.pushFrames(
              this.websocketFrames.slice(websocketTrackerFrameIndex)
            )
            websocketTrackerFrameIndex = this.websocketFrames.length
            const ownedProgressCount = websocketTracker.getOwnedProgressCount()
            if (ownedProgressCount > lastOwnedWebSocketProgressCount) {
              lastOwnedWebSocketProgressCount = ownedProgressCount
              observation.ownedWebSocketProgress = true
              this.emitSubmitActivitySafely()
            }
          }
          if (
            websocketParsedResponse !== null &&
            websocketParsedResponse.text.trim().length > 0
          ) {
            observation.parsedWebSocketText = true
          }
          const candidates: ChatGPTParsedResponse[] = []
          if (
            websocketParsedResponse !== null &&
            websocketParsedResponse.text.trim().length > 0
          ) {
            candidates.push(websocketParsedResponse)
          }
          if (
            httpParsedResponse !== null &&
            httpParsedResponse.text.trim().length > 0 &&
            (ownedUserMessageId === null ||
              httpParsedResponse.parentMessageId === undefined ||
              httpParsedResponse.parentMessageId === ownedUserMessageId)
          ) {
            // This response is tied to the exact Playwright Request. A missing
            // parent_id is therefore incomplete metadata, not a contradiction.
            candidates.push(httpParsedResponse)
          }
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
          observation.parsedOwnedText = best.text.trim().length > 0
          observation.parsedFinished ||= best.isFinished
          return best
        }

        this.page.on('request', onRequest)
        this.page.on('requestfailed', onRequestFailed)
        this.page.on('response', onResponse)
        this.page.on('close', onClose)

        let stopSubmitTextPolling = () => {}
        let stopped = false
        try {
          let submitTextPollInFlight = false
          const pollSubmitText = async () => {
            if (stopped || submitTextPollInFlight) {
              return
            }
            submitTextPollInFlight = true
            try {
              await updateCapturedHttpResponse()
              if (stopped) {
                return
              }
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
          dispatchStarted = true
          dispatchAttempted = true
          observation.phase = 'awaiting-request'
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
                if (ambiguousRequest) {
                  throw new ProviderAdapterError(
                    'submit',
                    buildResponseOwnershipErrorMessage('ChatGPT'),
                    {
                      kind: 'unknown',
                      recovery: 'none',
                      retryable: false,
                      maxAttempts: 1,
                      detailCode: 'chatgpt_response_ownership_ambiguous',
                    }
                  )
                }
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
                if (ambiguousRequest) {
                  throw new ProviderAdapterError(
                    'submit',
                    buildResponseOwnershipErrorMessage('ChatGPT'),
                    {
                      kind: 'unknown',
                      recovery: 'none',
                      retryable: false,
                      maxAttempts: 1,
                      detailCode: 'chatgpt_response_ownership_ambiguous',
                    }
                  )
                }
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
                  observation.parsedFinished = true
                  observation.phase = 'response-complete'
                  return true
                }

                return false
              },
              {
                timeoutMs:
                  responseDeadlineAt === null
                    ? null
                    : Math.max(1, responseDeadlineAt - Date.now()),
                continueIf: async (_startedAt, currentAt) =>
                  responseDeadlineAt === null || currentAt < responseDeadlineAt,
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
          if (ambiguousRequest) {
            throw new ProviderAdapterError(
              'submit',
              buildResponseOwnershipErrorMessage('ChatGPT'),
              {
                kind: 'unknown',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'chatgpt_response_ownership_ambiguous',
              }
            )
          }
          await delayAsync(CHATGPT_REQUEST_OWNERSHIP_SETTLE_MS, signal)
          if (ambiguousRequest) {
            throw new ProviderAdapterError(
              'submit',
              buildResponseOwnershipErrorMessage('ChatGPT'),
              {
                kind: 'unknown',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'chatgpt_response_ownership_ambiguous',
              }
            )
          }
          terminalEvidenceObserved = true

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
          observation.phase = 'awaiting-composer'
          this.emitSubmitResponseComplete()
          await this.ui.waitForComposerReady(
            'submit',
            this.getPostResponseComposerReadyTimeoutMs(),
            signal
          )
          observation.composerReady = true
          observation.phase = 'composer-ready'
          throwIfAborted(signal)
          if (ambiguousRequest) {
            throw new ProviderAdapterError(
              'submit',
              buildResponseOwnershipErrorMessage('ChatGPT'),
              {
                kind: 'unknown',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'chatgpt_response_ownership_ambiguous',
              }
            )
          }
          diagnosticOutcome = 'success'
          return parsedResponse.text
        } finally {
          stopped = true
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
        diagnosticOutcome =
          observation.timeoutPhase === null ? 'aborted' : 'timeout'
        throw error
      }
      if (dispatchAttempted && !terminalEvidenceObserved) {
        throw new ProviderAdapterError(
          'submit',
          buildSubmitOutcomeUnknownMessage('ChatGPT'),
          {
            kind: 'unknown',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_submit_outcome_unknown',
            cause: error,
          }
        )
      }
      if (terminalEvidenceObserved) {
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
    } finally {
      await writeChatGptSubmitDiagnostic(
        buildChatGptSubmitDiagnosticRecord(
          observation,
          diagnosticOutcome,
          observation.timeoutPhase
        )
      )
      if (this.activeSubmitObservation === observation) {
        this.activeSubmitObservation = null
      }
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
