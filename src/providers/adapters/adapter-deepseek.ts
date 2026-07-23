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
const DEEPSEEK_CHAT_COMPLETION_URL =
  'https://chat.deepseek.com/api/v0/chat/completion'
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

export class DeepSeekAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'deepseek' as const
  }

  private conversationIdVal!: string | null

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
      if (!(await this.isLoggedIn())) {
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

  public async isLoggedIn(): Promise<boolean> {
    return await this.ui.isLoggedIn()
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.ui.selectModel(model)
  }

  public async attachText(text: string) {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.ui.attachText(text)
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
        await this.clearRetryComposerElements(controls.composer),
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
    return (
      request.method() === 'POST' &&
      request.url().startsWith(DEEPSEEK_CHAT_COMPLETION_URL)
    )
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('DeepSeek')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    const parsedResponse = await this.readCurrentCapturedResponse(
      fetchCaptureStartIndex
    )
    const text = parsedResponse?.text.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  private async readCurrentCapturedResponse(
    fetchCaptureStartIndex: number
  ): Promise<DeepSeekParsedResponse | null> {
    const raw = await this.readCurrentCapturedRawResponse(
      fetchCaptureStartIndex
    )
    return raw === null ? null : this.parseResponse(raw)
  }

  private async readCurrentCapturedRawResponse(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    return await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) =>
        entry.method === 'POST' &&
        (entry.url === '/api/v0/chat/completion' ||
          entry.url.endsWith('/api/v0/chat/completion') ||
          entry.url.startsWith(DEEPSEEK_CHAT_COMPLETION_URL))
    )
  }

  private async waitForCapturedFinishedResponse(
    fetchCaptureStartIndex: number,
    signal?: AbortSignal
  ): Promise<DeepSeekParsedResponse> {
    let parsedResponse: DeepSeekParsedResponse | null = null

    await waitAsync(
      async () => {
        const rawResponse = await abortable(
          this.readCurrentCapturedRawResponse(fetchCaptureStartIndex),
          signal
        )
        if (rawResponse === null) {
          return false
        }

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

    if (parsedResponse === null) {
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
    return parsedResponse
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.ui.waitForSendReady(
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
          if (!this.isTargetCompletionRequest(request)) {
            return
          }
          resolveRequestStarted()
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
          await this.ui.clickSend()
          this.emitSubmitSent()
          throwIfAborted(signal)

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

          await awaitWithTimeout(
            targetResponse.promise,
            this.getSubmitResponseTimeoutMs(),
            () =>
              new Error(
                'Timed out waiting for DeepSeek response after the request started.'
              ),
            { signal }
          )
          const parsedResponse = await this.waitForCapturedFinishedResponse(
            fetchCaptureStartIndex,
            signal
          )
          await this.waitForReadyButton(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          this.conversationIdVal =
            this.conversationIdVal ??
            this.page.url().match(/\/a\/chat\/s\/([^/?#]+)/)?.[1] ??
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
