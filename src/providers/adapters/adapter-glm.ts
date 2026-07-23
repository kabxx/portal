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
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { retryAsync } from '../../shared/retry.ts'
import { waitAsync } from '../../shared/wait.ts'
import { emptyHistoryResult, parseGlmHistory } from '../conversation-history.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import {
  GlmUi,
  type GlmToggleCapability,
  type GlmToggleState,
} from '../ui/glm/glm-ui.ts'

const GLM_CHAT_URL = 'https://chat.z.ai'
const GLM_HISTORY_POLL_MS = 100

interface GlmStreamError {
  code: string
  detail: string | null
}

interface GlmParsedResponse {
  text: string
  isFinished: boolean
  error: GlmStreamError | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readGlmConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'chat.z.ai') {
      return undefined
    }
    const match = url.pathname.match(/^\/c\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

function isGlmCompletionUrl(value: string): boolean {
  try {
    const url = new URL(value, GLM_CHAT_URL)
    return (
      url.origin === GLM_CHAT_URL && url.pathname === '/api/v2/chat/completions'
    )
  } catch {
    return false
  }
}

export class GlmAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'glm' as const
  }

  private conversationIdVal!: string | null
  private get providerUi(): GlmUi {
    return new GlmUi(this.page)
  }

  public async hasToggleCapability(
    capability: GlmToggleCapability
  ): Promise<boolean> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Available`,
      async () => await this.providerUi.hasToggleCapability(capability)
    )
  }

  public async getToggleState(
    capability: GlmToggleCapability
  ): Promise<GlmToggleState> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Status`,
      async () => await this.providerUi.getToggleState(capability)
    )
  }

  public async setToggleState(
    capability: GlmToggleCapability,
    targetState: GlmToggleState
  ): Promise<GlmToggleState> {
    return await this.wrapAdapterActionErrorAsync(
      `${capability}Set`,
      async () => await this.providerUi.setToggleState(capability, targetState)
    )
  }

  private async waitForReadyButton(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await this.providerUi.waitForReady(action, timeoutMs, signal)
  }

  private async waitForRestorePageState(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<'signed_out' | 'ready'> {
    return await this.providerUi.waitForRestorePageState(timeoutMs, signal)
  }

  private async dismissBlockingDialog(
    action: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.providerUi.dismissBlockingDialog(action, signal)
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
      readGlmConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore({ signal })
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      try {
        return new URL(this.page.url()).hostname === 'chat.z.ai'
      } catch {
        return false
      }
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
      const pageState = await this.waitForRestorePageState(
        this.getRestoreTimeoutMs(),
        signal
      )
      if (pageState === 'signed_out') {
        throw new ProviderAdapterError(
          'restore',
          'GLM is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'glm_signed_out',
          }
        )
      }
      await this.dismissBlockingDialog('restore', signal)
      await this.waitForReadyButton(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'GLM restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'glm_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    const { signal } = options
    throwIfAborted(signal)
    const readResult = async () => {
      const metadataEntries = await this.getCapturedHistoryEntries(
        (entry) =>
          entry.method === 'GET' &&
          entry.status === 200 &&
          /\/api\/v1\/chats\/[^/?#]+$/.test(entry.url),
        options
      )
      const batchEntries = await this.getCapturedHistoryEntries(
        (entry) =>
          entry.method === 'POST' &&
          entry.status === 200 &&
          entry.url.includes('/messages/batch'),
        options
      )
      const metadata = metadataEntries.find((entry) =>
        entry.chunks.join('').trim()
      )
      const batches = batchEntries
        .map((entry) => entry.chunks.join(''))
        .filter((body) => body.trim())
      return {
        bodyCount: batches.length,
        result:
          metadata === undefined || batches.length === 0
            ? emptyHistoryResult('GLM history response was not captured.')
            : parseGlmHistory(metadata.chunks.join(''), batches),
      }
    }

    let state = await readResult()
    const deadline = Date.now() + this.getHistoryLoadTimeoutMs()
    while (!state.result.complete && Date.now() < deadline) {
      throwIfAborted(signal)
      const scrolled = await this.providerUi.scrollHistoryToTop()
      if (!scrolled) break

      const previousBodyCount = state.bodyCount
      const previousMessageCount = state.result.messages.length
      const pageDeadline = Math.min(
        deadline,
        Date.now() + this.getHistoryPageTimeoutMs()
      )
      let progressed = false
      while (Date.now() < pageDeadline) {
        await delayAsync(
          Math.min(GLM_HISTORY_POLL_MS, pageDeadline - Date.now()),
          signal
        )
        const next = await readResult()
        state = next
        if (
          next.result.complete ||
          next.bodyCount > previousBodyCount ||
          next.result.messages.length > previousMessageCount
        ) {
          progressed = true
          break
        }
      }
      if (!progressed) break
    }
    return state.result
  }

  public async isLoggedIn(): Promise<boolean> {
    try {
      if (new URL(this.page.url()).hostname !== 'chat.z.ai') {
        return false
      }
    } catch {
      return false
    }

    return await this.providerUi.isLoggedIn()
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
      provider: 'GLM',
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

  public async attachFile(path: string | readonly string[]): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.providerUi.attachFile(path)
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.providerUi.stopGeneration()
  }

  private isTargetCompletionRequest(
    request: import('playwright').Request
  ): boolean {
    return isGlmCompletionUrl(request.url())
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('GLM')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    const raw = await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) => entry.method === 'POST' && isGlmCompletionUrl(entry.url)
    )
    if (!raw) {
      return null
    }

    const parsedResponse = this.parseResponse(raw)
    const text = parsedResponse?.text.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.dismissBlockingDialog('submit', signal)
        await this.providerUi.waitForSendReady(
          this.getSubmitResponseTimeoutMs(),
          signal
        )
        throwIfAborted(signal)

        const fetchCaptureStartIndex = await this.getCapturedFetchEntryCount()
        const requestStarted = createDeferred<void>()
        const targetResponse = createDeferred<import('playwright').Response>()
        let requestObserved = false
        let responseObserved = false
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
          if (requestObserved) {
            return
          }
          requestObserved = true
          stopWarningTimer()
          requestStarted.resolve()
        }
        const settleTargetResponse = (
          resolution:
            | { kind: 'resolve'; response: import('playwright').Response }
            | { kind: 'reject'; error: unknown }
        ) => {
          if (settled) {
            return
          }
          settled = true
          stopWarningTimer()
          if (resolution.kind === 'resolve') {
            responseObserved = true
            targetResponse.resolve(resolution.response)
            return
          }
          terminalError = resolution.error
          targetResponse.reject(resolution.error)
        }

        const onRequest = (request: import('playwright').Request) => {
          if (this.isTargetCompletionRequest(request)) {
            resolveRequestStarted()
          }
        }
        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetCompletionRequest(request)) {
            return
          }
          resolveRequestStarted()
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          settleTargetResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `GLM request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'glm_submit_request_failed',
              }
            ),
          })
        }
        const onResponse = (response: import('playwright').Response) => {
          if (!this.isTargetCompletionRequest(response.request())) {
            return
          }
          this.emitSubmitActivitySafely()
          resolveRequestStarted()
          settleTargetResponse({ kind: 'resolve', response })
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
        try {
          stopSubmitTextPolling = this.startSubmitTextPolling(
            async () =>
              await this.readCurrentStreamedResponseText(fetchCaptureStartIndex)
          )
          this.emitSubmitDispatching(signal)
          await this.providerUi.clickSend()
          this.emitSubmitSent()
          throwIfAborted(signal)

          await abortable(
            Promise.race([
              delayAsync(this.getSubmitRequestStartGraceMs()),
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
                'Timed out waiting for GLM response after the request started.'
              ),
            { signal }
          )
          throwIfAborted(signal)
          const rawResponse = await abortable(response.text(), signal)
          const parsedResponse = this.parseResponse(rawResponse)
          if (parsedResponse === null) {
            throw new ProviderAdapterError(
              'submit',
              'Failed to parse GLM response.',
              {
                kind: 'protocol',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'glm_response_parse_failed',
              }
            )
          }
          if (parsedResponse.error !== null) {
            throw this.createStreamError(parsedResponse.error)
          }
          if (!parsedResponse.isFinished) {
            throw new ProviderAdapterError(
              'submit',
              'GLM response ended without a completion marker.',
              {
                kind: 'protocol',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'glm_response_incomplete',
              }
            )
          }

          await this.waitForReadyButton(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          this.conversationIdVal =
            this.conversationIdVal ??
            readGlmConversationIdFromUrl(this.page.url()) ??
            null
          await this.emitSubmitText(parsedResponse.text)
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
          'GLM submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'glm_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private createStreamError(error: GlmStreamError): ProviderAdapterError {
    const normalizedCode = error.code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    const isRateLimit = /(?:rate|limit|concurrency)/i.test(error.code)
    return new ProviderAdapterError(
      'submit',
      `GLM response failed: ${error.detail ?? error.code}`,
      {
        kind: isRateLimit ? 'rate_limit' : 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: normalizedCode
          ? `glm_stream_error_${normalizedCode}`
          : 'glm_stream_error',
      }
    )
  }

  private parseResponse(raw: string): GlmParsedResponse | null {
    let text = ''
    let isFinished = false
    let streamError: GlmStreamError | null = null

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) {
        continue
      }
      const payload = line.slice(5).trim()
      if (!payload) {
        continue
      }
      if (payload === '[DONE]') {
        isFinished = true
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
      if (parsed.data === '[DONE]') {
        isFinished = true
        continue
      }
      if (parsed.type !== 'chat:completion') {
        continue
      }
      if (!isRecord(parsed.data)) {
        continue
      }

      const data = parsed.data
      const phase = typeof data.phase === 'string' ? data.phase : null
      if (phase === 'answer' && typeof data.delta_content === 'string') {
        text += data.delta_content
      } else if (
        phase === null &&
        typeof data.content === 'string' &&
        data.content
      ) {
        text += data.content
      }

      if (isRecord(data.error)) {
        streamError = {
          code:
            typeof data.error.code === 'string' ? data.error.code : 'UNKNOWN',
          detail:
            typeof data.error.detail === 'string' ? data.error.detail : null,
        }
      }
      if (phase === 'done' || data.done === true) {
        isFinished = true
      }
    }

    const normalizedText = text.trim()
    if (!normalizedText && streamError === null) {
      return null
    }
    return {
      text: normalizedText,
      isFinished,
      error: streamError,
    }
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${GLM_CHAT_URL}/c/${this.conversationId}`
        : GLM_CHAT_URL
    ).toString()
  }
}
