import type { Request, Response } from 'playwright'
import { StringDecoder } from 'node:string_decoder'
import {
  ProviderAdapter,
  type AbortOptions,
  type CapturedFetchEntry,
  awaitWithTimeout,
  buildResponseOwnershipErrorMessage,
  buildResponseCompletionErrorMessage,
  buildSubmitOutcomeUnknownMessage,
  buildSubmitBlockedWarningMessage,
  createDeferred,
  delayAsync,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from './adapter-base.ts'
import {
  abortable,
  isAbortError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { waitAsync } from '../../shared/wait.ts'
import {
  emptyHistoryResult,
  parseQwenHistory,
} from '../conversation-history.ts'
import {
  parseQwenResponse,
  type QwenParsedResponse,
  type QwenStreamError,
} from '../qwen-response-parser.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import {
  QwenUi,
  type QwenActionCapability,
  type QwenActionCapabilityInfo,
  type QwenActionCapabilityState,
} from '../ui/qwen/qwen-ui.ts'

const QWEN_CHAT_URL = 'https://chat.qwen.ai'
const QWEN_AUTH_PATH = '/api/v2/users/status'
const QWEN_COMPLETION_PATH = '/api/v2/chat/completions'
const QWEN_CDP_SETUP_TIMEOUT_MS = 5_000
const QWEN_REQUEST_OWNERSHIP_SETTLE_MS = 100

interface QwenOwnedRequest {
  request: Request | null
  chatId: string | null
  userMessageId: string | null
  capturedEntryId: number | null
  cdpRequestId: string | null
}

type QwenResponse = Pick<Response, 'status' | 'text'>

interface QwenRequestIdentity {
  chatId: string | null
  userMessageId: string | null
}

interface QwenCdpCandidate {
  requestId: string
  identity: QwenRequestIdentity | null
}

interface QwenCdpResponseSnapshot {
  requestId: string
  body: string
}

interface QwenCdpStreamCapture {
  markDispatchStarted(startedAt: number): void
  getCandidates(): QwenCdpCandidate[]
  setOwnedRequestIdentity(
    identity: QwenRequestIdentity,
    requestId?: string | null
  ): void
  readResponseBodies(): QwenCdpResponseSnapshot[]
  isAmbiguous(): boolean
  stop(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function readUniqueStringAlias(
  value: Record<string, unknown>,
  keys: readonly string[]
): { valid: boolean; value: string | null } {
  const aliases = new Set<string>()
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      aliases.add(candidate)
    }
  }
  if (aliases.size > 1) return { valid: false, value: null }
  return { valid: true, value: aliases.values().next().value ?? null }
}

function qwenIdentityKey(identity: QwenRequestIdentity | null): string | null {
  return identity !== null &&
    identity.chatId !== null &&
    identity.userMessageId !== null
    ? `${identity.chatId}\u0000${identity.userMessageId}`
    : null
}

function readQwenConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.origin !== QWEN_CHAT_URL) return undefined
    const match = url.pathname.match(/^\/c\/([^/?#]+)\/?$/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

function isQwenApiUrl(value: string, pathname: string): boolean {
  try {
    const url = new URL(value, QWEN_CHAT_URL)
    return url.origin === QWEN_CHAT_URL && url.pathname === pathname
  } catch {
    return false
  }
}

function readQwenRequestStartTime(request: Request): number | undefined {
  const candidate = request as Request & {
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

function parseQwenJsonCandidates(raw: string): unknown[] {
  const candidates: unknown[] = []
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: raw, depth: 0 },
  ]
  const seenStrings = new Set<string>()
  const seenObjects = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > 8) continue
    const value = current.value
    if (typeof value === 'string') {
      if (value === '' || seenStrings.has(value)) continue
      seenStrings.add(value)
      try {
        queue.push({
          value: JSON.parse(value) as unknown,
          depth: current.depth + 1,
        })
      } catch {
        // Request bodies may contain encoded JSON rather than raw JSON.
      }
      try {
        const decoded = decodeURIComponent(value.replace(/\+/g, ' '))
        if (decoded !== value) {
          queue.push({ value: decoded, depth: current.depth + 1 })
        }
      } catch {
        // Invalid percent escapes are ordinary opaque request data.
      }
      try {
        for (const formValue of new URLSearchParams(value).values()) {
          if (formValue !== value) {
            queue.push({ value: formValue, depth: current.depth + 1 })
          }
        }
      } catch {
        // Non-form bodies do not need another decoding path.
      }
      continue
    }
    if (isUnknownArray(value)) {
      for (const child of value) {
        queue.push({ value: child, depth: current.depth + 1 })
      }
      continue
    }
    if (!isRecord(value) || seenObjects.has(value)) continue
    seenObjects.add(value)
    if (value.stream === true && isUnknownArray(value.messages)) {
      candidates.push(value)
    }
    for (const child of Object.values(value)) {
      queue.push({ value: child, depth: current.depth + 1 })
    }
  }
  return candidates
}

function readQwenRequestIdentity(
  raw: string | null | undefined,
  expectedChatId: string | null
): QwenRequestIdentity | null | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const identities: QwenRequestIdentity[] = []
  for (const payload of parseQwenJsonCandidates(raw)) {
    if (!isRecord(payload) || !isUnknownArray(payload.messages)) continue
    const chatAlias = readUniqueStringAlias(payload, ['chat_id', 'chatId'])
    if (!chatAlias.valid) return undefined
    if (
      chatAlias.value !== null &&
      expectedChatId !== null &&
      chatAlias.value !== expectedChatId
    ) {
      return undefined
    }

    const lastValue: unknown = payload.messages.at(-1)
    if (!isRecord(lastValue)) return undefined
    const author = isRecord(lastValue.author) ? lastValue.author : null
    const roleAlias = readUniqueStringAlias(lastValue, ['role'])
    const authorRoleAlias =
      author === null
        ? { valid: true, value: null }
        : readUniqueStringAlias(author, ['role'])
    if (
      !roleAlias.valid ||
      !authorRoleAlias.valid ||
      (roleAlias.value !== null &&
        authorRoleAlias.value !== null &&
        roleAlias.value !== authorRoleAlias.value)
    ) {
      return undefined
    }
    if ((roleAlias.value ?? authorRoleAlias.value) !== 'user') return undefined
    const messageAlias = readUniqueStringAlias(lastValue, [
      'id',
      'message_id',
      'messageId',
    ])
    if (!messageAlias.valid) return undefined
    identities.push({
      chatId: chatAlias.value,
      userMessageId: messageAlias.value,
    })
  }
  if (identities.length === 0) return null
  const first = identities[0]!
  if (
    identities.some(
      (identity) =>
        identity.chatId !== first.chatId ||
        identity.userMessageId !== first.userMessageId
    )
  ) {
    return undefined
  }
  return first
}

function isQwenHistoryUrl(value: string, conversationId: string): boolean {
  try {
    const url = new URL(value, QWEN_CHAT_URL)
    const parts = url.pathname.split('/').filter(Boolean)
    return (
      url.origin === QWEN_CHAT_URL &&
      parts.length === 4 &&
      parts[0] === 'api' &&
      parts[1] === 'v2' &&
      parts[2] === 'chats' &&
      decodeURIComponent(parts[3]!) === conversationId
    )
  } catch {
    return false
  }
}

export class QwenAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'qwen' as const
  }

  private conversationIdVal!: string | null
  private pendingText = ''
  private get providerUi(): QwenUi {
    return new QwenUi(this.page)
  }

  protected override async init(options: AbortOptions = {}) {
    await super.init(options)
    this.conversationIdVal =
      readQwenConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore(options)
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    try {
      await this.wrapAdapterActionErrorAsync('restore', async () => {
        await abortable(
          this.page.goto(this.conversationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.getRestoreTimeoutMs(),
          }),
          signal
        )
        await waitAsync(
          async () => {
            try {
              return new URL(this.page.url()).origin === QWEN_CHAT_URL
            } catch {
              return false
            }
          },
          { timeoutMs: this.getRestoreTimeoutMs(), signal }
        )
      })

      if (!(await this.isLoggedIn({ signal }))) {
        throw new ProviderAdapterError(
          'restore',
          'Qwen is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'qwen_signed_out',
          }
        )
      }
      await this.providerUi.waitForComposer(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'Qwen restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'qwen_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    throwIfAborted(options.signal)
    const conversationId = this.conversationIdVal
    if (conversationId === null) {
      return emptyHistoryResult(
        'Qwen history cannot be loaded before a conversation is created.'
      )
    }

    const entries = await this.getCapturedHistoryEntries(
      (entry) =>
        entry.method === 'GET' && isQwenHistoryUrl(entry.url, conversationId),
      options
    )
    const entry =
      entries.find(
        (candidate) =>
          candidate.status !== null &&
          candidate.status >= 200 &&
          candidate.status < 300 &&
          candidate.chunks.join('').trim().length > 0
      ) ?? null
    if (entry !== null) return parseQwenHistory(entry.chunks.join(''))

    return await this.loadHistoryDirect(conversationId, options)
  }

  private async loadHistoryDirect(
    conversationId: string,
    options: AbortOptions
  ) {
    const timeoutSignal = AbortSignal.timeout(this.getHistoryLoadTimeoutMs())
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal])
    const pathname = `/api/v2/chats/${encodeURIComponent(conversationId)}`
    try {
      const result: unknown = await abortable(
        this.page.evaluate(async (historyPath) => {
          const response = await fetch(historyPath, { credentials: 'include' })
          return {
            status: response.status,
            body: await response.text(),
          }
        }, pathname),
        signal
      )
      if (
        !isRecord(result) ||
        typeof result.status !== 'number' ||
        typeof result.body !== 'string'
      ) {
        return emptyHistoryResult(
          'Qwen direct history response had an unexpected shape.'
        )
      }
      if (result.status < 200 || result.status >= 300) {
        return emptyHistoryResult(
          `Qwen history response returned HTTP ${result.status}.`
        )
      }
      if (!result.body.trim()) {
        return emptyHistoryResult('Qwen history response body was empty.')
      }
      return parseQwenHistory(result.body)
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (timeoutSignal.aborted) {
        return emptyHistoryResult('Qwen history request timed out.')
      }
      if (isAbortError(error)) throw error
      return emptyHistoryResult('Qwen history request failed.')
    }
  }

  public async isLoggedIn(options: AbortOptions = {}): Promise<boolean> {
    try {
      if (new URL(this.page.url()).origin !== QWEN_CHAT_URL) return false
    } catch {
      return false
    }

    let result: unknown
    try {
      result = await abortable(
        this.page.evaluate(async (authPath) => {
          const response = await fetch(authPath, { credentials: 'include' })
          let payload: unknown = null
          try {
            payload = await response.json()
          } catch {
            // The caller classifies a non-JSON success response as a protocol error.
          }
          return {
            status: response.status,
            data:
              payload !== null &&
              typeof payload === 'object' &&
              'data' in payload
                ? payload.data
                : null,
          }
        }, QWEN_AUTH_PATH),
        options.signal
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new ProviderAdapterError(
        'isLoggedIn',
        'Qwen login status request failed.',
        {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
          detailCode: 'qwen_auth_request_failed',
          cause: error,
        }
      )
    }

    if (!isRecord(result) || typeof result.status !== 'number') {
      throw new ProviderAdapterError(
        'isLoggedIn',
        'Qwen login status response had an unexpected shape.',
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_auth_response_invalid',
        }
      )
    }
    if (result.status !== 200) {
      throw new ProviderAdapterError(
        'isLoggedIn',
        `Qwen login status request returned HTTP ${result.status}.`,
        {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
          detailCode: 'qwen_auth_http_error',
        }
      )
    }
    if (typeof result.data !== 'boolean') {
      throw new ProviderAdapterError(
        'isLoggedIn',
        'Qwen login status response did not contain a boolean state.',
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_auth_state_invalid',
        }
      )
    }
    return result.data
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.providerUi.selectModel(model)
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.providerUi.attachText(text)
      this.pendingText += text
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const getLocators = () => this.providerUi.getRetryLocators()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Qwen',
      isComposerReady: async () =>
        await this.isRetryComposerReady(getLocators().composer),
      readComposerText: async () =>
        await this.readRetryComposerText(getLocators().composer),
      writeText: async () => {
        this.pendingText = ''
        await this.attachText(text)
      },
      clearComposer: async () => {
        await this.clearRetryComposerElements(getLocators().composer)
        this.pendingText = ''
      },
      isStopActive: async () =>
        await this.isRetryControlActive(getLocators().stop),
      isSendReady: async () =>
        await this.isRetryControlReady(getLocators().send),
    })
  }

  public async attachFile(
    path: string | readonly string[],
    waitForTextParsing = true
  ): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.providerUi.attachFile(path, waitForTextParsing)
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path, false)
  }

  public async listActionCapabilities(): Promise<QwenActionCapabilityInfo[]> {
    return await this.wrapAdapterActionErrorAsync(
      'listCapabilities',
      async () => await this.providerUi.listActionCapabilities()
    )
  }

  public async clearActionCapability(): Promise<void> {
    await this.wrapAdapterActionErrorAsync(
      'clearCapability',
      async () => await this.providerUi.clearActionCapability()
    )
  }

  public async selectActionCapability(
    capability: QwenActionCapability
  ): Promise<QwenActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => await this.providerUi.selectActionCapability(capability)
    )
  }

  public override async stopGeneration(): Promise<void> {
    await this.providerUi.stopGeneration()
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('Qwen')
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    let requestSubmitted = false
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.ensureSubmitAuth(signal)
        const pendingText = this.pendingText
        if (!pendingText) {
          throw new ProviderAdapterError(
            'submit',
            'Qwen has no Portal-owned text to submit.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'qwen_submit_text_missing',
            }
          )
        }

        await this.providerUi.assertComposerText('submit', pendingText)
        await this.providerUi.waitForSendReady(
          this.getSubmitResponseTimeoutMs(),
          signal
        )
        await this.ensureSubmitAuth(signal)
        const captureStartIndex = await this.getCapturedFetchEntryCount()
        const cdpStreamCapture = await this.createCdpSubmitStreamCapture(signal)
        const targetResponse = createDeferred<QwenResponse>()
        let ownedRequest: QwenOwnedRequest | null = null
        let requestObserved = false
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let stopTextPolling: (() => void) | null = null
        let settled = false
        let dispatchStarted = false
        let dispatchStartedAt: number | null = null
        let ownershipSettled = false
        let ownershipTimer: NodeJS.Timeout | null = null
        let ownedIdentityKey: string | null = null
        let ambiguousRequest = false
        let ownershipGeneration = 0
        const ownershipController = new AbortController()
        const ownershipSignal =
          signal === undefined
            ? ownershipController.signal
            : AbortSignal.any([signal, ownershipController.signal])
        let ownedFailureTimer: NodeJS.Timeout | null = null
        const preDispatchRequests = new Set<Request>()
        const seenRequestEvents = new Set<Request>()
        const liveCandidates = new Map<Request, QwenRequestIdentity | null>()
        const ownedLiveRequests = new Set<Request>()
        const capturedCandidates = new Map<
          number,
          { entry: CapturedFetchEntry; identity: QwenRequestIdentity | null }
        >()
        const cdpCandidates = new Map<string, QwenCdpCandidate>()
        const pendingResponses = new Map<Request, Response>()
        const pendingFailures = new Map<Request, string>()
        const ownedTerminalFailures = new Map<Request, unknown>()

        const stopWarningTimer = () => {
          if (warningTimer !== null) {
            clearInterval(warningTimer)
            warningTimer = null
          }
        }
        const resolveRequestStarted = () => {
          if (requestObserved) return
          requestObserved = true
          this.pendingText = ''
          stopWarningTimer()
        }
        const settleTargetResponse = (
          resolution:
            | { kind: 'resolve'; response: QwenResponse }
            | { kind: 'reject'; error: unknown }
        ) => {
          if (settled) return
          settled = true
          stopWarningTimer()
          if (resolution.kind === 'resolve') {
            targetResponse.resolve(resolution.response)
          } else {
            terminalError = resolution.error
            targetResponse.reject(resolution.error)
          }
        }

        const clearOwnershipTimer = () => {
          if (ownershipTimer !== null) {
            clearTimeout(ownershipTimer)
            ownershipTimer = null
          }
        }

        const clearOwnedFailureTimer = () => {
          if (ownedFailureTimer !== null) {
            clearTimeout(ownedFailureTimer)
            ownedFailureTimer = null
          }
        }

        const createOwnershipError = () =>
          new ProviderAdapterError(
            'submit',
            buildResponseOwnershipErrorMessage('Qwen'),
            {
              kind: 'unknown',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'qwen_response_ownership_ambiguous',
            }
          )

        const markAmbiguous = () => {
          if (ambiguousRequest) return
          ambiguousRequest = true
          ownershipGeneration += 1
          stopTextPolling?.()
          ownershipController.abort(createOwnershipError())
          if (ownedRequest !== null) {
            settleTargetResponse({
              kind: 'reject',
              error: createOwnershipError(),
            })
          }
        }

        const isOwnershipCurrent = (
          generation: number,
          expectedOwnedRequest: QwenOwnedRequest
        ) =>
          ownershipSettled &&
          !ambiguousRequest &&
          ownershipGeneration === generation &&
          ownedRequest === expectedOwnedRequest

        const assertOwnershipCurrent = (
          generation: number,
          expectedOwnedRequest: QwenOwnedRequest
        ) => {
          if (!isOwnershipCurrent(generation, expectedOwnedRequest)) {
            throw createOwnershipError()
          }
        }

        const throwIfOwnershipAborted = () => {
          throwIfAborted(signal)
          if (ambiguousRequest) throw createOwnershipError()
          throwIfAborted(ownershipController.signal)
        }

        const capturedResponse = (
          entry: CapturedFetchEntry,
          body: string
        ): QwenResponse => ({
          status: () => entry.status ?? 200,
          text: async () => body,
        })

        const haveAllOwnedLiveAttemptsFailed = () => {
          if (ownedLiveRequests.size === 0) return false
          for (const request of ownedLiveRequests) {
            if (!ownedTerminalFailures.has(request)) return false
          }
          return true
        }

        const scheduleOwnedFailureCheck = () => {
          if (
            settled ||
            ambiguousRequest ||
            !haveAllOwnedLiveAttemptsFailed()
          ) {
            return
          }
          clearOwnedFailureTimer()
          // Give retries on every observed transport the same configurable
          // liveness window as an owned response.
          ownedFailureTimer = setTimeout(() => {
            ownedFailureTimer = null
            if (
              settled ||
              ambiguousRequest ||
              !haveAllOwnedLiveAttemptsFailed()
            ) {
              return
            }
            const error = ownedTerminalFailures.values().next().value
            settleTargetResponse({
              kind: 'reject',
              error:
                error instanceof Error
                  ? error
                  : new Error('Every Qwen request attempt failed.'),
            })
          }, this.getSubmitResponseStallTimeoutMs())
        }

        const reportOwnedAttemptActivity = () => {
          if (settled || ambiguousRequest) return
          clearOwnedFailureTimer()
          this.emitSubmitActivitySafely()
          scheduleOwnedFailureCheck()
        }

        const processOwnedResponse = (response: Response) => {
          const request = response.request()
          if (settled || ambiguousRequest || !ownedLiveRequests.has(request)) {
            return
          }
          reportOwnedAttemptActivity()
          if (response.status() < 200 || response.status() >= 300) {
            ownedTerminalFailures.set(
              request,
              this.createHttpError(response.status())
            )
            scheduleOwnedFailureCheck()
            return
          }
          const expectedGeneration = ownershipGeneration
          const expectedOwnedRequest = ownedRequest
          if (expectedOwnedRequest === null) return
          void abortable(response.text(), ownershipSignal)
            .then((rawResponse) => {
              if (
                !isOwnershipCurrent(expectedGeneration, expectedOwnedRequest) ||
                !ownedLiveRequests.has(request)
              ) {
                return
              }
              const parsed = parseQwenResponse(rawResponse)
              try {
                this.validateFinalResponse(parsed, expectedOwnedRequest)
              } catch (error) {
                ownedTerminalFailures.set(request, error)
                scheduleOwnedFailureCheck()
                return
              }
              ownedTerminalFailures.delete(request)
              clearOwnedFailureTimer()
              settleTargetResponse({
                kind: 'resolve',
                response: {
                  status: () => response.status(),
                  text: async () => rawResponse,
                },
              })
            })
            .catch((error: unknown) => {
              if (
                settled ||
                ambiguousRequest ||
                ownershipController.signal.aborted ||
                signal?.aborted === true
              ) {
                return
              }
              ownedTerminalFailures.set(request, error)
              scheduleOwnedFailureCheck()
            })
        }

        const processOwnedFailure = (request: Request, failureText: string) => {
          if (settled || ambiguousRequest || !ownedLiveRequests.has(request)) {
            return
          }
          ownedTerminalFailures.set(
            request,
            new ProviderAdapterError(
              'submit',
              buildSubmitOutcomeUnknownMessage('Qwen'),
              {
                kind: 'unknown',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'qwen_submit_outcome_unknown',
                cause: failureText,
              }
            )
          )
          scheduleOwnedFailureCheck()
        }

        const resolvePendingResponse = (request: Request) => {
          const response = pendingResponses.get(request)
          if (response === undefined) return
          pendingResponses.delete(request)
          processOwnedResponse(response)
        }

        const resolvePendingFailure = (request: Request) => {
          const failureText = pendingFailures.get(request)
          if (failureText === undefined) return
          pendingFailures.delete(request)
          processOwnedFailure(request, failureText)
        }

        const finalizeOwnership = () => {
          if (ownershipSettled) return
          clearOwnershipTimer()

          const live = [...liveCandidates.entries()]
          const captured = [...capturedCandidates.values()]
          const cdp = [...cdpCandidates.values()]
          const identified = [
            ...live
              .filter(
                ([, identity]) =>
                  identity !== null &&
                  identity.chatId !== null &&
                  identity.userMessageId !== null
              )
              .map(([request, identity]) => ({
                kind: 'live' as const,
                request,
                identity: identity!,
              })),
            ...captured
              .filter(
                (candidate) =>
                  candidate.identity !== null &&
                  candidate.identity.chatId !== null &&
                  candidate.identity.userMessageId !== null
              )
              .map((candidate) => ({
                kind: 'captured' as const,
                candidate,
                identity: candidate.identity!,
              })),
            ...cdp
              .filter(
                (candidate) =>
                  candidate.identity !== null &&
                  candidate.identity.chatId !== null &&
                  candidate.identity.userMessageId !== null
              )
              .map((candidate) => ({
                kind: 'cdp' as const,
                candidate,
                identity: candidate.identity!,
              })),
          ]
          const ids = new Set(
            identified
              .map((candidate) => qwenIdentityKey(candidate.identity))
              .filter((key): key is string => key !== null)
          )

          let selectedLive: Request | null = null
          let selectedCaptured: CapturedFetchEntry | null = null
          let selectedCdpRequestId: string | null = null
          let selectedIdentity: QwenRequestIdentity | null = null

          if (ids.size > 1) {
            ownershipSettled = true
            markAmbiguous()
            return
          }
          if (ids.size === 1) {
            const key = [...ids][0]!
            const liveMatch = live.find(
              ([, identity]) => qwenIdentityKey(identity) === key
            )
            const capturedMatch = captured.find(
              (candidate) => qwenIdentityKey(candidate.identity) === key
            )
            const cdpMatch = cdp.find(
              (candidate) => qwenIdentityKey(candidate.identity) === key
            )
            if (liveMatch !== undefined) {
              selectedLive = liveMatch[0]
              selectedIdentity = liveMatch[1]
            } else if (capturedMatch !== undefined) {
              selectedCaptured = capturedMatch.entry
              selectedIdentity = capturedMatch.identity
            } else if (cdpMatch !== undefined) {
              selectedCdpRequestId = cdpMatch.requestId
              selectedIdentity = cdpMatch.identity
            }
          } else if (
            live.length === 1 &&
            captured.length === 0 &&
            cdp.length === 0
          ) {
            selectedLive = live[0]![0]
            selectedIdentity = live[0]![1]
          } else if (live.length === 0 && captured.length + cdp.length === 1) {
            if (captured.length === 1) {
              selectedCaptured = captured[0]!.entry
              selectedIdentity = captured[0]!.identity
            } else {
              selectedCdpRequestId = cdp[0]!.requestId
              selectedIdentity = cdp[0]!.identity
            }
          } else {
            if (live.length + captured.length + cdp.length > 1) {
              ownershipSettled = true
              markAmbiguous()
            }
            return
          }

          if (
            selectedLive === null &&
            selectedCaptured === null &&
            selectedCdpRequestId === null
          ) {
            return
          }
          ownershipSettled = true
          ownershipGeneration += 1
          ownedIdentityKey = qwenIdentityKey(selectedIdentity)
          ownedRequest = {
            request: selectedLive,
            chatId: selectedIdentity?.chatId ?? this.conversationIdVal,
            userMessageId: selectedIdentity?.userMessageId ?? null,
            capturedEntryId: selectedCaptured?.id ?? null,
            cdpRequestId: selectedCdpRequestId,
          }
          const selectedOwnedRequest = ownedRequest
          requestSubmitted = true
          resolveRequestStarted()
          if (selectedLive !== null) {
            // Same-ID retries are one logical request and may each produce the
            // usable HTTP response.
            for (const [request, identity] of live) {
              if (
                (ownedIdentityKey !== null &&
                  qwenIdentityKey(identity) === ownedIdentityKey) ||
                (ownedIdentityKey === null && request === selectedLive)
              ) {
                ownedLiveRequests.add(request)
                resolvePendingResponse(request)
                resolvePendingFailure(request)
              }
            }
          }
          cdpStreamCapture?.setOwnedRequestIdentity(
            {
              chatId: selectedOwnedRequest.chatId,
              userMessageId: selectedOwnedRequest.userMessageId,
            },
            ownedIdentityKey === null ? selectedOwnedRequest.cdpRequestId : null
          )
          const hasOwnedCapturedCandidate = captured.some((candidate) =>
            ownedIdentityKey === null
              ? candidate.entry.id === selectedOwnedRequest.capturedEntryId
              : qwenIdentityKey(candidate.identity) === ownedIdentityKey
          )
          const hasOwnedCdpCandidate = cdp.some((candidate) =>
            ownedIdentityKey === null
              ? candidate.requestId === selectedOwnedRequest.cdpRequestId
              : qwenIdentityKey(candidate.identity) === ownedIdentityKey
          )
          if (hasOwnedCapturedCandidate || hasOwnedCdpCandidate) {
            reportOwnedAttemptActivity()
          }
          if (
            selectedLive === null &&
            selectedCaptured !== null &&
            selectedCaptured.status === 200
          ) {
            const raw = selectedCaptured.chunks.join('')
            const parsed = parseQwenResponse(raw)
            if (
              parsed !== null &&
              this.isOwnedStreamingResponse(
                parsed,
                selectedOwnedRequest,
                true
              ) &&
              parsed.isFinished
            ) {
              settleTargetResponse({
                kind: 'resolve',
                response: capturedResponse(selectedCaptured, raw),
              })
            }
          }
          if (selectedLive !== null) {
            // The Playwright response body remains authoritative for the final
            // response. Captured fetch entries are only a streaming mirror.
            return
          }
        }

        const scheduleOwnershipSettlement = () => {
          if (ownershipTimer !== null || ownershipSettled) return
          ownershipTimer = setTimeout(
            finalizeOwnership,
            QWEN_REQUEST_OWNERSHIP_SETTLE_MS
          )
        }

        const handleLateCandidateIdentity = (
          identity: QwenRequestIdentity | null
        ): 'owned' | 'ignored' | 'ambiguous' => {
          const candidateKey = qwenIdentityKey(identity)
          if (ownedIdentityKey !== null) {
            if (candidateKey === ownedIdentityKey) return 'owned'
            if (candidateKey === null) return 'ignored'
            markAmbiguous()
            return 'ambiguous'
          }
          markAmbiguous()
          return 'ambiguous'
        }

        const scanCdpCandidates = () => {
          for (const candidate of cdpStreamCapture?.getCandidates() ?? []) {
            if (cdpCandidates.has(candidate.requestId)) continue
            if (
              candidate.identity !== null &&
              candidate.identity.chatId !== null &&
              this.conversationIdVal !== null &&
              candidate.identity.chatId !== this.conversationIdVal
            ) {
              continue
            }
            cdpCandidates.set(candidate.requestId, candidate)
            requestSubmitted = true
            resolveRequestStarted()
            if (ownershipSettled) {
              const ownership = handleLateCandidateIdentity(candidate.identity)
              if (ownership === 'owned') reportOwnedAttemptActivity()
            } else {
              scheduleOwnershipSettlement()
            }
          }
        }

        const scanCapturedCandidates = async () => {
          if (!dispatchStarted) return
          let entries: CapturedFetchEntry[]
          try {
            entries = await abortable(
              this.getCapturedFetchEntries(captureStartIndex),
              ownershipSignal
            )
          } catch (error) {
            if (signal?.aborted === true) throw error
            if (ambiguousRequest) throw createOwnershipError()
            if (isAbortError(error)) throw error
            return
          }
          throwIfOwnershipAborted()
          for (const entry of entries) {
            throwIfOwnershipAborted()
            if (
              !this.isTargetCapturedCompletionEntry(entry) ||
              entry.startedAt === undefined ||
              (dispatchStartedAt !== null &&
                entry.startedAt < dispatchStartedAt)
            ) {
              continue
            }
            const requestBody = entry.requestBody ?? null
            const identity = readQwenRequestIdentity(
              requestBody,
              this.conversationIdVal
            )
            if (identity === undefined) continue
            const previous = capturedCandidates.get(entry.id)
            capturedCandidates.set(entry.id, { entry, identity })
            if (previous !== undefined) continue
            requestSubmitted = true
            resolveRequestStarted()
            if (ownershipSettled) {
              const ownership = handleLateCandidateIdentity(identity)
              if (ownership === 'owned') reportOwnedAttemptActivity()
            } else {
              scheduleOwnershipSettlement()
            }
          }
        }

        const recordLiveCandidate = (
          request: Request,
          source: 'request' | 'response' | 'failure'
        ): boolean => {
          if (!this.isTargetCompletionRequest(request)) return false
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return false
          }
          if (preDispatchRequests.has(request)) return false
          const requestStartedAt = readQwenRequestStartTime(request)
          if (
            dispatchStartedAt !== null &&
            requestStartedAt !== undefined &&
            requestStartedAt < dispatchStartedAt
          ) {
            preDispatchRequests.add(request)
            return false
          }
          if (
            source !== 'request' &&
            !seenRequestEvents.has(request) &&
            requestStartedAt === undefined
          ) {
            preDispatchRequests.add(request)
            return false
          }
          let body: string | null
          try {
            body = request.postData()
          } catch {
            body = null
          }
          const identity = readQwenRequestIdentity(body, this.conversationIdVal)
          if (identity === undefined) return false
          if (liveCandidates.has(request)) return true
          liveCandidates.set(request, identity)
          requestSubmitted = true
          resolveRequestStarted()
          if (ownershipSettled) {
            const ownership = handleLateCandidateIdentity(identity)
            if (ownership === 'owned') {
              ownedLiveRequests.add(request)
              ownedTerminalFailures.delete(request)
              reportOwnedAttemptActivity()
              resolvePendingResponse(request)
              resolvePendingFailure(request)
            }
          } else {
            this.emitSubmitActivitySafely()
            scheduleOwnershipSettlement()
          }
          return true
        }

        const onRequest = (request: Request) => {
          if (!this.isTargetCompletionRequest(request)) return
          seenRequestEvents.add(request)
          recordLiveCandidate(request, 'request')
        }

        const onRequestFailed = (request: Request) => {
          if (!this.isTargetCompletionRequest(request)) return
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordLiveCandidate(request, 'failure')) return
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          if (!ownershipSettled) {
            pendingFailures.set(request, failureText)
          } else if (ownedLiveRequests.has(request)) {
            processOwnedFailure(request, failureText)
          }
        }

        const onResponse = (response: Response) => {
          const request = response.request()
          if (!this.isTargetCompletionRequest(request)) return
          if (!dispatchStarted) {
            preDispatchRequests.add(request)
            return
          }
          if (!recordLiveCandidate(request, 'response')) return
          if (!ownershipSettled) {
            pendingResponses.set(request, response)
          } else if (ownedLiveRequests.has(request)) {
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

        try {
          this.emitSubmitDispatching(signal)
          dispatchStartedAt = Date.now()
          dispatchStarted = true
          cdpStreamCapture?.markDispatchStarted(dispatchStartedAt)
          await this.providerUi.clickSend()
          this.emitSubmitSent()
          throwIfAborted(signal)

          const ownershipDeadline =
            Date.now() +
            Math.max(
              this.getSubmitRequestStartGraceMs(),
              QWEN_REQUEST_OWNERSHIP_SETTLE_MS
            )
          while (
            !ownershipSettled &&
            terminalError === null &&
            Date.now() < ownershipDeadline
          ) {
            scanCdpCandidates()
            await scanCapturedCandidates()
            await delayAsync(10, signal)
          }

          // The 100ms window can close just after the final polling tick.
          // Settle synchronously before treating ownership as missing.
          scanCdpCandidates()
          await scanCapturedCandidates()
          finalizeOwnership()

          if (!ownershipSettled && !requestObserved && terminalError === null) {
            await this.ensureSubmitAuth(signal)
            const warningMessage = this.getSubmitBlockedWarningMessage()
            await this.emitSubmitStatus(warningMessage)
            warningTimer = setInterval(() => {
              void this.emitSubmitStatusSafely(warningMessage)
            }, this.getSubmitBlockedWarningIntervalMs())
            while (!ownershipSettled && terminalError === null) {
              scanCdpCandidates()
              await scanCapturedCandidates()
              await abortable(delayAsync(1000, signal), signal)
              if (!ownershipSettled && terminalError === null) {
                await this.ensureSubmitAuth(signal)
              }
            }
          }

          throwIfOwnershipAborted()
          const submittedRequest = this.requireOwnedRequest(ownedRequest)
          cdpStreamCapture?.setOwnedRequestIdentity(
            {
              chatId: submittedRequest.chatId,
              userMessageId: submittedRequest.userMessageId,
            },
            ownedIdentityKey === null ? submittedRequest.cdpRequestId : null
          )
          const expectedGeneration = ownershipGeneration
          const lastCdpResponseLengths = new Map<string, number>()
          const lastCapturedResponseSnapshots = new Map<number, string>()
          stopTextPolling = this.startSubmitTextPolling(async () => {
            scanCdpCandidates()
            await scanCapturedCandidates()
            if (!isOwnershipCurrent(expectedGeneration, submittedRequest)) {
              return null
            }
            const canUseCdp =
              ownedIdentityKey !== null ||
              submittedRequest.cdpRequestId !== null
            if (cdpStreamCapture?.isAmbiguous() === true) {
              markAmbiguous()
              return null
            }
            const cdpSnapshots = canUseCdp
              ? (cdpStreamCapture?.readResponseBodies() ?? [])
              : []
            for (const snapshot of cdpSnapshots) {
              if (
                lastCdpResponseLengths.get(snapshot.requestId) ===
                snapshot.body.length
              ) {
                continue
              }
              lastCdpResponseLengths.set(
                snapshot.requestId,
                snapshot.body.length
              )
              reportOwnedAttemptActivity()
            }
            const parsedCdpSnapshots = cdpSnapshots
              .map((snapshot) => ({
                ...snapshot,
                parsed: parseQwenResponse(snapshot.body),
              }))
              .filter((snapshot) =>
                this.isOwnedStreamingResponse(
                  snapshot.parsed,
                  submittedRequest,
                  true
                )
              )
            if (parsedCdpSnapshots.length > 0) {
              const selected = parsedCdpSnapshots.reduce((best, candidate) => {
                if (candidate.parsed!.isFinished !== best.parsed!.isFinished) {
                  return candidate.parsed!.isFinished ? candidate : best
                }
                return candidate.parsed!.text.length >= best.parsed!.text.length
                  ? candidate
                  : best
              })
              if (selected.parsed!.isFinished) {
                assertOwnershipCurrent(expectedGeneration, submittedRequest)
                settleTargetResponse({
                  kind: 'resolve',
                  response: {
                    status: () => 200,
                    text: async () => selected.body,
                  },
                })
              }
              if (!isOwnershipCurrent(expectedGeneration, submittedRequest)) {
                return null
              }
              return selected.parsed!.text || null
            }
            const entries = [...capturedCandidates.values()]
              .filter((candidate) => {
                if (ownedIdentityKey !== null) {
                  return (
                    qwenIdentityKey(candidate.identity) === ownedIdentityKey
                  )
                }
                return (
                  submittedRequest.capturedEntryId === candidate.entry.id &&
                  submittedRequest.request === null &&
                  submittedRequest.cdpRequestId === null
                )
              })
              .map((candidate) => candidate.entry)
            const responseEntries = entries
              .filter(
                (entry) =>
                  (entry.status ?? 200) >= 200 && (entry.status ?? 200) < 300
              )
              .map((entry) => ({
                entry,
                raw: entry.chunks.join(''),
              }))
            for (const candidate of responseEntries) {
              const snapshot = [
                candidate.entry.status ?? '',
                candidate.raw.length,
                candidate.entry.done,
                candidate.entry.error ?? '',
              ].join(':')
              if (
                lastCapturedResponseSnapshots.get(candidate.entry.id) ===
                snapshot
              ) {
                continue
              }
              lastCapturedResponseSnapshots.set(candidate.entry.id, snapshot)
              reportOwnedAttemptActivity()
            }
            const parsedEntries = responseEntries
              .map((candidate) => ({
                ...candidate,
                parsed: parseQwenResponse(candidate.raw),
              }))
              .filter((candidate) =>
                this.isOwnedStreamingResponse(
                  candidate.parsed,
                  submittedRequest,
                  true
                )
              )
            if (parsedEntries.length === 0) return null
            const selected = parsedEntries.reduce((best, candidate) => {
              if (candidate.parsed!.isFinished !== best.parsed!.isFinished) {
                return candidate.parsed!.isFinished ? candidate : best
              }
              return candidate.parsed!.text.length >= best.parsed!.text.length
                ? candidate
                : best
            })
            if (!isOwnershipCurrent(expectedGeneration, submittedRequest)) {
              return null
            }
            if (selected.parsed!.isFinished) {
              assertOwnershipCurrent(expectedGeneration, submittedRequest)
              settleTargetResponse({
                kind: 'resolve',
                response: capturedResponse(selected.entry, selected.raw),
              })
            }
            if (!isOwnershipCurrent(expectedGeneration, submittedRequest)) {
              return null
            }
            return selected.parsed!.text || null
          })
          const response = await awaitWithTimeout(
            targetResponse.promise,
            this.getSubmitResponseTimeoutMs(),
            () =>
              new Error(
                'Timed out waiting for Qwen response after the request started.'
              ),
            { signal }
          )
          scanCdpCandidates()
          await scanCapturedCandidates()
          assertOwnershipCurrent(expectedGeneration, submittedRequest)
          let parsed: QwenParsedResponse | null
          try {
            const rawResponse = await abortable(
              response.text(),
              ownershipSignal
            )
            parsed = parseQwenResponse(rawResponse)
            this.validateFinalResponse(parsed, submittedRequest)
            scanCdpCandidates()
            await scanCapturedCandidates()
            assertOwnershipCurrent(expectedGeneration, submittedRequest)
            await this.providerUi.waitForComposer(
              'submit',
              this.getSubmitResponseTimeoutMs(),
              ownershipSignal
            )
          } catch (error) {
            if (ambiguousRequest) throw createOwnershipError()
            throw error
          }
          scanCdpCandidates()
          await scanCapturedCandidates()
          assertOwnershipCurrent(expectedGeneration, submittedRequest)
          stopTextPolling()
          this.conversationIdVal =
            this.conversationIdVal ??
            parsed.chatId ??
            readQwenConversationIdFromUrl(this.page.url()) ??
            null
          throwIfAborted(signal)
          assertOwnershipCurrent(expectedGeneration, submittedRequest)
          await this.emitSubmitText(parsed.text)
          throwIfAborted(signal)
          scanCdpCandidates()
          await scanCapturedCandidates()
          assertOwnershipCurrent(expectedGeneration, submittedRequest)
          throwIfAborted(signal)
          return parsed.text
        } finally {
          settleTargetResponse({
            kind: 'reject',
            error: new Error('Qwen submit ended before the response settled.'),
          })
          stopTextPolling?.()
          stopWarningTimer()
          clearOwnedFailureTimer()
          ownershipController.abort()
          await cdpStreamCapture?.stop()
          this.page.off('request', onRequest)
          this.page.off('requestfailed', onRequestFailed)
          this.page.off('response', onResponse)
          this.page.off('close', onClose)
          clearOwnershipTimer()
        }
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (requestSubmitted && this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          buildSubmitOutcomeUnknownMessage('Qwen'),
          {
            kind: 'unknown',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'qwen_submit_outcome_unknown',
            cause: error,
          }
        )
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'Qwen submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'qwen_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private isTargetCapturedCompletionEntry(entry: CapturedFetchEntry): boolean {
    return (
      entry.method === 'POST' && isQwenApiUrl(entry.url, QWEN_COMPLETION_PATH)
    )
  }

  private isOwnedStreamingResponse(
    parsed: QwenParsedResponse | null,
    ownedRequest: QwenOwnedRequest,
    allowUnanchored = false
  ): parsed is QwenParsedResponse {
    return (
      parsed !== null &&
      parsed.error === null &&
      parsed.identityConsistent &&
      (ownedRequest.chatId === null || parsed.chatId === ownedRequest.chatId) &&
      (ownedRequest.userMessageId === null
        ? allowUnanchored
        : parsed.parentId === ownedRequest.userMessageId) &&
      parsed.responseId !== null
    )
  }

  private async createCdpSubmitStreamCapture(
    signal?: AbortSignal
  ): Promise<QwenCdpStreamCapture | null> {
    if (typeof this.context.newCDPSession !== 'function') return null
    let session: Awaited<
      ReturnType<NonNullable<typeof this.context.newCDPSession>>
    >
    const sessionPromise = this.context.newCDPSession(this.page)
    try {
      session = await awaitWithTimeout(
        sessionPromise,
        QWEN_CDP_SETUP_TIMEOUT_MS,
        () => new Error('Timed out creating the Qwen CDP stream session.'),
        { signal }
      )
    } catch (error) {
      void sessionPromise.then(
        (lateSession) => lateSession.detach().catch(() => {}),
        () => {}
      )
      if (isAbortError(error)) throw error
      return null
    }

    interface CdpRequestState extends QwenCdpCandidate {
      responseStatus: number | null
      decoder: StringDecoder
      streamState: 'idle' | 'pending' | 'ready' | 'failed'
      pendingData: string[]
      responseBody: string
    }

    const requests = new Map<string, CdpRequestState>()
    const preDispatchRequestIds = new Set<string>()
    let ambiguous = false
    let stopped = false
    let dispatchStarted = false
    let dispatchStartedAt: number | null = null
    let ownedIdentity: QwenRequestIdentity | null = null
    let ownedCdpRequestId: string | null = null

    const appendBase64 = (state: CdpRequestState, value: unknown) => {
      if (stopped || ambiguous || typeof value !== 'string' || !value) return
      state.responseBody += state.decoder.write(Buffer.from(value, 'base64'))
    }
    const isOwnedState = (state: CdpRequestState): boolean => {
      if (preDispatchRequestIds.has(state.requestId)) return false
      if (ownedCdpRequestId !== null) {
        return state.requestId === ownedCdpRequestId
      }
      const ownedKey = qwenIdentityKey(ownedIdentity)
      return ownedKey !== null && qwenIdentityKey(state.identity) === ownedKey
    }
    const startStreaming = (state: CdpRequestState) => {
      if (
        stopped ||
        ambiguous ||
        !isOwnedState(state) ||
        state.responseStatus === null ||
        state.responseStatus < 200 ||
        state.responseStatus >= 300 ||
        state.streamState !== 'idle'
      ) {
        return
      }
      state.streamState = 'pending'
      void session
        .send('Network.streamResourceContent', { requestId: state.requestId })
        .then((result) => {
          if (
            !isRecord(result) ||
            stopped ||
            ambiguous ||
            !isOwnedState(state)
          ) {
            return
          }
          appendBase64(state, result.bufferedData)
          for (const data of state.pendingData) appendBase64(state, data)
          state.pendingData = []
          state.streamState = 'ready'
        })
        .catch(() => {
          state.pendingData = []
          state.streamState = 'failed'
        })
    }
    const bindOwnedRequest = () => {
      if (stopped || ambiguous || ownedIdentity === null) return
      if (ownedCdpRequestId !== null) {
        const candidate = requests.get(ownedCdpRequestId)
        if (
          candidate === undefined ||
          preDispatchRequestIds.has(candidate.requestId) ||
          (candidate.identity !== null &&
            (candidate.identity.chatId !== ownedIdentity.chatId ||
              candidate.identity.userMessageId !== ownedIdentity.userMessageId))
        ) {
          ambiguous = true
          return
        }
        startStreaming(candidate)
        return
      }
      for (const state of requests.values()) {
        startStreaming(state)
      }
    }

    session.on('Network.requestWillBeSent', (event: unknown) => {
      if (stopped || !isRecord(event) || !isRecord(event.request)) return
      const requestId = event.requestId
      const request = event.request
      if (
        typeof requestId !== 'string' ||
        request.method !== 'POST' ||
        typeof request.url !== 'string' ||
        !isQwenApiUrl(request.url, QWEN_COMPLETION_PATH)
      ) {
        return
      }
      const startedBeforeDispatch =
        dispatchStartedAt !== null &&
        typeof event.wallTime === 'number' &&
        event.wallTime * 1_000 < dispatchStartedAt
      if (!dispatchStarted || startedBeforeDispatch) {
        preDispatchRequestIds.add(requestId)
      }
      const requestBody =
        typeof request.postData === 'string' ? request.postData : null
      const identity = readQwenRequestIdentity(requestBody, null)
      if (identity === undefined) return
      requests.set(requestId, {
        requestId,
        identity,
        responseStatus: null,
        decoder: new StringDecoder('utf8'),
        streamState: 'idle',
        pendingData: [],
        responseBody: '',
      })
      bindOwnedRequest()
    })
    session.on('Network.responseReceived', (event: unknown) => {
      if (stopped || !isRecord(event) || typeof event.requestId !== 'string') {
        return
      }
      const state = requests.get(event.requestId)
      if (state === undefined) return
      state.responseStatus =
        isRecord(event.response) && typeof event.response.status === 'number'
          ? event.response.status
          : 200
      bindOwnedRequest()
      startStreaming(state)
    })
    session.on('Network.dataReceived', (event: unknown) => {
      if (
        stopped ||
        ambiguous ||
        !isRecord(event) ||
        typeof event.requestId !== 'string'
      ) {
        return
      }
      const state = requests.get(event.requestId)
      if (state === undefined || !isOwnedState(state)) return
      if (typeof event.data !== 'string' || !event.data) return
      if (state.streamState === 'pending') {
        state.pendingData.push(event.data)
      } else if (state.streamState === 'ready') {
        appendBase64(state, event.data)
      }
    })

    try {
      await awaitWithTimeout(
        session.send('Network.enable'),
        QWEN_CDP_SETUP_TIMEOUT_MS,
        () => new Error('Timed out enabling the Qwen CDP network stream.'),
        { signal }
      )
    } catch (error) {
      await session.detach().catch(() => {})
      if (isAbortError(error)) throw error
      return null
    }

    return {
      markDispatchStarted: (startedAt) => {
        dispatchStarted = true
        dispatchStartedAt = startedAt
      },
      getCandidates: () =>
        [...requests.values()].filter(
          (candidate) => !preDispatchRequestIds.has(candidate.requestId)
        ),
      setOwnedRequestIdentity: (identity, requestId = null) => {
        if (stopped || ambiguous) return
        ownedIdentity = identity
        ownedCdpRequestId = requestId
        bindOwnedRequest()
      },
      readResponseBodies: () =>
        [...requests.values()]
          .filter((state) => isOwnedState(state) && state.responseBody !== '')
          .map((state) => ({
            requestId: state.requestId,
            body: state.responseBody,
          })),
      isAmbiguous: () => ambiguous,
      stop: async () => {
        if (stopped) return
        stopped = true
        for (const state of requests.values()) {
          state.pendingData = []
          state.decoder.end()
        }
        await session.detach().catch(() => {})
      },
    }
  }

  private isTargetCompletionRequest(request: Request): boolean {
    return (
      request.method() === 'POST' &&
      isQwenApiUrl(request.url(), QWEN_COMPLETION_PATH)
    )
  }

  private requireOwnedRequest(
    ownedRequest: QwenOwnedRequest | null
  ): QwenOwnedRequest {
    if (ownedRequest !== null) return ownedRequest
    throw new ProviderAdapterError(
      'submit',
      'Qwen did not start the Portal-owned completion request.',
      {
        kind: 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'qwen_owned_request_missing',
      }
    )
  }

  private validateFinalResponse(
    parsed: QwenParsedResponse | null,
    ownedRequest: QwenOwnedRequest
  ): asserts parsed is QwenParsedResponse {
    if (parsed === null) {
      throw new ProviderAdapterError(
        'submit',
        'Failed to parse Qwen response.',
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_response_parse_failed',
        }
      )
    }
    if (parsed.error !== null) throw this.createStreamError(parsed.error)
    if (
      !parsed.identityConsistent ||
      (ownedRequest.chatId !== null && parsed.chatId !== ownedRequest.chatId) ||
      (ownedRequest.userMessageId === null
        ? parsed.parentId === null
        : parsed.parentId !== ownedRequest.userMessageId) ||
      parsed.responseId === null
    ) {
      throw new ProviderAdapterError(
        'submit',
        'Qwen response identity did not match the submitted request.',
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_response_identity_mismatch',
        }
      )
    }
    if (!parsed.isFinished) {
      throw new ProviderAdapterError(
        'submit',
        buildResponseCompletionErrorMessage('Qwen'),
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_response_incomplete',
        }
      )
    }
    if (!parsed.text.trim()) {
      throw new ProviderAdapterError(
        'submit',
        'Qwen response completed without answer text.',
        {
          kind: 'protocol',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_response_empty',
        }
      )
    }
  }

  private createHttpError(status: number): ProviderAdapterError {
    if (status >= 500) {
      return new ProviderAdapterError(
        'submit',
        buildSubmitOutcomeUnknownMessage('Qwen'),
        {
          kind: 'unknown',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_submit_outcome_unknown',
        }
      )
    }
    return new ProviderAdapterError(
      'submit',
      `Qwen completion request returned HTTP ${status}.`,
      {
        kind: status === 429 ? 'rate_limit' : 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: `qwen_submit_http_${status}`,
      }
    )
  }

  private createStreamError(error: QwenStreamError): ProviderAdapterError {
    const normalizedCode = error.code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    const isRateLimit = /(?:rate|limit|quota|concurrency)/i.test(error.code)
    return new ProviderAdapterError(
      'submit',
      `Qwen response failed: ${error.message ?? error.code}`,
      {
        kind: isRateLimit ? 'rate_limit' : 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: normalizedCode
          ? `qwen_stream_error_${normalizedCode}`
          : 'qwen_stream_error',
      }
    )
  }

  private async ensureSubmitAuth(signal?: AbortSignal): Promise<void> {
    if (await this.isLoggedIn({ signal })) return
    throw new ProviderAdapterError(
      'submit',
      'Qwen is not logged in for the current browser profile.',
      {
        kind: 'auth',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'qwen_signed_out',
      }
    )
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ProviderAdapterUnsupportedError) return false
    if (error instanceof ProviderAdapterError) {
      return error.retryable || this.isRetryableError(error.cause)
    }
    if (!(error instanceof Error)) return false
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

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return this.conversationId === null
      ? `${QWEN_CHAT_URL}/`
      : `${QWEN_CHAT_URL}/c/${encodeURIComponent(this.conversationId)}`
  }
}
