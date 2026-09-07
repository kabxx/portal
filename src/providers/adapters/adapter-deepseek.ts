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
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { retryAsync } from '../../shared/retry.ts'
import { waitAsync } from '../../shared/wait.ts'
import {
  emptyHistoryResult,
  parseDeepSeekHistory,
} from '../conversation-history.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import {
  DeepSeekUi,
  type DeepSeekToggleCapability,
  type DeepSeekToggleState,
} from '../ui/deepseek/deepseek-ui.ts'

const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com'
const DEEPSEEK_REQUEST_OWNERSHIP_SETTLE_MS = 25
const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion'
type DeepSeekParsedResponse = {
  messageId?: number
  parentId?: number
  text: string
  isFinished: boolean
}

type DeepSeekResponseFragment = {
  type: string | null
  content: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readDeepSeekConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'chat.deepseek.com') {
      return undefined
    }
    const match = url.pathname.match(/^\/a\/chat\/s\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

function readDeepSeekRequestStartTime(
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

export class DeepSeekAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'deepseek' as const
  }

  private conversationIdVal!: string | null
  private pendingText = ''

  private get ui(): DeepSeekUi {
    return new DeepSeekUi(this.page)
  }

  public async hasToggleCapability(
    capability: DeepSeekToggleCapability
  ): Promise<boolean> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Available`,
      async () => await this.ui.hasToggleCapability(capability)
    )
  }

  public async getToggleState(
    capability: DeepSeekToggleCapability
  ): Promise<DeepSeekToggleState> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Status`,
      async () => await this.ui.getToggleState(capability)
    )
  }

  public async setToggleState(
    capability: DeepSeekToggleCapability,
    targetState: DeepSeekToggleState
  ): Promise<DeepSeekToggleState> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Set`,
      async () => await this.ui.setToggleState(capability, targetState)
    )
  }

  private async waitForReadyButton(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await this.ui.waitForReady(action, timeoutMs, signal)
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
    this.conversationIdVal =
      readDeepSeekConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore({ signal })
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      return this.page.url().startsWith(DEEPSEEK_CHAT_URL)
    }
    try {
      await retryAsync(async () => {
        await this.wrapAdapterActionErrorAsync('restore', async () => {
          await abortable(
            this.page.goto(this.conversationUrl, {
              waitUntil: 'domcontentloaded',
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
      if (!(await this.isLoggedIn({ signal }))) {
        throw new ProviderAdapterError(
          'restore',
          'DeepSeek is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'deepseek_signed_out',
          }
        )
      }
      await this.waitForReadyButton(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'DeepSeek restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'deepseek_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    throwIfAborted(options.signal)
    const entry = (
      await this.getCapturedHistoryEntries(
        (candidate) =>
          candidate.method === 'GET' &&
          candidate.status === 200 &&
          candidate.url.includes('/api/v0/chat/history_messages'),
        options
      )
    ).find((candidate) => candidate.chunks.join('').trim())
    if (entry === undefined) {
      return emptyHistoryResult('DeepSeek history response was not captured.')
    }
    const result = parseDeepSeekHistory(entry.chunks.join(''))
    if (result.complete) {
      return result
    }

    const isHistoryResponse = (candidate: {
      method: string
      status: number | null
      url: string
    }) =>
      candidate.method === 'GET' &&
      candidate.status === 200 &&
      candidate.url.includes('/api/v0/chat/history_messages')
    const originalHeaders = await this.getCapturedHistoryRequestHeaders(
      isHistoryResponse,
      options
    )
    if (originalHeaders === null) {
      return {
        ...result,
        complete: false,
        warning:
          'DeepSeek history is incomplete because Portal could not replay the authenticated full-history request.',
      }
    }
    const replayHeaders = Object.fromEntries(
      Object.entries(originalHeaders).filter(([name]) => {
        const normalized = name.toLowerCase()
        return normalized === 'authorization' || normalized.startsWith('x-')
      })
    )
    const fullHistoryUrl = new URL(entry.url, DEEPSEEK_CHAT_URL)
    fullHistoryUrl.searchParams.delete('cache_version')
    fullHistoryUrl.searchParams.delete('cache_reset_at')

    const replayTimeoutSignal = AbortSignal.timeout(
      this.getHistoryLoadTimeoutMs()
    )
    const replaySignal =
      options.signal === undefined
        ? replayTimeoutSignal
        : AbortSignal.any([options.signal, replayTimeoutSignal])

    try {
      const fullHistoryResponse = await abortable(
        this.page.evaluate(
          async ({ url, headers }) => {
            const response = await fetch(url, {
              credentials: 'include',
              headers,
            })
            return {
              body: await response.text(),
              ok: response.ok,
              status: response.status,
            }
          },
          { url: fullHistoryUrl.toString(), headers: replayHeaders }
        ),
        replaySignal
      )
      if (!fullHistoryResponse.ok) {
        return {
          ...result,
          complete: false,
          warning: `DeepSeek history is incomplete because the full-history request returned HTTP ${fullHistoryResponse.status}.`,
        }
      }
      const fullResult = parseDeepSeekHistory(fullHistoryResponse.body)
      if (fullResult.complete) {
        return fullResult
      }
      return fullResult.messages.length > result.messages.length
        ? fullResult
        : result
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (replayTimeoutSignal.aborted) {
        return {
          ...result,
          complete: false,
          warning:
            'DeepSeek history is incomplete because the full-history request timed out.',
        }
      }
      if (isAbortError(error)) throw error
      return {
        ...result,
        complete: false,
        warning:
          'DeepSeek history is incomplete because the full-history request failed.',
      }
    }
  }

  public async isLoggedIn(options: AbortOptions = {}): Promise<boolean> {
    return await abortable(this.ui.isLoggedIn(), options.signal)
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.ui.selectModel(model)
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
    const controls = this.ui.getRetryLocators()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'DeepSeek',
      isComposerReady: async () =>
        await this.isRetryComposerReady(controls.composer),
      readComposerText: async () =>
        await this.readRetryComposerText(controls.composer),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(controls.composer).finally(() => {
          this.pendingText = ''
        }),
      isStopActive: async () => await this.isRetryControlActive(controls.stop),
      isSendReady: async () => await this.isRetryControlReady(controls.send),
    })
  }

  public async attachFile(path: string | readonly string[]) {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.ui.attachFile(path)
    })
  }

  public async attachImage(path: string | readonly string[]) {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.ui.stopGeneration()
  }

  private isTargetCompletionRequest(
    request: import('playwright').Request
  ): boolean {
    if (request.method() !== 'POST') return false
    try {
      const url = new URL(request.url())
      return (
        url.origin === DEEPSEEK_CHAT_URL &&
        url.pathname === DEEPSEEK_COMPLETION_PATH
      )
    } catch {
      return false
    }
  }

  private isTargetCapturedCompletionEntry(entry: CapturedFetchEntry): boolean {
    if (entry.method !== 'POST') return false
    try {
      const url = new URL(entry.url, DEEPSEEK_CHAT_URL)
      return (
        url.origin === DEEPSEEK_CHAT_URL &&
        url.pathname === DEEPSEEK_COMPLETION_PATH
      )
    } catch {
      return false
    }
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('DeepSeek')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number,
    dispatchStartedAt: number,
    capturedEntryId: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const parsedResponse = await this.readCurrentCapturedResponse(
      fetchCaptureStartIndex,
      dispatchStartedAt,
      capturedEntryId,
      signal
    )
    const text = parsedResponse?.text.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  private async readCurrentCapturedResponse(
    fetchCaptureStartIndex: number,
    dispatchStartedAt: number,
    capturedEntryId: number,
    signal?: AbortSignal
  ): Promise<DeepSeekParsedResponse | null> {
    const raw = await this.readCurrentCapturedRawResponse(
      fetchCaptureStartIndex,
      dispatchStartedAt,
      capturedEntryId,
      signal
    )
    return raw === null ? null : this.parseResponse(raw)
  }

  private async readCurrentCapturedRawResponse(
    fetchCaptureStartIndex: number,
    dispatchStartedAt: number,
    capturedEntryId: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const entries = (
      await abortable(
        this.getCapturedFetchEntries(fetchCaptureStartIndex),
        signal
      )
    )
      .filter(
        (entry) =>
          this.isTargetCapturedCompletionEntry(entry) &&
          entry.startedAt !== undefined &&
          entry.startedAt >= dispatchStartedAt
      )
      .filter((entry) => entry.id === capturedEntryId)
    throwIfAborted(signal)
    this.reportCapturedSubmitActivity(entries)
    const entry = entries.at(-1)
    if (entry === undefined) return null
    const body = entry.chunks.join('')
    return body.trim() ? body : null
  }

  private async waitForCapturedFinishedResponse(
    fetchCaptureStartIndex: number,
    dispatchStartedAt: number,
    capturedEntryId: number,
    signal?: AbortSignal
  ): Promise<DeepSeekParsedResponse> {
    let parsedResponse: DeepSeekParsedResponse | null = null
    await waitAsync(
      async () => {
        const rawResponse = await this.readCurrentCapturedRawResponse(
          fetchCaptureStartIndex,
          dispatchStartedAt,
          capturedEntryId,
          signal
        )
        throwIfAborted(signal)
        if (rawResponse === null) return false
        parsedResponse = this.parseResponse(rawResponse)
        return parsedResponse?.isFinished === true
      },
      {
        timeoutMs: this.getSubmitResponseTimeoutMs(),
        signal,
        onTimeout: async () => {
          throw new Error(
            'Timed out waiting for DeepSeek response to reach finished state.'
          )
        },
      }
    )
    if (parsedResponse !== null) return parsedResponse
    throw new ProviderAdapterError(
      'submit',
      'Failed to parse DeepSeek response.',
      {
        kind: 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'deepseek_response_parse_failed',
      }
    )
  }

  private async readFinishedPlaywrightResponse(
    response: import('playwright').Response,
    signal?: AbortSignal
  ): Promise<DeepSeekParsedResponse> {
    const raw = await abortable(response.text(), signal)
    const parsed = this.parseResponse(raw)
    if (parsed?.isFinished === true) return parsed
    throw new ProviderAdapterError(
      'submit',
      'Failed to parse DeepSeek response.',
      {
        kind: 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'deepseek_response_parse_failed',
      }
    )
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    let dispatchAttempted = false
    let terminalEvidenceObserved = false
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.ui.waitForSendReady(
          this.getSubmitResponseTimeoutMs(),
          signal
        )
        throwIfAborted(signal)
        let fetchCaptureStartIndex = 0
        const requestStarted = createDeferred<void>()
        const targetResponse = createDeferred<
          import('playwright').Response | null
        >()
        let requestObserved = false
        let responseObserved = false
        let dispatchStarted = false
        let dispatchStartedAt: number | null = null
        let ownedRequest: import('playwright').Request | null = null
        let ownedCapturedEntryId: number | null = null
        let liveCapturedMirrorEntryId: number | null = null
        const candidateRequests = new Set<import('playwright').Request>()
        const preDispatchRequests = new Set<import('playwright').Request>()
        const seenRequestEvents = new Set<import('playwright').Request>()
        const capturedCandidates = new Map<number, CapturedFetchEntry>()
        const pendingResponses = new Map<
          import('playwright').Request,
          import('playwright').Response
        >()
        const pendingFailures = new Map<import('playwright').Request, string>()
        let ambiguousRequest = false
        let ownershipSettled = false
        let ownershipGeneration = 0
        let requestOwnershipSettled: Promise<void> | null = null
        const ownershipController = new AbortController()
        const ownershipSignal =
          signal === undefined
            ? ownershipController.signal
            : AbortSignal.any([signal, ownershipController.signal])
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let settled = false

        const stopWarningTimer = () => {
          if (warningTimer !== null) {
            clearInterval(warningTimer)
            warningTimer = null
          }
        }

        const resolveRequestStarted = () => {
          if (requestObserved) return
          requestObserved = true
          stopWarningTimer()
          requestStarted.resolve()
        }

        const settleTargetResponse = (
          resolution:
            | {
                kind: 'resolve'
                response: import('playwright').Response | null
              }
            | { kind: 'reject'; error: unknown }
        ) => {
          if (settled) return
          settled = true
          stopWarningTimer()
          if (resolution.kind === 'resolve') {
            responseObserved = true
            targetResponse.resolve(resolution.response)
          } else {
            terminalError = resolution.error
            targetResponse.reject(resolution.error)
          }
        }

        const createOwnershipError = () =>
          new ProviderAdapterError(
            'submit',
            buildResponseOwnershipErrorMessage('DeepSeek'),
            {
              kind: 'unknown',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'deepseek_response_ownership_ambiguous',
            }
          )

        const throwIfCaptureReadCancelled = () => {
          throwIfAborted(signal)
          if (ownershipController.signal.aborted) {
            throw createOwnershipError()
          }
        }

        const markAmbiguous = () => {
          if (ambiguousRequest) return
          ambiguousRequest = true
          ownershipGeneration += 1
          ownedRequest = null
          ownedCapturedEntryId = null
          ownershipController.abort()
          settleTargetResponse({
            kind: 'reject',
            error: createOwnershipError(),
          })
        }

        const isOwnershipCurrent = (
          generation: number,
          request: import('playwright').Request | null,
          capturedEntryId: number | null
        ) =>
          ownershipSettled &&
          !ambiguousRequest &&
          ownershipGeneration === generation &&
          ownedRequest === request &&
          ownedCapturedEntryId === capturedEntryId

        const assertOwnershipCurrent = (
          generation: number,
          request: import('playwright').Request | null,
          capturedEntryId: number | null
        ) => {
          if (!isOwnershipCurrent(generation, request, capturedEntryId)) {
            throw createOwnershipError()
          }
        }

        const assertOperationCurrent = (
          generation: number,
          request: import('playwright').Request | null,
          capturedEntryId: number | null
        ) => {
          throwIfAborted(signal)
          assertOwnershipCurrent(generation, request, capturedEntryId)
        }

        const processOwnedResponse = (
          response: import('playwright').Response
        ) => {
          if (ambiguousRequest || ownedRequest === null) return
          if (response.request() !== ownedRequest) return
          this.emitSubmitActivitySafely()
          settleTargetResponse({ kind: 'resolve', response })
        }

        const processOwnedFailure = (
          request: import('playwright').Request,
          failureText: string
        ) => {
          if (ambiguousRequest || ownedRequest !== request) return
          settleTargetResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `DeepSeek request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'deepseek_submit_request_failed',
              }
            ),
          })
        }

        let scanCapturedCandidates = async (): Promise<void> => {}
        const reportOwnedCapturedActivity = (
          entries: readonly CapturedFetchEntry[]
        ) => {
          if (!ownershipSettled || ambiguousRequest) return
          const capturedEntryId =
            ownedRequest === null
              ? ownedCapturedEntryId
              : liveCapturedMirrorEntryId
          if (capturedEntryId === null) return
          const entry = entries.find(
            (candidate) => candidate.id === capturedEntryId
          )
          if (entry !== undefined) {
            this.reportCapturedSubmitActivity([entry])
          }
        }

        const finalizeRequestOwnership = () => {
          if (ownershipSettled || ambiguousRequest) return
          const liveCandidates = [...candidateRequests]
          const capturedEntries = [...capturedCandidates.values()]
          if (liveCandidates.length > 1 || capturedEntries.length > 1) {
            ownershipSettled = true
            markAmbiguous()
            return
          }
          if (liveCandidates.length === 0 && capturedEntries.length === 0) {
            return
          }
          ownershipSettled = true
          ownershipGeneration += 1
          if (liveCandidates.length === 1) {
            ownedRequest = liveCandidates[0]!
            ownedCapturedEntryId = null
            liveCapturedMirrorEntryId = capturedEntries[0]?.id ?? null
          } else {
            ownedRequest = null
            ownedCapturedEntryId = capturedEntries[0]!.id
          }
          this.pendingText = ''
          resolveRequestStarted()
          reportOwnedCapturedActivity(capturedEntries)
          if (ownedRequest === null) {
            settleTargetResponse({ kind: 'resolve', response: null })
            return
          }
          for (const [pendingRequest, pendingResponse] of pendingResponses) {
            if (pendingRequest === ownedRequest) {
              pendingResponses.delete(pendingRequest)
              processOwnedResponse(pendingResponse)
            }
          }
          for (const [pendingRequest, pendingFailure] of pendingFailures) {
            if (pendingRequest === ownedRequest) {
              pendingFailures.delete(pendingRequest)
              processOwnedFailure(pendingRequest, pendingFailure)
            }
          }
        }

        const scheduleRequestOwnershipSettlement = () => {
          if (requestOwnershipSettled !== null) return
          requestOwnershipSettled = delayAsync(
            DEEPSEEK_REQUEST_OWNERSHIP_SETTLE_MS,
            signal
          )
            .then(async () => {
              await scanCapturedCandidates()
              finalizeRequestOwnership()
            })
            .catch(() => {})
        }

        const recordRequestCandidate = (
          request: import('playwright').Request,
          source: 'request' | 'response' | 'failure'
        ): boolean => {
          if (!dispatchStarted || preDispatchRequests.has(request)) return false
          const requestStartTime = readDeepSeekRequestStartTime(request)
          if (
            dispatchStartedAt !== null &&
            requestStartTime !== undefined &&
            requestStartTime < dispatchStartedAt
          ) {
            preDispatchRequests.add(request)
            return false
          }
          if (
            source !== 'request' &&
            !seenRequestEvents.has(request) &&
            requestStartTime === undefined
          ) {
            // A response/failure with no preceding request event and no timing
            // data may belong to an in-flight request from before dispatch.
            preDispatchRequests.add(request)
            return false
          }
          if (candidateRequests.has(request)) return true
          candidateRequests.add(request)
          if (ownershipSettled) {
            markAmbiguous()
            return true
          }
          this.emitSubmitActivitySafely()
          scheduleRequestOwnershipSettlement()
          return true
        }

        scanCapturedCandidates = async (): Promise<void> => {
          if (!dispatchStarted || dispatchStartedAt === null) return
          let entries: CapturedFetchEntry[]
          try {
            entries = (
              await abortable(
                this.getCapturedFetchEntries(fetchCaptureStartIndex),
                ownershipSignal
              )
            ).filter(
              (entry) =>
                this.isTargetCapturedCompletionEntry(entry) &&
                entry.startedAt !== undefined &&
                entry.startedAt >= dispatchStartedAt!
            )
          } catch (error) {
            if (isAbortError(error)) {
              throwIfCaptureReadCancelled()
              throw error
            }
            return
          }
          throwIfCaptureReadCancelled()
          for (const entry of entries) {
            if (capturedCandidates.has(entry.id)) continue
            capturedCandidates.set(entry.id, entry)
            if (ownershipSettled) {
              if (ownedRequest !== null && liveCapturedMirrorEntryId === null) {
                liveCapturedMirrorEntryId = entry.id
              } else {
                markAmbiguous()
              }
              continue
            }
            resolveRequestStarted()
            scheduleRequestOwnershipSettlement()
          }
          reportOwnedCapturedActivity(entries)
        }

        const onRequest = (request: import('playwright').Request) => {
          if (!this.isTargetCompletionRequest(request)) return
          seenRequestEvents.add(request)
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (recordRequestCandidate(request, 'request'))
            resolveRequestStarted()
        }

        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetCompletionRequest(request)) return
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordRequestCandidate(request, 'failure')) return
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
          if (!this.isTargetCompletionRequest(request)) return
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordRequestCandidate(request, 'response')) return
          resolveRequestStarted()
          if (!ownershipSettled) {
            pendingResponses.set(request, response)
          } else {
            processOwnedResponse(response)
          }
        }

        const onClose = () => {
          settleTargetResponse({
            kind: 'reject',
            error: new Error(
              'Target page, context or browser has been closed.'
            ),
          })
        }

        this.page.on('request', onRequest)
        this.page.on('requestfailed', onRequestFailed)
        this.page.on('response', onResponse)
        this.page.on('close', onClose)

        let stopSubmitTextPolling = () => {}
        let lastStreamedText = ''
        try {
          stopSubmitTextPolling = this.startSubmitTextPolling(async () => {
            await scanCapturedCandidates()
            if (
              !ownershipSettled ||
              ambiguousRequest ||
              ownedRequest !== null ||
              ownedCapturedEntryId === null
            ) {
              return null
            }
            const expectedGeneration = ownershipGeneration
            const expectedCapturedEntryId = ownedCapturedEntryId
            const text = await this.readCurrentStreamedResponseText(
              fetchCaptureStartIndex,
              dispatchStartedAt!,
              expectedCapturedEntryId,
              ownershipSignal
            )
            throwIfCaptureReadCancelled()
            await scanCapturedCandidates()
            if (
              !isOwnershipCurrent(
                expectedGeneration,
                null,
                expectedCapturedEntryId
              )
            ) {
              return null
            }
            if (text !== null) lastStreamedText = text
            return text
          })

          this.emitSubmitDispatching(signal)
          fetchCaptureStartIndex = await this.getCapturedFetchEntryCount()
          dispatchStartedAt = Date.now()
          dispatchStarted = true
          dispatchAttempted = true
          await this.ui.clickSend()
          this.emitSubmitSent()
          throwIfAborted(signal)
          await scanCapturedCandidates()

          await abortable(
            Promise.race([
              delayAsync(this.getSubmitRequestStartGraceMs(), signal),
              requestStarted.promise,
              targetResponse.promise,
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
              Promise.race([requestStarted.promise, targetResponse.promise]),
              signal
            )
          }

          const response = await awaitWithTimeout(
            targetResponse.promise,
            this.getSubmitResponseTimeoutMs(),
            () =>
              new Error(
                'Timed out waiting for DeepSeek response after the request started.'
              ),
            { signal }
          )
          if (requestOwnershipSettled !== null) {
            await Promise.resolve(requestOwnershipSettled)
          }
          await scanCapturedCandidates()
          const expectedGeneration = ownershipGeneration
          const expectedRequest = ownedRequest
          const expectedCapturedEntryId = ownedCapturedEntryId
          assertOperationCurrent(
            expectedGeneration,
            expectedRequest,
            expectedCapturedEntryId
          )
          let parsedResponse: DeepSeekParsedResponse
          try {
            if (response === null) {
              if (
                expectedRequest !== null ||
                expectedCapturedEntryId === null
              ) {
                throw createOwnershipError()
              }
              parsedResponse = await this.waitForCapturedFinishedResponse(
                fetchCaptureStartIndex,
                dispatchStartedAt,
                expectedCapturedEntryId,
                ownershipSignal
              )
            } else {
              if (
                expectedRequest === null ||
                response.request() !== expectedRequest ||
                expectedCapturedEntryId !== null
              ) {
                throw createOwnershipError()
              }
              parsedResponse = await awaitWithTimeout(
                this.readFinishedPlaywrightResponse(response, ownershipSignal),
                this.getSubmitResponseTimeoutMs(),
                () =>
                  new Error(
                    'Timed out waiting for DeepSeek response body to finish.'
                  ),
                { signal: ownershipSignal }
              )
            }
          } catch (error) {
            if (ambiguousRequest) throw createOwnershipError()
            throw error
          }
          await scanCapturedCandidates()
          assertOperationCurrent(
            expectedGeneration,
            expectedRequest,
            expectedCapturedEntryId
          )
          terminalEvidenceObserved = true
          try {
            await this.ui.waitForReady(
              'submit',
              this.getSubmitResponseTimeoutMs(),
              ownershipSignal
            )
          } catch (error) {
            if (ambiguousRequest) throw createOwnershipError()
            throw error
          }
          await scanCapturedCandidates()
          assertOperationCurrent(
            expectedGeneration,
            expectedRequest,
            expectedCapturedEntryId
          )
          stopSubmitTextPolling()
          this.conversationIdVal =
            this.conversationIdVal ??
            this.page.url().match(/\/a\/chat\/s\/([^/?#]+)/)?.[1] ??
            null
          if (lastStreamedText !== parsedResponse.text) {
            assertOperationCurrent(
              expectedGeneration,
              expectedRequest,
              expectedCapturedEntryId
            )
            await this.emitSubmitText(parsedResponse.text)
            assertOperationCurrent(
              expectedGeneration,
              expectedRequest,
              expectedCapturedEntryId
            )
          }
          await scanCapturedCandidates()
          assertOperationCurrent(
            expectedGeneration,
            expectedRequest,
            expectedCapturedEntryId
          )
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
      if (dispatchAttempted && !terminalEvidenceObserved) {
        throw new ProviderAdapterError(
          'submit',
          buildSubmitOutcomeUnknownMessage('DeepSeek'),
          {
            kind: 'unknown',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'deepseek_submit_outcome_unknown',
            cause: error,
          }
        )
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'DeepSeek submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'deepseek_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private parseResponse(raw: string): DeepSeekParsedResponse | null {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const fragments: DeepSeekResponseFragment[] = []
    let messageId: number | undefined
    let parentId: number | undefined
    let isFinished = false

    const appendTextToLastFragment = (value: unknown): void => {
      if (typeof value === 'string') {
        const lastFragment = fragments.at(-1)
        if (lastFragment !== undefined) {
          lastFragment.content += value
          return
        }
        fragments.push({ type: 'RESPONSE', content: value })
        return
      }
    }

    const appendFragments = (value: unknown): void => {
      if (!Array.isArray(value)) {
        return
      }
      for (const fragment of value) {
        if (!isRecord(fragment)) {
          continue
        }
        fragments.push({
          type: typeof fragment.type === 'string' ? fragment.type : null,
          content: typeof fragment.content === 'string' ? fragment.content : '',
        })
      }
    }

    const applyPatch = (patch: unknown): void => {
      if (!isRecord(patch)) {
        return
      }
      const path = typeof patch.p === 'string' ? patch.p : ''
      const op = typeof patch.o === 'string' ? patch.o : ''
      const value = patch.v

      if (path === 'response/fragments/-1/content') {
        appendTextToLastFragment(value)
        return
      }
      if (path === 'response/fragments') {
        appendFragments(value)
        return
      }
      if (path === 'response/status' && op === 'SET' && value === 'FINISHED') {
        isFinished = true
        return
      }
      if (path === 'response' && op === 'BATCH' && Array.isArray(value)) {
        for (const item of value) {
          applyPatch(item)
        }
        return
      }
      if (path === 'accumulated_token_usage') {
        return
      }
    }

    for (const line of lines) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (!payload) {
          continue
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        if (!isRecord(parsed)) {
          continue
        }
        if (isRecord(parsed.v)) {
          const response = parsed.v.response
          if (isRecord(response)) {
            if (typeof response.message_id === 'number') {
              messageId = response.message_id
            }
            if (typeof response.parent_id === 'number') {
              parentId = response.parent_id
            }
            const fragmentsValue = response.fragments
            if (Array.isArray(fragmentsValue)) {
              appendFragments(fragmentsValue)
            }
          }
          continue
        }

        if (parsed.p || parsed.o) {
          applyPatch(parsed)
          continue
        }

        if (typeof parsed.v === 'string') {
          appendTextToLastFragment(parsed.v)
        }
      }
    }

    const text = fragments
      .filter(
        (fragment) => fragment.type === null || fragment.type === 'RESPONSE'
      )
      .map((fragment) => fragment.content)
      .join('')
      .trim()
    if (!text) {
      return null
    }

    return {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      text,
      isFinished,
    }
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${DEEPSEEK_CHAT_URL}/a/chat/s/${this.conversationId}`
        : DEEPSEEK_CHAT_URL
    ).toString()
  }
}
