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
  parseDoubaoHistory,
} from '../conversation-history.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import {
  DoubaoUi,
  type DoubaoActionCapability,
  type DoubaoActionCapabilityInfo,
  type DoubaoActionCapabilityState,
} from '../ui/doubao/doubao-ui.ts'

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat'
const DOUBAO_CHAT_COMPLETION_URL = 'https://www.doubao.com/chat/completion'
const DOUBAO_HISTORY_POLL_MS = 100

type DoubaoParsedResponse = {
  conversationId?: string
  messageId?: string
  text: string
  isFinished: boolean
}

type DoubaoStreamError = {
  detailCode: string
  kind: 'rate_limit' | 'transient'
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readDoubaoConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'www.doubao.com' && url.hostname !== 'doubao.com') {
      return undefined
    }
    const match = url.pathname.match(/^\/chat\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

export class DoubaoAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'doubao' as const
  }

  private lastParsedResponse!: DoubaoParsedResponse | null

  private get ui(): DoubaoUi {
    return new DoubaoUi(this.page)
  }

  public async listActionCapabilities(): Promise<DoubaoActionCapabilityInfo[]> {
    return await this.ui.listActionCapabilities()
  }

  public async getActionCapabilityState(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    return await this.ui.getActionCapabilityState(capability)
  }

  public async clearActionCapability(): Promise<void> {
    await this.wrapAdapterActionErrorAsync(
      'clearCapability',
      async () => await this.ui.clearActionCapability()
    )
  }

  public async selectActionCapability(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => await this.ui.selectActionCapability(capability)
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

  private normalizeStreamErrorMessage(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) {
      return null
    }

    return value.trim()
  }

  private readStreamError(raw: string): DoubaoStreamError | null {
    const chunks = raw.split(/\r?\n\r?\n/)
    for (const chunk of chunks) {
      const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (lines.length === 0) {
        continue
      }

      let eventType: string | undefined
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim())
        }
      }

      if (eventType !== 'STREAM_ERROR' || dataLines.length === 0) {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(dataLines.join('\n'))
      } catch {
        continue
      }

      if (!isRecord(parsed)) {
        continue
      }

      const errorCode =
        typeof parsed.error_code === 'number'
          ? String(parsed.error_code)
          : typeof parsed.error_code === 'string'
            ? parsed.error_code
            : 'unknown'
      const normalizedErrorMessage =
        this.normalizeStreamErrorMessage(parsed.error_msg) ?? ''
      const isRateLimit =
        errorCode === '710022002' ||
        errorCode === '710022004' ||
        normalizedErrorMessage.includes('访问频繁') ||
        normalizedErrorMessage.toLowerCase().includes('rate limit')
      const errorMessage = isRateLimit
        ? errorCode === '710022002'
          ? '当前服务访问频繁，请稍后重试'
          : normalizedErrorMessage || 'rate limited'
        : normalizedErrorMessage || 'Doubao returned a stream error.'

      return {
        detailCode: `doubao_stream_error_${errorCode}`,
        kind: isRateLimit ? 'rate_limit' : 'transient',
        message: errorMessage,
      }
    }

    return null
  }

  protected async init(options: AbortOptions = {}) {
    await super.init(options)
    const { signal } = options
    const initialConversationId = readDoubaoConversationIdFromUrl(
      this.options.conversationUrl
    )
    this.lastParsedResponse = initialConversationId
      ? {
          conversationId: initialConversationId,
          text: '',
          isFinished: true,
        }
      : null
    await this.restore({ signal })
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      return this.page.url().startsWith(DOUBAO_CHAT_URL)
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
          'Doubao is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'doubao_signed_out',
          }
        )
      }
      await this.ui.waitForReady('restore', this.getRestoreTimeoutMs(), signal)
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'Doubao restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'doubao_restore_transient_failure',
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
      const bodies = (
        await this.getCapturedHistoryEntries(
          (entry) =>
            entry.method === 'POST' &&
            entry.status === 200 &&
            entry.url.includes('/im/chain/single'),
          options
        )
      )
        .map((entry) => entry.chunks.join(''))
        .filter((body) => body.trim())
      return {
        bodyCount: bodies.length,
        result:
          bodies.length === 0
            ? emptyHistoryResult('Doubao history response was not captured.')
            : parseDoubaoHistory(bodies),
      }
    }

    let state = await readResult()
    const deadline = Date.now() + this.getHistoryLoadTimeoutMs()
    while (!state.result.complete && Date.now() < deadline) {
      throwIfAborted(signal)
      const scrolled = await this.ui.scrollHistoryToTop()
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
          Math.min(DOUBAO_HISTORY_POLL_MS, pageDeadline - Date.now()),
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
    if (!this.page.url().startsWith(DOUBAO_CHAT_URL)) {
      return false
    }

    return await this.ui.isLoggedIn()
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.ui.selectModel(model)
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync(
      'attachText',
      async () => await this.ui.attachText(text)
    )
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const controls = this.ui.getRetryLocators()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Doubao',
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

  public async attachFile(path: string | readonly string[]): Promise<void> {
    await this.wrapAdapterActionErrorAsync(
      'attachFile',
      async () => await this.ui.attachFile(path)
    )
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
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
      request.url().startsWith(DOUBAO_CHAT_COMPLETION_URL)
    )
  }

  private async isTargetCompletionResponse(
    response: import('playwright').Response
  ): Promise<boolean> {
    if (!this.isTargetCompletionRequest(response.request())) {
      return false
    }

    const contentType = await response.headerValue('content-type')
    return (
      response.status() === 200 &&
      typeof contentType === 'string' &&
      contentType.includes('text/event-stream')
    )
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('Doubao')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    const parsedResponse = await this.readCurrentCapturedResponse(
      fetchCaptureStartIndex
    )
    const text = parsedResponse?.text?.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  private async readCurrentCapturedResponse(
    fetchCaptureStartIndex: number
  ): Promise<DoubaoParsedResponse | null> {
    const raw = await this.readCurrentCapturedRawResponse(
      fetchCaptureStartIndex
    )
    if (!raw) {
      return null
    }

    return this.parseResponse(raw)
  }

  private async readCurrentCapturedRawResponse(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    return await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) =>
        entry.method === 'POST' &&
        entry.url.startsWith(DOUBAO_CHAT_COMPLETION_URL)
    )
  }

  private async waitForCapturedFinishedResponse(
    fetchCaptureStartIndex: number,
    signal?: AbortSignal
  ): Promise<DoubaoParsedResponse> {
    throwIfAborted(signal)
    let timer: NodeJS.Timeout | null = null
    const capturedResponsePromise = new Promise<DoubaoParsedResponse>(
      (resolve, reject) => {
        const clearTimer = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const resolveOnce = (value: DoubaoParsedResponse) => {
          clearTimer()
          resolve(value)
        }
        const rejectOnce = (error: unknown) => {
          clearTimer()
          reject(toError(error, 'Doubao response parsing failed.'))
        }

        const tick = async () => {
          try {
            const rawResponse = await this.readCurrentCapturedRawResponse(
              fetchCaptureStartIndex
            )
            if (!rawResponse) {
              return
            }

            const streamError = this.readStreamError(rawResponse)
            if (streamError !== null) {
              rejectOnce(
                new ProviderAdapterError('submit', streamError.message, {
                  kind: streamError.kind,
                  recovery: 'retry',
                  retryable: true,
                  maxAttempts: 2,
                  detailCode: streamError.detailCode,
                })
              )
              return
            }

            const parsedResponse = this.parseResponse(rawResponse)
            if (parsedResponse?.isFinished === true) {
              resolveOnce(parsedResponse)
            }
          } catch (error) {
            rejectOnce(error)
          }
        }

        timer = setInterval(() => {
          void tick()
        }, 100)
        void tick()
      }
    )

    try {
      return await awaitWithTimeout(
        capturedResponsePromise,
        this.getSubmitResponseTimeoutMs(),
        () =>
          new Error(
            'Timed out waiting for Doubao captured response to reach finished state.'
          ),
        { signal }
      )
    } finally {
      if (timer !== null) {
        clearInterval(timer)
      }
    }
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.ui.dismissDesktopPromotion('submit', signal)
        const sendButton = this.ui.getSendButton()
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
              `Doubao request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'doubao_submit_request_failed',
              }
            ),
          })
        }

        const onResponse = async (response: import('playwright').Response) => {
          try {
            if (!this.isTargetCompletionRequest(response.request())) {
              return
            }
            this.emitSubmitActivitySafely()
            resolveRequestStarted()
            if (await this.isTargetCompletionResponse(response)) {
              settleTargetResponse({ kind: 'resolve', response })
              return
            }

            settleTargetResponse({
              kind: 'reject',
              error: new ProviderAdapterError(
                'submit',
                `Doubao returned an unexpected response while submitting (status ${response.status()}).`,
                {
                  kind: 'protocol',
                  recovery: 'none',
                  retryable: false,
                  maxAttempts: 1,
                  detailCode: 'doubao_submit_unexpected_response',
                }
              ),
            })
          } catch (error) {
            settleTargetResponse({ kind: 'reject', error })
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
        try {
          stopSubmitTextPolling = this.startSubmitTextPolling(
            async () =>
              await this.readCurrentStreamedResponseText(fetchCaptureStartIndex)
          )
          this.emitSubmitDispatching(signal)
          await sendButton.click()
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

          await awaitWithTimeout(
            targetResponse.promise,
            this.getSubmitResponseTimeoutMs(),
            () =>
              new Error(
                'Timed out waiting for Doubao response after the request started.'
              ),
            { signal }
          )

          this.lastParsedResponse = await this.waitForCapturedFinishedResponse(
            fetchCaptureStartIndex,
            signal
          )
          await this.ui.waitForReady(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          await this.ui.dismissDesktopPromotion('submit', signal)
          await this.emitSubmitText(this.lastParsedResponse.text)
          throwIfAborted(signal)
          return this.lastParsedResponse.text
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
      if (
        error instanceof ProviderAdapterError &&
        error.kind === 'rate_limit'
      ) {
        throw error
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'Doubao submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'doubao_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private parseResponse(raw: string): DoubaoParsedResponse | null {
    const textFragments: string[] = []
    const imageUrls: string[] = []
    let snapshotTextFragments: string[] | null = null
    let snapshotImageUrls: string[] | null = null
    let conversationId: string | undefined
    let messageId: string | undefined
    let isFinished = false

    const asRecord = (value: unknown): Record<string, unknown> | null =>
      isRecord(value) ? value : null

    const appendText = (
      value: unknown,
      target: string[] = textFragments
    ): void => {
      if (typeof value !== 'string' || !value) {
        return
      }
      target.push(value)
    }

    const appendImageUrl = (
      value: unknown,
      target: string[] = imageUrls
    ): void => {
      if (
        typeof value !== 'string' ||
        !/^https?:\/\//.test(value) ||
        target.includes(value)
      ) {
        return
      }
      target.push(value)
    }

    const readImageUrl = (
      image: Record<string, unknown> | null
    ): string | undefined => {
      if (!image) {
        return undefined
      }

      const candidates = [
        asRecord(image.image_ori_raw),
        asRecord(image.image_ori),
        asRecord(image.image_preview),
        asRecord(image.image_thumb),
      ]
      for (const candidate of candidates) {
        const url =
          typeof candidate?.url === 'string' ? candidate.url : undefined
        if (url) {
          return url
        }
      }
      return undefined
    }

    const consumeContentBlocks = (
      value: unknown,
      {
        textTarget = textFragments,
        imageTarget = imageUrls,
      }: {
        textTarget?: string[]
        imageTarget?: string[]
      } = {}
    ): void => {
      if (!Array.isArray(value)) {
        return
      }

      for (const item of value) {
        const block = asRecord(item)
        if (!block) {
          continue
        }

        const content = asRecord(block.content)
        const textBlock = asRecord(content?.text_block)
        appendText(textBlock?.text, textTarget)

        const creationBlock = asRecord(content?.creation_block)
        const creations = Array.isArray(creationBlock?.creations)
          ? creationBlock.creations
          : []
        for (const creationValue of creations) {
          const creation = asRecord(creationValue)
          const image = asRecord(creation?.image)
          appendImageUrl(readImageUrl(image), imageTarget)
        }
      }
    }

    const consumeCreationFullContent = (value: unknown): void => {
      if (typeof value !== 'string' || !value.trim()) {
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        return
      }

      if (!Array.isArray(parsed)) {
        return
      }

      const nextTextFragments: string[] = []
      const nextImageUrls: string[] = []
      for (const packetValue of parsed) {
        const packet = asRecord(packetValue)
        const blockInfo = asRecord(packet?.BlockInfo)
        const blockContent = asRecord(blockInfo?.BlockContent)
        if (!blockContent) {
          continue
        }

        consumeContentBlocks([blockContent], {
          textTarget: nextTextFragments,
          imageTarget: nextImageUrls,
        })
      }

      if (nextTextFragments.length === 0 && nextImageUrls.length === 0) {
        return
      }

      snapshotTextFragments = nextTextFragments
      snapshotImageUrls = nextImageUrls
    }

    const consumeEvent = (
      eventType: string | undefined,
      data: string
    ): boolean => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return false
      }

      const payload = asRecord(parsed)
      if (!payload) {
        return false
      }

      if (eventType === 'STREAM_MSG_NOTIFY') {
        const meta = asRecord(payload.meta)
        const content = asRecord(payload.content)
        const nextConversationId =
          typeof meta?.conversation_id === 'string'
            ? meta.conversation_id
            : undefined
        const nextMessageId =
          typeof meta?.message_id === 'string' ? meta.message_id : undefined
        conversationId = nextConversationId ?? conversationId
        messageId = nextMessageId ?? messageId
        consumeContentBlocks(content?.content_block)
        return false
      }

      if (eventType === 'STREAM_CHUNK') {
        const nextMessageId =
          typeof payload.message_id === 'string'
            ? payload.message_id
            : undefined
        messageId = nextMessageId ?? messageId

        const operations = Array.isArray(payload.patch_op)
          ? payload.patch_op
          : []
        for (const operationValue of operations) {
          const operation = asRecord(operationValue)
          const patchValue = asRecord(operation?.patch_value)
          if (!operation || !patchValue) {
            continue
          }

          consumeContentBlocks(patchValue.content_block)

          const ext = asRecord(patchValue.ext)
          consumeCreationFullContent(ext?.creation_full_content)
          if (ext?.is_finish === '1') {
            isFinished = true
          }
        }
        return false
      }

      if (eventType === 'CHUNK_DELTA') {
        appendText(payload.text)
        return false
      }

      if (eventType === 'SSE_ACK') {
        const ackClientMeta = asRecord(payload.ack_client_meta)
        const nextConversationId =
          typeof ackClientMeta?.conversation_id === 'string'
            ? ackClientMeta.conversation_id
            : undefined
        conversationId = nextConversationId ?? conversationId
        return false
      }

      if (eventType === 'SSE_REPLY_END') {
        const endType =
          typeof payload.end_type === 'number' ? payload.end_type : null
        if (endType === 1 || endType === 3) {
          isFinished = true
          return true
        }
      }
      return false
    }

    const chunks = raw.split(/\r?\n\r?\n/)
    for (const chunk of chunks) {
      const lines = chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (lines.length === 0) {
        continue
      }

      let eventType: string | undefined
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim())
        }
      }

      if (dataLines.length === 0) {
        continue
      }
      if (consumeEvent(eventType, dataLines.join('\n'))) {
        break
      }
    }

    const effectiveTextFragments = snapshotTextFragments ?? textFragments
    const effectiveImageUrls = snapshotImageUrls ?? imageUrls
    const text = effectiveTextFragments.join('').trim()
    const combinedText =
      text && effectiveImageUrls.length > 0
        ? `${text}\n${effectiveImageUrls.join('\n')}`
        : text || effectiveImageUrls.join('\n')
    if (!combinedText) {
      return null
    }

    return {
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
      text: combinedText,
      isFinished,
    }
  }

  public get conversationId(): string | null {
    return this.lastParsedResponse?.conversationId ?? null
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${DOUBAO_CHAT_URL}/${this.conversationId}`
        : DOUBAO_CHAT_URL
    ).toString()
  }
}
