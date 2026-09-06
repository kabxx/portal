import {
  ProviderAdapter,
  type AbortOptions,
  awaitWithTimeout,
  buildResponseOwnershipErrorMessage,
  buildSubmitOutcomeUnknownMessage,
  buildSubmitBlockedWarningMessage,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  createDeferred,
  delayAsync,
  type CapturedFetchEntry,
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
const CHATGPT_RESPONSE_START_TIMEOUT_MS = 60000
const CHATGPT_RESPONSE_STALL_TIMEOUT_MS = 60000
const CHATGPT_COMPOSER_READY_TIMEOUT_MS = 30000
const CHATGPT_FINISHED_RESPONSE_SETTLE_MS = 1000
const CHATGPT_REQUEST_OWNERSHIP_SETTLE_MS = 100
const CHATGPT_SAME_MESSAGE_RETRY_GRACE_MS = 500

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

/**
 * Read the user-message UUID from a ChatGPT submit body without inspecting
 * the message text.  ChatGPT has used both `role` and `author.role`, and a
 * few transport layers wrap the JSON body in another JSON or URL-encoded
 * value, so the walk deliberately accepts all of those shapes.
 */
function readChatGPTSubmittedMessageId(
  raw: string | null | undefined
): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined

  const parseJsonVariants = (value: string): unknown[] => {
    const parsedValues: unknown[] = []
    let candidate = value
    // Some browser transports expose an encoded JSON body (or encode a
    // structural wrapper field) once or twice. Decode only the value being
    // parsed, and keep the depth bounded so arbitrary user text is never
    // treated as an unbounded parser input.
    for (let depth = 0; depth < 4; depth += 1) {
      const trimmed = candidate.trim()
      if (trimmed === '') return parsedValues
      try {
        const parsed = JSON.parse(trimmed) as unknown
        parsedValues.push(parsed)
        if (typeof parsed !== 'string') return parsedValues
        candidate = parsed
        continue
      } catch {
        let decoded: string
        try {
          decoded = decodeURIComponent(candidate)
        } catch {
          return parsedValues
        }
        if (decoded === candidate) return parsedValues
        candidate = decoded
      }
    }
    return parsedValues
  }

  const roots: unknown[] = []
  const parseRoot = (value: string, includeFormValues = false): void => {
    roots.push(...parseJsonVariants(value))
    if (!includeFormValues) return
    try {
      for (const formValue of new URLSearchParams(value).values()) {
        roots.push(...parseJsonVariants(formValue))
      }
    } catch {
      // Non-form-encoded bodies are handled by the direct JSON parse above.
    }
  }
  parseRoot(raw, true)
  if (roots.length === 0) return undefined

  const ids: string[] = []
  const messageArrayIds: string[] = []
  const visitedObjects = new WeakSet<object>()

  const readUserId = (value: unknown): string | undefined => {
    if (!isRecord(value)) return undefined
    const author = isRecord(value.author) ? value.author : null
    const role =
      typeof value.role === 'string'
        ? value.role
        : typeof author?.role === 'string'
          ? author.role
          : null
    if (role?.toLowerCase() !== 'user') return undefined
    const id =
      typeof value.id === 'string'
        ? value.id
        : typeof value.message_id === 'string'
          ? value.message_id
          : typeof value.messageId === 'string'
            ? value.messageId
            : null
    const normalizedId = id?.trim() ?? ''
    return normalizedId === '' ? undefined : normalizedId
  }

  const collectMessageArray = (value: unknown, depth: number): void => {
    if (depth > 8) return
    if (typeof value === 'string') {
      for (const parsed of parseJsonVariants(value)) {
        collectMessageArray(parsed, depth + 1)
      }
      return
    }
    if (!Array.isArray(value)) return
    for (const item of value) {
      const id = readUserId(item)
      if (id !== undefined) messageArrayIds.push(id)
    }
  }

  const collectContainer = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return
    if (visitedObjects.has(value)) return
    visitedObjects.add(value)
    if (Array.isArray(value)) {
      for (const child of value) collectContainer(child, depth + 1)
      return
    }
    const directId = readUserId(value)
    if (directId !== undefined) ids.push(directId)
    for (const [key, child] of Object.entries(value)) {
      if (key === 'messages') {
        collectMessageArray(child, depth + 1)
        continue
      }
      // Only recurse through structural wrapper fields.  In particular, do
      // not parse arbitrary strings under `content`/`parts`; user text can
      // itself look like JSON containing a fake role/id pair.
      if (
        key === 'body' ||
        key === 'data' ||
        key === 'payload' ||
        key === 'request' ||
        key === 'message'
      ) {
        if (typeof child === 'string') {
          for (const parsed of parseJsonVariants(child)) {
            collectContainer(parsed, depth + 1)
          }
        } else {
          collectContainer(child, depth + 1)
        }
      }
    }
  }

  for (const root of roots) collectContainer(root, 0)
  const uniqueMessageArrayIds = [...new Set(messageArrayIds)]
  if (uniqueMessageArrayIds.length > 0) {
    // The current user message is appended last in ChatGPT's `messages`
    // array, after any historical messages included for context.
    return uniqueMessageArrayIds.at(-1)
  }
  const uniqueIds = [...new Set(ids)]
  // A body may contain historical user messages as well as the new one.  Do
  // not guess which arbitrary nested id is current; only a single distinct
  // user id is a reliable request-local anchor.
  return uniqueIds.length === 1 ? uniqueIds[0] : undefined
}

function isChatGPTConversationPath(pathname: string): boolean {
  // These are the two submit routes used by the current ChatGPT frontend.
  // Do not accept arbitrary conversation subpaths: setup and background
  // requests share that prefix, and without body matching they are unsafe
  // ownership candidates.
  if (
    pathname === '/backend-api/f/conversation' ||
    pathname === '/backend-api/conversation'
  ) {
    return true
  }
  return false
}

function readChatGPTRequestStartTime(
  request: import('playwright').Request
): number | undefined {
  const candidate = request as import('playwright').Request & {
    timing?: () => { startTime?: number }
  }
  if (typeof candidate.timing !== 'function') return undefined
  try {
    const startTime = candidate.timing().startTime
    return typeof startTime === 'number' && Number.isFinite(startTime)
      ? startTime
      : undefined
  } catch {
    return undefined
  }
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

    return isChatGPTConversationPath(url.pathname)
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

    return isChatGPTConversationPath(url.pathname)
  }

  private async readCurrentCapturedResponse(
    fetchCaptureStartIndex: number,
    ownedUserMessageId?: string | null,
    ownedCapturedEntryId?: number | null
  ): Promise<ChatGPTParsedResponse | null> {
    const entries = (
      await this.getCapturedFetchEntries(fetchCaptureStartIndex)
    ).filter((entry) => this.isTargetCapturedConversationEntry(entry))
    if (entries.length === 0) {
      return null
    }

    // Captured fetch entries have no Playwright Request identity.  Only use
    // them after a live request has already been owned, and match by the
    // stable message id (or the captured entry selected during ownership).
    // Never choose an unrelated bodyless entry merely because it happens to
    // be the only captured response.
    const matchingEntries = entries.filter((entry) => {
      // A message id is the logical ownership key. Multiple captured fetch
      // entries can mirror or retry the same submit, so do not pin the read
      // to the first local entry id when a stable message id is available.
      if (ownedUserMessageId !== undefined && ownedUserMessageId !== null) {
        return (
          readChatGPTSubmittedMessageId(entry.requestBody) ===
          ownedUserMessageId
        )
      }
      if (ownedCapturedEntryId !== undefined && ownedCapturedEntryId !== null) {
        return entry.id === ownedCapturedEntryId
      }
      return false
    })
    this.reportCapturedSubmitActivity(matchingEntries)
    let bestResponse: ChatGPTParsedResponse | null = null
    for (const entry of matchingEntries) {
      const raw = entry.chunks.join('')
      if (!raw.trim()) continue
      const parsedResponse = parseChatGptHttpResponse(raw)
      if (parsedResponse === null || !parsedResponse.text.trim()) continue
      if (
        bestResponse === null ||
        (parsedResponse.isFinished && !bestResponse.isFinished) ||
        (parsedResponse.isFinished === bestResponse.isFinished &&
          parsedResponse.text.length >= bestResponse.text.length)
      ) {
        // Entries are chronological; replacing ties lets a later retry win
        // while still preferring a finished and more complete response.
        bestResponse = parsedResponse
      }
    }
    return bestResponse
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('ChatGPT')
  }

  protected override getSubmitResponseStartTimeoutMs(): number {
    return (
      this.options.timings?.responseStartTimeoutMs ??
      CHATGPT_RESPONSE_START_TIMEOUT_MS
    )
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
        let fetchCaptureStartIndex = 0

        const requestStarted = createDeferred<void>()
        const httpResponseDeferred = createDeferred<void>()
        let requestObserved = false
        let responseObserved = false
        let dispatchStarted = false
        const ownedRequests = new Set<import('playwright').Request>()
        const preDispatchRequests = new Set<import('playwright').Request>()
        let ownedCapturedEntryId: number | null = null
        const candidateRequests = new Set<import('playwright').Request>()
        const candidateRequestInfo = new Map<
          import('playwright').Request,
          { requestBody: string | null; userMessageId: string | null }
        >()
        const capturedCandidateInfo = new Map<
          number,
          {
            entry: CapturedFetchEntry
            requestBody: string | null
            userMessageId: string | null
          }
        >()
        const pendingResponses = new Map<
          import('playwright').Request,
          import('playwright').Response
        >()
        const pendingFailures = new Map<import('playwright').Request, string>()
        const ownedRequestFailures = new Map<
          import('playwright').Request,
          string
        >()
        let ambiguousRequest = false
        let ownershipSettled = false
        let ownedUserMessageId: string | null = null
        let provisionalUserMessageId: string | null = null
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
        let ownedFailureTimer: NodeJS.Timeout | null = null
        let dispatchStartedAt: number | null = null
        const pendingStreamSnapshots: Array<{
          text: string
          isFinished: boolean
        }> = []

        const refreshCandidateCount = () => {
          observation.candidateRequestCount =
            candidateRequests.size + capturedCandidateInfo.size
        }

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

        const clearOwnedFailureTimer = () => {
          if (ownedFailureTimer !== null) {
            clearTimeout(ownedFailureTimer)
            ownedFailureTimer = null
          }
        }

        const scheduleOwnedFailureCheck = () => {
          clearOwnedFailureTimer()
          ownedFailureTimer = setTimeout(() => {
            ownedFailureTimer = null
            if (settled || ambiguousRequest) return
            for (const request of ownedRequests) {
              if (!ownedRequestFailures.has(request)) return
            }
            const failureText = ownedRequestFailures.values().next().value
            if (typeof failureText !== 'string') return
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
          }, CHATGPT_SAME_MESSAGE_RETRY_GRACE_MS)
        }

        const updateHttpParsedResponse = (response: ChatGPTParsedResponse) => {
          const current = httpParsedResponse
          const isSameMessage =
            current !== null &&
            ((response.messageId !== undefined &&
              current.messageId === response.messageId) ||
              (response.messageId === undefined &&
                current.messageId === undefined))
          if (
            current === null ||
            (!isSameMessage && response.messageId !== undefined) ||
            (isSameMessage &&
              (response.text.length > current.text.length ||
                (response.isFinished && !current.isFinished)))
          ) {
            httpParsedResponse = response
          }
          if (response.text.trim().length > 0) {
            observation.parsedHttpText = true
          }
        }

        const updateCapturedHttpResponse = async () => {
          // Captured fetch entries do not carry the Playwright Request object.
          // Do not parse one while candidate ownership is still undecided:
          // otherwise a background entry can seed `httpParsedResponse` before
          // a later, ID-bearing request wins the settle window.
          if (ambiguousRequest || !ownershipSettled) {
            return null
          }
          const capturedResponse = await this.readCurrentCapturedResponse(
            fetchCaptureStartIndex,
            ownedUserMessageId,
            ownedCapturedEntryId
          )
          if (
            capturedResponse !== null &&
            capturedResponse.text.trim().length > 0
          ) {
            observation.ownedHttpResponse = true
            responseObserved = true
            settleHttpResponse({ kind: 'resolve' })
            updateHttpParsedResponse(capturedResponse)
          }
          return capturedResponse
        }

        const processOwnedResponse = (
          response: import('playwright').Response
        ) => {
          const request = response.request()
          if (ambiguousRequest || !ownedRequests.has(request)) {
            return
          }
          this.emitSubmitActivitySafely()
          resolveRequestStarted()
          if (response.status() !== 200) {
            return
          }
          ownedRequestFailures.delete(request)
          clearOwnedFailureTimer()
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

        const processOwnedFailure = (
          request: import('playwright').Request,
          failureText: string
        ) => {
          if (ambiguousRequest || !ownedRequests.has(request)) {
            return
          }
          ownedRequestFailures.set(request, failureText)
          scheduleOwnedFailureCheck()
        }

        const finalizeRequestOwnership = () => {
          if (ownershipSettled) return
          ownershipSettled = true

          type LiveCandidate = [
            import('playwright').Request,
            { requestBody: string | null; userMessageId: string | null },
          ]
          type CapturedCandidate = {
            entry: CapturedFetchEntry
            requestBody: string | null
            userMessageId: string | null
          }

          const liveCandidates = [...candidateRequestInfo.entries()]
          const capturedCandidates = [...capturedCandidateInfo.values()]
          const distinctByMessageId = <
            T extends { userMessageId: string | null },
          >(
            candidates: readonly T[]
          ): T[] => {
            const unique = new Map<string, T>()
            for (const candidate of candidates) {
              if (
                candidate.userMessageId !== null &&
                !unique.has(candidate.userMessageId)
              ) {
                unique.set(candidate.userMessageId, candidate)
              }
            }
            return [...unique.values()]
          }
          const liveIdentified = distinctByMessageId(
            liveCandidates.map(([request, info]) => ({ request, ...info }))
          )
          const liveIds = new Set(
            liveIdentified
              .map((candidate) => candidate.userMessageId)
              .filter((id): id is string => id !== null)
          )
          const capturedIdentified = distinctByMessageId(
            capturedCandidates.filter(
              (candidate) =>
                candidate.userMessageId === null ||
                !liveIds.has(candidate.userMessageId)
            )
          )

          let selectedLive: LiveCandidate | null = null
          let selectedCaptured: CapturedCandidate | null = null
          let selectedUserMessageId: string | null = null

          if (liveCandidates.length > 0) {
            if (liveIdentified.length === 1) {
              // Prefer the only live candidate with a stable message id. A
              // captured entry with that same id is the response mirror, not
              // a second request candidate.
              const identified = liveIdentified[0]
              if (identified !== undefined) {
                selectedLive = [
                  identified.request,
                  {
                    requestBody: identified.requestBody,
                    userMessageId: identified.userMessageId,
                  },
                ]
                selectedUserMessageId = identified.userMessageId
                selectedCaptured =
                  capturedCandidates.find(
                    (candidate) =>
                      candidate.userMessageId === selectedUserMessageId
                  ) ?? null
              }
              if (
                capturedIdentified.some(
                  (candidate) =>
                    candidate.userMessageId !== null &&
                    candidate.userMessageId !== selectedUserMessageId
                )
              ) {
                selectedLive = null
                selectedCaptured = null
                selectedUserMessageId = null
              }
            } else if (
              liveIdentified.length === 0 &&
              liveCandidates.length === 1 &&
              capturedCandidates.length === 0 &&
              (liveCandidates[0]?.[1].requestBody === null ||
                liveCandidates[0]?.[1].requestBody === undefined ||
                liveCandidates[0]?.[1].requestBody.trim() === '')
            ) {
              // A single route-constrained request is a safe-enough fallback
              // when the browser exposes no request body at all. Captured
              // entries are intentionally ignored while a live Request exists:
              // they have no proven identity relationship with that Request.
              selectedLive = liveCandidates[0] ?? null
            }
          } else if (capturedIdentified.length === 1) {
            // A fetch capture can be the only observable transport when the
            // browser does not expose a Playwright Request event.
            selectedCaptured = capturedIdentified[0] ?? null
            selectedUserMessageId = selectedCaptured?.userMessageId ?? null
          } else if (
            capturedIdentified.length === 0 &&
            capturedCandidates.length === 1 &&
            (capturedCandidates[0]?.requestBody === null ||
              capturedCandidates[0]?.requestBody === undefined ||
              capturedCandidates[0]?.requestBody.trim() === '')
          ) {
            // As with a body-free live request, a unique captured entry can
            // be used for its HTTP response but not for unanchored WebSocket
            // frames.
            selectedCaptured = capturedCandidates[0] ?? null
          }

          if (selectedLive === null && selectedCaptured === null) {
            // Any unresolved pair of candidates is ambiguous. A single
            // readable body without an id is merely unidentifiable and is
            // reported as a missing owner instead.
            if (liveCandidates.length + capturedCandidates.length > 1) {
              ambiguousRequest = true
              observation.requestAmbiguous = true
            }
            return
          }

          const request = selectedLive?.[0] ?? null
          const info = selectedLive?.[1] ?? selectedCaptured!
          ownedUserMessageId =
            selectedUserMessageId ?? info.userMessageId ?? null
          ownedRequests.clear()
          if (request !== null) {
            ownedRequests.add(request)
            if (ownedUserMessageId !== null) {
              for (const [candidateRequest, candidateInfo] of liveCandidates) {
                if (candidateInfo.userMessageId === ownedUserMessageId) {
                  ownedRequests.add(candidateRequest)
                }
              }
            }
          }
          ownedCapturedEntryId = selectedCaptured?.entry.id ?? null
          observation.ownedRequest = true
          observation.ownedUserMessageId = ownedUserMessageId !== null
          observation.phase = 'awaiting-response'
          // Keep every frame observed after dispatch. A background response
          // can arrive before the matching Request event, so slicing at
          // adoption time would discard evidence needed for ownership checks.
          ownedFrameStartIndex = frameStart
          this.pendingText = ''

          if (request === null) {
            resolveRequestStarted()
            if (selectedCaptured?.entry.status === 200) {
              settleHttpResponse({ kind: 'resolve' })
            }
            return
          }

          // Replay every same-ID response that arrived during the settle
          // window. A retry may be the only request that produces a usable
          // response; processing only the first Request would lose it.
          for (const [pendingRequest, pendingResponse] of pendingResponses) {
            if (!ownedRequests.has(pendingRequest)) continue
            pendingResponses.delete(pendingRequest)
            processOwnedResponse(pendingResponse)
          }
          for (const [pendingRequest, pendingFailure] of pendingFailures) {
            if (!ownedRequests.has(pendingRequest)) continue
            pendingFailures.delete(pendingRequest)
            processOwnedFailure(pendingRequest, pendingFailure)
          }
        }

        const scheduleRequestOwnershipSettlement = () => {
          if (requestOwnershipSettled !== null) return
          requestOwnershipSettled = delayAsync(
            CHATGPT_REQUEST_OWNERSHIP_SETTLE_MS,
            signal
          )
            .then(() => {
              finalizeRequestOwnership()
            })
            .catch(() => {})
        }

        const recordRequestCandidate = (
          request: import('playwright').Request
        ): boolean => {
          // A response can arrive after dispatch for a request that started
          // before the send button was clicked. It is never a candidate for
          // this submit, even if its body contains a plausible message id.
          if (preDispatchRequests.has(request)) return false
          if (
            dispatchStartedAt !== null &&
            (readChatGPTRequestStartTime(request) ?? dispatchStartedAt) <
              dispatchStartedAt
          ) {
            return false
          }
          if (!dispatchStarted) return false
          if (candidateRequests.has(request)) return true
          const candidate = request as import('playwright').Request & {
            postData?: () => string | null
          }
          let requestBody: string | null = null
          try {
            requestBody =
              typeof candidate.postData === 'function'
                ? (candidate.postData() ?? null)
                : null
          } catch {
            // Some Playwright request implementations cannot expose bodies.
          }
          candidateRequests.add(request)
          const requestInfo = {
            requestBody,
            userMessageId: readChatGPTSubmittedMessageId(requestBody) ?? null,
          }
          candidateRequestInfo.set(request, requestInfo)
          refreshCandidateCount()
          if (ownershipSettled) {
            // A retry for the same user message is still the same logical
            // candidate. A distinct id, however, means the response can no
            // longer be attributed safely.
            if (
              requestInfo.userMessageId !== null &&
              requestInfo.userMessageId === ownedUserMessageId
            ) {
              ownedRequests.add(request)
              ownedRequestFailures.delete(request)
              clearOwnedFailureTimer()
              return true
            }
            // A body-free background request cannot disprove an already
            // identified request; its response will still be checked by
            // Playwright Request identity.
            if (
              requestInfo.userMessageId === null &&
              ownedUserMessageId !== null
            ) {
              return true
            }
            ambiguousRequest = true
            observation.requestAmbiguous = true
            return true
          }
          if (
            provisionalUserMessageId === null &&
            requestInfo.userMessageId !== null
          ) {
            provisionalUserMessageId = requestInfo.userMessageId
          }
          // Seeing a target request is submit activity even before ownership
          // settles; this prevents a very short response-start timer from
          // firing during the 100ms candidate window.
          this.emitSubmitActivitySafely()
          scheduleRequestOwnershipSettlement()
          return true
        }

        const scanCapturedCandidates = async (): Promise<void> => {
          if (!dispatchStarted) return
          let entries: CapturedFetchEntry[]
          try {
            entries = (
              await this.getCapturedFetchEntries(fetchCaptureStartIndex)
            ).filter(
              (entry) =>
                this.isTargetCapturedConversationEntry(entry) &&
                (dispatchStartedAt === null ||
                  entry.startedAt === undefined ||
                  entry.startedAt >= dispatchStartedAt)
            )
          } catch {
            return
          }
          for (const entry of entries) {
            if (capturedCandidateInfo.has(entry.id)) continue
            const requestBody = entry.requestBody ?? null
            const userMessageId =
              readChatGPTSubmittedMessageId(requestBody) ?? null
            const info = { entry, requestBody, userMessageId }
            capturedCandidateInfo.set(entry.id, info)
            refreshCandidateCount()

            if (ownershipSettled) {
              if (
                entry.id === ownedCapturedEntryId ||
                (userMessageId !== null && userMessageId === ownedUserMessageId)
              ) {
                continue
              }
              // A body-free capture is only a response mirror and cannot
              // establish a conflicting request after a live request owns the
              // submit. A distinct id remains an ambiguity signal.
              if (userMessageId === null) {
                continue
              }
              ambiguousRequest = true
              observation.requestAmbiguous = true
              continue
            }

            if (provisionalUserMessageId === null && userMessageId !== null) {
              provisionalUserMessageId = userMessageId
            }
            this.emitSubmitActivitySafely()
            scheduleRequestOwnershipSettlement()
          }
        }

        const onRequest = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (recordRequestCandidate(request)) {
            resolveRequestStarted()
          }
        }

        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordRequestCandidate(request)) {
            return
          }
          resolveRequestStarted()
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          if (!ownershipSettled) {
            pendingFailures.set(request, failureText)
          } else {
            processOwnedFailure(request, failureText)
          }
        }

        const onResponse = (response: import('playwright').Response) => {
          const request = response.request()
          if (!this.isTargetConversationRequest(request)) {
            return
          }
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordRequestCandidate(request)) {
            return
          }
          resolveRequestStarted()
          if (!ownershipSettled) {
            pendingResponses.set(request, response)
            return
          }
          processOwnedResponse(response)
        }

        const onClose = () => {
          settleHttpResponse({
            kind: 'reject',
            error: new Error(
              'Target page, context or browser has been closed.'
            ),
          })
        }

        const emitSnapshot = async (
          text: string,
          isFinished: boolean
        ): Promise<void> => {
          const currentText = text.trim()
          if (!currentText || currentText === lastStreamedText) return
          lastStreamedText = currentText
          observation.parsedOwnedText = true
          observation.parsedFinished ||= isFinished
          observation.phase = isFinished ? 'response-complete' : 'streaming'
          await this.emitSubmitText(text)
        }

        const emitCurrentStreamText = async (
          response: ChatGPTParsedResponse | null
        ) => {
          const currentText = response?.text?.trim() ?? ''
          if (!ownershipSettled) {
            if (
              currentText &&
              pendingStreamSnapshots.at(-1)?.text.trim() !== currentText
            ) {
              pendingStreamSnapshots.push({
                text: response!.text,
                isFinished: response!.isFinished,
              })
            }
            return
          }
          throwIfAborted(signal)
          if (ambiguousRequest) return
          for (const snapshot of pendingStreamSnapshots.splice(0)) {
            throwIfAborted(signal)
            if (ambiguousRequest) return
            await emitSnapshot(snapshot.text, snapshot.isFinished)
            throwIfAborted(signal)
            if (ambiguousRequest) return
          }
          if (response?.isFinished === true && !finishedProgressReported) {
            finishedProgressReported = true
            this.emitSubmitActivitySafely()
          }
          throwIfAborted(signal)
          if (ambiguousRequest) return
          if (response !== null) {
            await emitSnapshot(response.text, response.isFinished)
            throwIfAborted(signal)
          }
        }

        const pickCurrentResponse = (): ChatGPTParsedResponse | null => {
          if (ambiguousRequest) {
            return null
          }
          const currentPageUrl =
            typeof this.page.url === 'function' ? this.page.url() : null
          const websocketCorrelationAvailable =
            httpParsedResponse?.messageId !== undefined ||
            ownedUserMessageId !== null ||
            provisionalUserMessageId !== null
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
              ownedUserMessageId ?? provisionalUserMessageId,
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
                    ? provisionalUserMessageId === null
                      ? {}
                      : { expectedParentMessageId: provisionalUserMessageId }
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
          const httpCandidate =
            httpParsedResponse !== null &&
            httpParsedResponse.text.trim().length > 0
              ? httpParsedResponse
              : null
          const websocketCandidate =
            websocketParsedResponse !== null &&
            websocketParsedResponse.text.trim().length > 0
              ? websocketParsedResponse
              : null
          const best =
            httpCandidate !== null && websocketCandidate !== null
              ? httpCandidate.messageId !== undefined &&
                websocketCandidate.messageId === httpCandidate.messageId
                ? websocketCandidate.isFinished ||
                  websocketCandidate.text.length >= httpCandidate.text.length
                  ? websocketCandidate
                  : httpCandidate
                : websocketCandidate.isFinished || !httpCandidate.isFinished
                  ? websocketCandidate
                  : httpCandidate
              : (httpCandidate ?? websocketCandidate)
          if (best === null || best === undefined) {
            return null
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
              await scanCapturedCandidates()
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
          // Establish the capture baseline immediately before dispatch so
          // entries registered by earlier in-flight requests are excluded.
          fetchCaptureStartIndex = await this.getCapturedFetchEntryCount()
          dispatchStartedAt = Date.now()
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
          clearOwnedFailureTimer()
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
