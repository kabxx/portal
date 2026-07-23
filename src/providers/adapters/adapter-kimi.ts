import {
  ProviderAdapter,
  type AbortOptions,
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
  parseKimiHistory,
} from '../conversation-history.ts'
import type { ResolvedProviderModel } from '../provider-model-catalog.ts'
import { KimiUi, type KimiToggleState } from '../ui/kimi/kimi-ui.ts'

const KIMI_CHAT_URL = 'https://www.kimi.com'
const KIMI_CHAT_REQUEST_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const KIMI_HISTORY_REQUEST_PATH =
  '/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages'
const KIMI_USER_REQUEST_PATH = '/api/user'
const KIMI_HISTORY_PAGE_SIZE = 100
const KIMI_CAPABILITY_UI_TIMEOUT_MS = 5_000

export type {
  KimiToggleCapability,
  KimiToggleState,
} from '../ui/kimi/kimi-ui.ts'

type KimiAuthState = 'pending' | 'signed_in' | 'signed_out'

interface KimiStreamError {
  code: string
  detail: string | null
}

interface KimiPageResponseResult {
  raw: string
  status: number
  error: string | null
}

export interface KimiParsedResponse {
  isFinished: boolean
  statuses: string[]
  text: string | null
  error: KimiStreamError | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readKimiConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.hostname !== 'www.kimi.com') return undefined
    const match = url.pathname.match(/^\/chat\/([^/?#]+)\/?$/)
    const id = match?.[1] ? decodeURIComponent(match[1]) : null
    return id && id !== 'history' ? id : undefined
  } catch {
    return undefined
  }
}

function isKimiPath(value: string, pathname: string): boolean {
  try {
    const url = new URL(value, KIMI_CHAT_URL)
    return url.origin === KIMI_CHAT_URL && url.pathname === pathname
  } catch {
    return false
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readKimiSubmittedText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  for (const value of extractKimiJsonObjects(raw)) {
    const message = isRecord(value) ? value.message : null
    if (!isRecord(message) || message.role !== 'user') continue
    const blocks: unknown[] = Array.isArray(message.blocks)
      ? (message.blocks as unknown[])
      : []
    return blocks
      .map((block) => {
        const text = isRecord(block) ? block.text : null
        return isRecord(text) && typeof text.content === 'string'
          ? text.content
          : ''
      })
      .join('')
  }
  return null
}

function isOwnedKimiRequestBody(
  raw: string | null | undefined,
  submittedText: string
): boolean {
  return readKimiSubmittedText(raw) === submittedText
}

function nonEmptyKimiText(value: string | null): string | null {
  return value !== null && value.trim().length > 0 ? value : null
}

function readKimiBlockText(block: Record<string, unknown>): string | null {
  const directText = isRecord(block.text) ? block.text : null
  if (directText !== null && typeof directText.content === 'string') {
    return directText.content
  }

  const content = isRecord(block.content) ? block.content : null
  const contentValue =
    content !== null && isRecord(content.value) ? content.value : null
  if (
    content?.case === 'text' &&
    contentValue !== null &&
    typeof contentValue.content === 'string'
  ) {
    return contentValue.content
  }
  const nestedText =
    content !== null && isRecord(content.text) ? content.text : null
  return nestedText !== null && typeof nestedText.content === 'string'
    ? nestedText.content
    : null
}

function isKimiAssistantRole(value: unknown): boolean {
  return value === 'assistant' || value === 'ROLE_ASSISTANT' || value === 2
}

function readKimiBlockMessageId(block: Record<string, unknown>): string | null {
  return readString(block.messageId) ?? readString(block.message_id)
}

function isKimiWholeBlockSet(frame: Record<string, unknown>): boolean {
  const operation = frame.op
  const isSet =
    operation === 1 || operation === 'set' || operation === 'OPERATOR_SET'
  const mask = isRecord(frame.mask) ? frame.mask : null
  const paths = Array.isArray(mask?.paths) ? mask.paths : []
  return isSet && paths[0] === 'block'
}

export function extractKimiJsonObjects(raw: string): unknown[] {
  const objects: unknown[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!
    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          objects.push(JSON.parse(raw.slice(start, index + 1)))
        } catch {
          // A damaged Connect frame is ignored; later complete frames remain usable.
        }
        start = -1
      }
    }
  }
  return objects
}

export function parseKimiConnectResponse(raw: string): KimiParsedResponse {
  const statuses = new Set<string>()
  const blockOrder: string[] = []
  const blockTexts = new Map<string, string>()
  let assistantMessageId: string | null = null
  let streamError: KimiStreamError | null = null
  let hasDoneFrame = false

  const writeBlockText = (
    key: string,
    text: string,
    replace: boolean
  ): void => {
    if (!blockTexts.has(key)) {
      blockOrder.push(key)
      blockTexts.set(key, text)
      return
    }
    blockTexts.set(key, replace ? text : blockTexts.get(key)! + text)
  }

  const processMessage = (
    message: Record<string, unknown>,
    frame: Record<string, unknown>
  ): void => {
    const messageId = readString(message.id)
    if (
      isKimiAssistantRole(message.role) &&
      messageId !== null &&
      assistantMessageId === null
    ) {
      assistantMessageId = messageId
    }
    if (messageId === null || messageId !== assistantMessageId) return

    const status = readString(message.status)
    if (status?.startsWith('MESSAGE_STATUS_')) statuses.add(status)

    const blocks = Array.isArray(message.blocks)
      ? (message.blocks as unknown[])
      : []
    for (let index = 0; index < blocks.length; index += 1) {
      const candidate = blocks[index]
      const block = isRecord(candidate) ? candidate : null
      if (block === null) continue
      const explicitBlockId = readString(block.id)
      const text = readKimiBlockText(block)
      if (text === null) continue
      const blockId = explicitBlockId ?? `${messageId}:inline:${index}`
      writeBlockText(blockId, text, isKimiWholeBlockSet(frame))
    }
  }

  const processBlock = (
    block: Record<string, unknown>,
    frame: Record<string, unknown>
  ): void => {
    if (assistantMessageId === null) return
    const messageId = readKimiBlockMessageId(block)
    if (messageId !== null && messageId !== assistantMessageId) return
    const explicitBlockId = readString(block.id)
    if (explicitBlockId === null) return
    const text = readKimiBlockText(block)
    if (text === null) return
    writeBlockText(explicitBlockId, text, isKimiWholeBlockSet(frame))
  }

  const visit = (value: unknown, frame: Record<string, unknown>): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, frame))
      return
    }
    if (!isRecord(value)) return

    if (isRecord(value.message)) {
      processMessage(value.message, frame)
    }
    if (isRecord(value.block)) {
      processBlock(value.block, frame)
    }
    if (value.case === 'message' && isRecord(value.value)) {
      processMessage(value.value, frame)
    } else if (value.case === 'block' && isRecord(value.value)) {
      processBlock(value.value, frame)
    }

    const error = isRecord(value.error) ? value.error : null
    if (error !== null) {
      const code =
        readString(error.code) ??
        readString(error.type) ??
        readString(error.reason)
      const detail =
        readString(error.detail) ?? readString(error.message) ?? null
      if (code !== null || detail !== null) {
        streamError = {
          code: code ?? 'UNKNOWN',
          detail,
        }
      }
    }
    Object.values(value).forEach((item) => visit(item, frame))
  }

  for (const frame of extractKimiJsonObjects(raw)) {
    if (
      isRecord(frame) &&
      isRecord(frame.done) &&
      Object.keys(frame.done).length === 0
    ) {
      hasDoneFrame = true
    }
    if (isRecord(frame)) visit(frame, frame)
  }
  const assistantText = blockOrder
    .map((id) => blockTexts.get(id) ?? '')
    .join('')
  return {
    isFinished: hasDoneFrame || statuses.has('MESSAGE_STATUS_COMPLETED'),
    statuses: [...statuses],
    text: nonEmptyKimiText(assistantText),
    error: streamError,
  }
}

export class KimiAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'kimi' as const
  }

  private conversationIdVal!: string | null
  private pendingTextVal = ''

  private get providerUi(): KimiUi {
    return new KimiUi(this.page, () => this.getCapabilityUiTimeoutMs())
  }

  protected getCapabilityUiTimeoutMs(): number {
    return KIMI_CAPABILITY_UI_TIMEOUT_MS
  }

  protected override async init(options: AbortOptions = {}): Promise<void> {
    await super.init(options)
    this.conversationIdVal =
      readKimiConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore(options)
  }

  private async getAuthState(startIndex = 0): Promise<KimiAuthState> {
    const entries = await this.getCapturedFetchEntries(startIndex)
    const entry = entries
      .filter(
        (candidate) =>
          candidate.method === 'GET' &&
          candidate.done &&
          candidate.status === 200 &&
          isKimiPath(candidate.url, KIMI_USER_REQUEST_PATH)
      )
      .at(-1)
    if (entry === undefined) return 'pending'

    try {
      const body: unknown = JSON.parse(entry.chunks.join(''))
      if (!isRecord(body)) return 'pending'
      if (body.is_anonymous === true) return 'signed_out'
      return readString(body.id) === null ? 'pending' : 'signed_in'
    } catch {
      return 'pending'
    }
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    try {
      const captureStartIndex = await this.getCapturedFetchEntryCount()
      await retryAsync(async () => {
        await abortable(
          this.page.goto(this.conversationUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.getRestoreTimeoutMs(),
          }),
          signal
        )
      })

      let finalState: Exclude<KimiAuthState, 'pending'> | null = null
      await waitAsync(
        async () => {
          if (await this.providerUi.isSignedOutVisible()) {
            finalState = 'signed_out'
            return true
          }
          const authState = await this.getAuthState(captureStartIndex)
          if (authState === 'signed_out') {
            finalState = authState
            return true
          }
          if (authState === 'signed_in' && (await this.providerUi.isReady())) {
            finalState = authState
            return true
          }
          return false
        },
        {
          timeoutMs: this.getRestoreTimeoutMs(),
          signal,
          onTimeout: async () => {
            throw new ProviderAdapterError(
              'restore',
              'Kimi did not expose a verified signed-in ready state after loading.',
              {
                kind: 'ui',
                recovery: 'none',
                retryable: false,
                detailCode: 'kimi_ready_state_missing',
              }
            )
          },
        }
      )
      if (finalState === 'signed_out') {
        throw new ProviderAdapterError(
          'restore',
          'Kimi is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_signed_out',
          }
        )
      }
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderAdapterError) {
        throw error
      }
      throw new ProviderAdapterError(
        'restore',
        'Kimi restore failed before a verified ready state was reached.',
        {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
          detailCode: 'kimi_restore_transient_failure',
          cause: error,
        }
      )
    }
  }

  public async isLoggedIn(): Promise<boolean> {
    try {
      if (new URL(this.page.url()).hostname !== 'www.kimi.com') return false
    } catch {
      return false
    }
    if (await this.providerUi.isSignedOutVisible()) return false
    return (await this.getAuthState()) === 'signed_in'
  }

  public async loadHistory(options: AbortOptions = {}) {
    const entries = await this.getCapturedHistoryEntries(
      (entry) =>
        entry.method === 'POST' &&
        entry.status === 200 &&
        isKimiPath(entry.url, KIMI_HISTORY_REQUEST_PATH),
      options
    )
    const body = entries
      .map((entry) => entry.chunks.join(''))
      .filter((candidate) => candidate.trim())
      .at(-1)
    return body === undefined
      ? emptyHistoryResult('Kimi history response was not captured.')
      : parseKimiHistory(body, KIMI_HISTORY_PAGE_SIZE)
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    await this.providerUi.selectModel(model)
  }

  public async hasToggleCapability(capability: string): Promise<boolean> {
    return (
      capability === 'search' && (await this.providerUi.hasSearchCapability())
    )
  }

  public async getToggleState(capability: string): Promise<KimiToggleState> {
    if (capability !== 'search') {
      throw new ProviderAdapterUnsupportedError(
        'searchStatus',
        'Kimi search capability is not available on this page.'
      )
    }
    return await this.wrapAdapterActionErrorAsync(
      'searchStatus',
      async () => await this.providerUi.getSearchState()
    )
  }

  public async setToggleState(
    capability: string,
    targetState: KimiToggleState
  ): Promise<KimiToggleState> {
    if (capability !== 'search') {
      throw new ProviderAdapterUnsupportedError(
        'searchSet',
        `Kimi does not support the ${capability} capability.`
      )
    }
    return await this.wrapAdapterActionErrorAsync(
      'searchSet',
      async () => await this.providerUi.setSearchState(targetState)
    )
  }

  public async attachText(text: string): Promise<void> {
    await this.providerUi.insertText(text)
    this.pendingTextVal += text
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const locators = this.providerUi.getRetryLocators()
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Kimi',
      isComposerReady: async () =>
        await this.isRetryComposerReady(locators.composer),
      readComposerText: async () =>
        await this.readRetryComposerText(locators.composer),
      writeText: async () => {
        this.pendingTextVal = ''
        await this.attachText(text)
      },
      clearComposer: async () => {
        await this.clearRetryComposerElements(locators.composer)
        this.pendingTextVal = ''
      },
      isStopActive: async () => await this.isRetryControlActive(locators.stop),
      isSendReady: async () => await this.isRetryControlReady(locators.send),
    })
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const paths = typeof path === 'string' ? [path] : [...path]
    await this.providerUi.uploadFiles(paths)
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.providerUi.stopGeneration()
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('Kimi')
  }

  private async waitForOwnedResponse(
    captureStartIndex: number,
    submittedText: string,
    signal?: AbortSignal,
    pageResponsePromise?: Promise<KimiPageResponseResult>
  ): Promise<
    | {
        kind: 'capture'
        entry: CapturedFetchEntry
      }
    | { kind: 'page'; response: KimiPageResponseResult }
  > {
    let nextWarningAt = Date.now() + this.getSubmitRequestStartGraceMs()
    const submitTimeoutMs = this.getSubmitResponseTimeoutMs()
    const deadline =
      submitTimeoutMs === null ? null : Date.now() + submitTimeoutMs
    while (deadline === null || Date.now() < deadline) {
      throwIfAborted(signal)
      const entries = await this.getCapturedFetchEntries(captureStartIndex)
      this.reportCapturedSubmitActivity(entries)
      const target = entries.find(
        (entry) =>
          entry.method === 'POST' &&
          isKimiPath(entry.url, KIMI_CHAT_REQUEST_PATH) &&
          isOwnedKimiRequestBody(entry.requestBody, submittedText)
      )
      if (target !== undefined) return { kind: 'capture', entry: target }
      if (pageResponsePromise !== undefined) {
        const pageResponse = await Promise.race([
          pageResponsePromise.then((response) => ({ response })),
          delayAsync(0, signal).then(() => null),
        ])
        if (pageResponse !== null) {
          return { kind: 'page', response: pageResponse.response }
        }
      }
      if ((await this.getAuthState(captureStartIndex)) === 'signed_out') {
        throw new ProviderAdapterError(
          'submit',
          'Kimi requires login before the message can be submitted.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_submit_signed_out',
          }
        )
      }
      if (Date.now() >= nextWarningAt) {
        await this.emitSubmitStatus(this.getSubmitBlockedWarningMessage())
        nextWarningAt = Date.now() + this.getSubmitBlockedWarningIntervalMs()
      }
      await delayAsync(50, signal)
    }
    throw new ProviderAdapterError(
      'submit',
      'Kimi submission was dispatched, but no owned ChatService request was observed.',
      {
        kind: 'unknown',
        recovery: 'none',
        retryable: false,
        detailCode: 'kimi_submit_outcome_unknown',
      }
    )
  }

  private async waitForOwnedResponseCompletion(
    captureStartIndex: number,
    entryId: number,
    signal?: AbortSignal
  ) {
    let deadline = Date.now() + this.getSubmitResponseStallTimeoutMs()
    let previousSnapshot = ''
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const entries = await this.getCapturedFetchEntries(captureStartIndex)
      this.reportCapturedSubmitActivity(entries)
      const target = entries.find((entry) => entry.id === entryId)
      if (target !== undefined) {
        const parsed = parseKimiConnectResponse(target.chunks.join(''))
        if (parsed.text !== null) {
          await this.emitSubmitText(parsed.text)
        }
        if (target.done) return target
        const snapshot = [
          target.status ?? '',
          target.chunks.length,
          target.error ?? '',
        ].join(':')
        if (snapshot !== previousSnapshot) {
          previousSnapshot = snapshot
          deadline = Date.now() + this.getSubmitResponseStallTimeoutMs()
        }
      }
      await delayAsync(50, signal)
    }
    throw new ProviderAdapterError(
      'submit',
      'Kimi response did not reach a terminal Connect frame in time.',
      {
        kind: 'protocol',
        recovery: 'none',
        retryable: false,
        detailCode: 'kimi_response_incomplete',
      }
    )
  }

  private createStreamError(error: KimiStreamError): ProviderAdapterError {
    const normalizedCode = error.code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    const isRateLimit = /(?:rate|limit|quota|concurrency)/i.test(error.code)
    return new ProviderAdapterError(
      'submit',
      `Kimi response failed: ${error.detail ?? error.code}`,
      {
        kind: isRateLimit ? 'rate_limit' : 'protocol',
        recovery: 'none',
        retryable: false,
        detailCode: normalizedCode
          ? `kimi_stream_error_${normalizedCode}`
          : 'kimi_stream_error',
      }
    )
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    const { signal } = options
    let dispatched = false
    let onRequest: ((request: import('playwright').Request) => void) | null =
      null
    let onResponse: ((response: import('playwright').Response) => void) | null =
      null
    try {
      throwIfAborted(signal)
      const captureStartIndex = await this.getCapturedFetchEntryCount()
      const pageResponse = createDeferred<KimiPageResponseResult>()
      const submittedText = this.pendingTextVal
      let dispatchStarted = false
      const ownedRequests = new WeakSet<import('playwright').Request>()
      onRequest = (request: import('playwright').Request) => {
        if (
          dispatchStarted &&
          request.method() === 'POST' &&
          isKimiPath(request.url(), KIMI_CHAT_REQUEST_PATH) &&
          isOwnedKimiRequestBody(request.postData(), submittedText)
        ) {
          ownedRequests.add(request)
        }
      }
      onResponse = (response: import('playwright').Response) => {
        if (!ownedRequests.has(response.request())) return
        this.emitSubmitActivitySafely()
        void response
          .text()
          .then((raw) =>
            pageResponse.resolve({
              raw,
              status: response.status(),
              error: null,
            })
          )
          .catch((error: unknown) =>
            pageResponse.resolve({
              raw: '',
              status: response.status(),
              error: error instanceof Error ? error.message : String(error),
            })
          )
      }
      this.page.on('request', onRequest)
      this.page.on('response', onResponse)
      dispatchStarted = true
      this.emitSubmitDispatching(signal)
      await this.providerUi.dispatchSubmit()
      dispatched = true
      this.pendingTextVal = ''
      this.emitSubmitSent()
      const response = await this.waitForOwnedResponse(
        captureStartIndex,
        submittedText,
        signal,
        pageResponse.promise
      )
      const completed =
        response.kind === 'page'
          ? {
              chunks: [response.response.raw],
              error: response.response.error,
              status: response.response.status,
            }
          : await this.waitForOwnedResponseCompletion(
              captureStartIndex,
              response.entry.id,
              signal
            )
      if (completed.error !== null || completed.status !== 200) {
        throw new ProviderAdapterError(
          'submit',
          'Kimi ChatService request failed before a complete response was available.',
          {
            kind: 'protocol',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_chat_request_failed',
          }
        )
      }

      const parsed = parseKimiConnectResponse(completed.chunks.join(''))
      if (parsed.error !== null) throw this.createStreamError(parsed.error)
      if (!parsed.isFinished) {
        throw new ProviderAdapterError(
          'submit',
          'Kimi response ended without terminal protocol evidence.',
          {
            kind: 'protocol',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_response_incomplete',
          }
        )
      }
      const text = parsed.text
      if (text === null) {
        throw new ProviderAdapterError(
          'submit',
          'Kimi completed without assistant text in the captured response.',
          {
            kind: 'protocol',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_response_text_missing',
          }
        )
      }

      await waitAsync(async () => await this.providerUi.isGenerationSettled(), {
        timeoutMs: this.getSubmitResponseTimeoutMs(),
        signal,
      })

      this.conversationIdVal =
        this.conversationIdVal ??
        readKimiConversationIdFromUrl(this.page.url()) ??
        null
      await this.emitSubmitText(text)
      throwIfAborted(signal)
      return text
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderAdapterError) {
        throw error
      }
      throw new ProviderAdapterError(
        'submit',
        dispatched
          ? 'Kimi submission failed after dispatch; its outcome is unknown.'
          : 'Kimi submission failed before dispatch.',
        {
          kind: dispatched ? 'unknown' : 'ui',
          recovery: dispatched ? 'none' : 'restore',
          retryable: false,
          detailCode: dispatched
            ? 'kimi_submit_outcome_unknown'
            : 'kimi_submit_before_dispatch_failed',
          cause: error,
        }
      )
    } finally {
      if (onRequest !== null) this.page.off('request', onRequest)
      if (onResponse !== null) this.page.off('response', onResponse)
    }
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return (
      this.options.conversationUrl ??
      (this.conversationId === null
        ? KIMI_CHAT_URL
        : `${KIMI_CHAT_URL}/chat/${encodeURIComponent(this.conversationId)}`)
    )
  }
}
