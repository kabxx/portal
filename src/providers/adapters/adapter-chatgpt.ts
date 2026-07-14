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
import { repeatAsync } from '../../shared/repeat.ts'
import {
  emptyHistoryResult,
  parseChatGptHistory,
} from '../conversation-history.ts'

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

type ChatGPTParsedResponse = {
  conversationId?: string
  messageId?: string
  text: string
  isFinished: boolean
}

const CHATGPT_RESPONSE_STABLE_POLLS = 3

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readConversationId(node: Record<string, unknown>): string | undefined {
  const value = node.conversation_id ?? node.conversationId
  return typeof value === 'string' && value.trim() ? value : undefined
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

function readMessageId(node: Record<string, unknown>): string | undefined {
  const value = node.message_id ?? node.messageId ?? node.id
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readRole(node: Record<string, unknown>): string | undefined {
  if (typeof node.role === 'string') {
    return node.role
  }
  const author = asRecord(node.author)
  return typeof author?.role === 'string' ? author.role : undefined
}

function readFinished(node: Record<string, unknown>): boolean {
  if (
    node.isFinished === true ||
    node.done === true ||
    node.final === true ||
    node.end_turn === true
  ) {
    return true
  }

  const status =
    typeof node.status === 'string' ? node.status.toLowerCase() : ''
  if (
    status.includes('finish') ||
    status.includes('complete') ||
    status.includes('done')
  ) {
    return true
  }

  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  return (
    type.includes('finish') ||
    type.includes('complete') ||
    type.includes('done')
  )
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text || /^https?:\/\//.test(text) || text.startsWith('wss://')) {
      return undefined
    }
    return text
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => readText(item))
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0
      )
      .join('')
    return text.trim() ? text : undefined
  }

  const node = asRecord(value)
  if (!node) {
    return undefined
  }

  const candidates = [
    readText(node.text),
    readText(node.delta),
    readText(node.parts),
    readText(node.content),
    readText(node.markdown),
  ].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  )

  if (candidates.length > 0) {
    return candidates.join('\n').trim()
  }

  return undefined
}

function isVisibleMessage(node: Record<string, unknown>): boolean {
  const metadata = asRecord(node.metadata)
  if (metadata?.is_visually_hidden_from_conversation === true) {
    return false
  }

  const channel =
    typeof node.channel === 'string' ? node.channel.toLowerCase() : null
  if (channel !== null && channel !== 'final') {
    return false
  }

  return true
}

function formatReferenceId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value
  }

  const node = asRecord(value)
  if (!node) {
    return null
  }

  const turnIndex = typeof node.turn_index === 'number' ? node.turn_index : null
  const refType = typeof node.ref_type === 'string' ? node.ref_type : null
  const refIndex = typeof node.ref_index === 'number' ? node.ref_index : null
  if (turnIndex === null || refType === null || refIndex === null) {
    return null
  }

  return `turn${turnIndex}${refType}${refIndex}`
}

function collectReferenceUrls(value: unknown): Map<string, string> {
  const results = new Map<string, string>()

  const visit = (nodeValue: unknown): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item)
      }
      return
    }

    const node = asRecord(nodeValue)
    if (!node) {
      return
    }

    const referenceId = formatReferenceId(node.ref_id)
    const url =
      typeof node.url === 'string' && node.url.trim() ? node.url : null
    if (referenceId !== null && url !== null && !results.has(referenceId)) {
      results.set(referenceId, url)
    }

    const refs = Array.isArray(node.refs) ? node.refs : null
    if (refs !== null && url !== null) {
      for (const ref of refs) {
        const groupedReferenceId = formatReferenceId(ref)
        if (groupedReferenceId !== null && !results.has(groupedReferenceId)) {
          results.set(groupedReferenceId, url)
        }
      }
    }

    for (const child of Object.values(node)) {
      visit(child)
    }
  }

  visit(value)
  return results
}

function stripInlineReferenceMarkers(text: string): string {
  return text
    .replace(
      /\uE200(?:cite|i)\uE202(?:turn[^\s\uE200\uE201\uE202]+\uE202?)+\uE201?/g,
      ''
    )
    .replace(/[\uE201\uE202]+/g, '')
    .trim()
}

function normalizeAssistantTextWithReferenceMap(
  text: string,
  referenceMap: ReadonlyMap<string, string>
): string {
  const cleanedText = stripInlineReferenceMarkers(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const referenceUrls = [...text.matchAll(/turn\d+[a-z_]+\d+/gi)]
    .map((match) => match[0])
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((referenceId) => referenceMap.get(referenceId) ?? null)
    .filter(
      (value, index, values): value is string =>
        value !== null && values.indexOf(value) === index
    )

  if (referenceUrls.length === 0) {
    return cleanedText
  }

  return [cleanedText, ...referenceUrls].filter(Boolean).join('\n')
}

function normalizeAssistantTextFromReferences(
  text: string,
  message: Record<string, unknown>
): string {
  return normalizeAssistantTextWithReferenceMap(
    text,
    collectReferenceUrls(message)
  )
}

function readToolMultimodalResponse(
  message: Record<string, unknown>
): ChatGPTParsedResponse | null {
  const role = readRole(message)
  const content = asRecord(message.content)
  const contentType =
    typeof content?.content_type === 'string' ? content.content_type : ''
  if (
    role !== 'tool' ||
    contentType !== 'multimodal_text' ||
    !isVisibleMessage(message)
  ) {
    return null
  }

  const conversationId = readConversationId(message)
  const messageId = readMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    text: '[ChatGPT image generation completed in the UI. This transport payload did not include direct image URLs.]',
    isFinished: readFinished(message),
  }
}

function readResponseFromMessage(
  message: Record<string, unknown>
): ChatGPTParsedResponse | null {
  const role = readRole(message)
  const rawText = readText(message.content ?? message)
  const text = rawText
    ? normalizeAssistantTextFromReferences(rawText, message)
    : rawText
  if (role !== 'assistant' || !text || !isVisibleMessage(message)) {
    return readToolMultimodalResponse(message)
  }

  const conversationId = readConversationId(message)
  const messageId = readMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    text,
    isFinished: readFinished(message),
  }
}

function collectResponses(value: unknown): ChatGPTParsedResponse[] {
  const results: ChatGPTParsedResponse[] = []

  const visit = (nodeValue: unknown): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item)
      }
      return
    }

    const node = asRecord(nodeValue)
    if (!node) {
      return
    }

    const response = readResponseFromMessage(node)
    if (response !== null) {
      results.push(response)
    }

    for (const child of Object.values(node)) {
      visit(child)
    }
  }

  visit(value)
  return results
}

function pickBestResponse(
  results: readonly ChatGPTParsedResponse[]
): ChatGPTParsedResponse | null {
  const best =
    [...results]
      .reverse()
      .find((item) => item.isFinished && item.text.trim()) ??
    [...results].reduce<ChatGPTParsedResponse | null>((best, current) => {
      if (!current.text.trim()) {
        return best
      }
      if (best === null || current.text.length >= best.text.length) {
        return current
      }
      return best
    }, null)

  return best === null
    ? null
    : {
        ...best,
        text: stripInlineReferenceMarkers(best.text),
      }
}

export class ChatGPTAdapter extends ProviderAdapter {
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

    const openPicker = async () => {
      await this.page.locator('button.__composer-pill').click()
      const picker = this.page
        .locator(CHATGPT_INTELLIGENCE_PICKER_SELECTOR)
        .last()
      await waitAsync(async () => await picker.isVisible().catch(() => false), {
        timeoutMs: 5000,
      })
      return picker
    }

    let picker = await openPicker()

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

    return this.parseHttpResponse(raw)
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('ChatGPT')
  }

  protected getSubmitResponseIdleTimeoutMs(): number {
    return CHATGPT_RESPONSE_IDLE_TIMEOUT_MS
  }

  private getComposerSpeechButton() {
    return this.page
      .locator('button[style*="--vt-composer-speech-button"]')
      .first()
  }

  private getComposerDataTestIdSendButton() {
    return this.page.locator('button[data-testid="send-button"]').first()
  }

  private async isLocatorReady(locator: {
    isVisible: () => Promise<boolean>
    isEnabled: () => Promise<boolean>
  }): Promise<boolean> {
    return (
      (await locator.isVisible().catch(() => false)) &&
      (await locator.isEnabled().catch(() => false))
    )
  }

  private async waitForComposerReady(
    action: 'restore' | 'submit',
    timeoutMs: number,
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
          resolveRequestStarted()
          if (response.status() !== 200) {
            return
          }
          responseObserved = true
          settleHttpResponse({ kind: 'resolve' })
          void (async () => {
            try {
              const parsedResponse = this.parseHttpResponse(
                await response.text()
              )
              if (
                parsedResponse !== null &&
                parsedResponse.text.trim().length > 0
              ) {
                updateHttpParsedResponse(parsedResponse)
              }
            } catch {}
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
          const websocketParsedResponse = this.parseWebsocketResponse(
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
          await sendButton.click()
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
            const responseDeadlineAt =
              (requestStartedAt ?? Date.now()) +
              this.getSubmitResponseTimeoutMs()
            await waitAsync(
              async () => {
                await updateCapturedHttpResponse()
                parsedResponse = pickCurrentResponse()
                await emitCurrentStreamText(parsedResponse)
                return parsedResponse !== null || terminalError !== null
              },
              {
                timeoutMs: Math.max(1, responseDeadlineAt - Date.now()),
                continueIf: async (startedAt, currentAt) =>
                  currentAt < responseDeadlineAt,
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
            const responseDeadlineAt =
              (requestStartedAt ?? Date.now()) +
              this.getSubmitResponseTimeoutMs()
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
                    CHATGPT_FINISHED_RESPONSE_SETTLE_MS
                ) {
                  return true
                }

                return false
              },
              {
                timeoutMs: Math.max(1, responseDeadlineAt - Date.now()),
                continueIf: async (startedAt, currentAt) =>
                  currentAt < responseDeadlineAt &&
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
              throw terminalError
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
              throw terminalError
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

  private parseWebsocketResponse(
    frames: readonly string[]
  ): ChatGPTParsedResponse | null {
    const results: ChatGPTParsedResponse[] = []
    const aggregatedReferenceUrls = new Map<string, string>()
    const streamedResponses = new Map<string, ChatGPTParsedResponse>()
    let activeMessageId: string | null = null

    const extractJsonChunks = (value: string): string[] => {
      const chunks: string[] = []

      for (let i = 0; i < value.length; i++) {
        const startChar = value[i]
        if (startChar !== '[' && startChar !== '{') {
          continue
        }

        let depth = 0
        let inString = false
        let isEscaped = false

        for (let j = i; j < value.length; j++) {
          const char = value[j]

          if (inString) {
            if (isEscaped) {
              isEscaped = false
            } else if (char === '\\') {
              isEscaped = true
            } else if (char === '"') {
              inString = false
            }
            continue
          }

          if (char === '"') {
            inString = true
            continue
          }

          if (char === '[' || char === '{') {
            depth++
            continue
          }

          if (char === ']' || char === '}') {
            depth--
            if (depth === 0) {
              chunks.push(value.slice(i, j + 1))
              i = j
              break
            }
          }
        }
      }

      return chunks
    }

    const extractEncodedItems = (
      value: unknown
    ): Array<{
      encodedItem: string
      conversationId?: string
    }> => {
      const items: Array<{
        encodedItem: string
        conversationId?: string
      }> = []

      const visit = (nodeValue: unknown): void => {
        if (Array.isArray(nodeValue)) {
          for (const item of nodeValue) {
            visit(item)
          }
          return
        }

        const node = asRecord(nodeValue)
        if (!node) {
          return
        }

        if (typeof node.encoded_item === 'string') {
          const conversationId = readConversationId(node)
          items.push({
            encodedItem: node.encoded_item,
            ...(conversationId !== undefined ? { conversationId } : {}),
          })
        }

        for (const child of Object.values(node)) {
          visit(child)
        }
      }

      visit(value)
      return items
    }

    const parseEncodedItem = (
      encodedItem: string
    ): {
      eventType?: string
      data?: string
    } => {
      const lines = encodedItem.split(/\r?\n/)
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

      return {
        ...(eventType !== undefined ? { eventType } : {}),
        ...(dataLines.length > 0 ? { data: dataLines.join('\n') } : {}),
      }
    }

    const upsertStreamedResponse = (
      messageId: string,
      update: (current: ChatGPTParsedResponse | null) => ChatGPTParsedResponse
    ): void => {
      streamedResponses.set(
        messageId,
        update(streamedResponses.get(messageId) ?? null)
      )
    }

    const applyAssistantMessage = (
      message: Record<string, unknown>,
      fallbackConversationId?: string
    ): void => {
      if (readRole(message) !== 'assistant' || !isVisibleMessage(message)) {
        return
      }

      const content = asRecord(message.content)
      const contentType =
        typeof content?.content_type === 'string' ? content.content_type : ''
      if (contentType !== 'text') {
        return
      }

      const messageId = readMessageId(message)
      if (messageId === undefined) {
        return
      }

      const conversationId =
        readConversationId(message) ?? fallbackConversationId
      const rawText = readText(content?.parts) ?? ''
      const text = rawText
        ? normalizeAssistantTextFromReferences(rawText, message)
        : rawText
      const isFinished = readFinished(message)

      upsertStreamedResponse(messageId, (current) => ({
        ...(conversationId !== undefined
          ? { conversationId }
          : current?.conversationId !== undefined
            ? { conversationId: current.conversationId }
            : {}),
        messageId,
        text: text || current?.text || '',
        isFinished: current?.isFinished === true || isFinished,
      }))
      activeMessageId = messageId
    }

    const appendToActiveMessage = (text: string): void => {
      if (activeMessageId === null || !text) {
        return
      }

      upsertStreamedResponse(activeMessageId, (current) => {
        if (current === null) {
          return {
            messageId: activeMessageId!,
            text,
            isFinished: false,
          }
        }
        return {
          ...current,
          text: `${current.text}${text}`,
        }
      })
    }

    const markActiveMessageFinished = (): void => {
      if (activeMessageId === null) {
        return
      }

      upsertStreamedResponse(activeMessageId, (current) => ({
        ...(current ?? {
          messageId: activeMessageId!,
          text: '',
          isFinished: false,
        }),
        isFinished: true,
      }))
    }

    const applyPatchOperations = (operations: readonly unknown[]): void => {
      for (const operationValue of operations) {
        const operation = asRecord(operationValue)
        if (!operation) {
          continue
        }

        const path = typeof operation.p === 'string' ? operation.p : ''
        const action = typeof operation.o === 'string' ? operation.o : ''
        const value = operation.v

        if (path === '/message/content/parts/0' && typeof value === 'string') {
          if (action === 'replace') {
            if (activeMessageId === null) {
              continue
            }
            upsertStreamedResponse(activeMessageId, (current) => ({
              ...(current ?? {
                messageId: activeMessageId!,
                text: '',
                isFinished: false,
              }),
              text: value,
            }))
            continue
          }
          if (action === 'append') {
            appendToActiveMessage(value)
            continue
          }
        }

        if (path === '/message/status' && typeof value === 'string') {
          if (
            value.toLowerCase().includes('finish') ||
            value.toLowerCase().includes('complete')
          ) {
            markActiveMessageFinished()
          }
          continue
        }

        if (path === '/message/end_turn' && value === true) {
          markActiveMessageFinished()
          continue
        }

        if (path === '/message/metadata') {
          const metadata = asRecord(value)
          if (metadata?.is_complete === true) {
            markActiveMessageFinished()
          }
        }
      }
    }

    for (const frame of frames) {
      for (const chunk of extractJsonChunks(frame)) {
        try {
          const parsedChunk = JSON.parse(chunk)
          results.push(...collectResponses(parsedChunk))
          for (const [referenceId, url] of collectReferenceUrls(
            parsedChunk
          ).entries()) {
            if (!aggregatedReferenceUrls.has(referenceId)) {
              aggregatedReferenceUrls.set(referenceId, url)
            }
          }
          for (const item of extractEncodedItems(parsedChunk)) {
            const { eventType, data } = parseEncodedItem(item.encodedItem)
            if (!data) {
              continue
            }

            let parsedData: unknown
            try {
              parsedData = JSON.parse(data)
            } catch {
              continue
            }

            for (const [referenceId, url] of collectReferenceUrls(
              parsedData
            ).entries()) {
              if (!aggregatedReferenceUrls.has(referenceId)) {
                aggregatedReferenceUrls.set(referenceId, url)
              }
            }

            if (eventType === 'delta') {
              const delta = asRecord(parsedData)
              if (!delta) {
                continue
              }

              const deltaValue = asRecord(delta.v)
              const message = deltaValue ? asRecord(deltaValue.message) : null
              if (message) {
                applyAssistantMessage(message, item.conversationId)
              }

              if (
                typeof delta.p === 'string' &&
                delta.p === '/message/content/parts/0' &&
                delta.o === 'append' &&
                typeof delta.v === 'string'
              ) {
                appendToActiveMessage(delta.v)
                continue
              }

              if (delta.o === 'patch' && Array.isArray(delta.v)) {
                applyPatchOperations(delta.v)
                continue
              }

              if (typeof delta.v === 'string') {
                appendToActiveMessage(delta.v)
              }
              continue
            }

            const payload = asRecord(parsedData)
            if (payload?.type === 'message_stream_complete') {
              markActiveMessageFinished()
            }
          }
        } catch {
          continue
        }
      }
    }

    results.push(
      ...[...streamedResponses.values()].map((response) => ({
        ...response,
        text: normalizeAssistantTextWithReferenceMap(
          response.text,
          aggregatedReferenceUrls
        ),
      }))
    )
    return pickBestResponse(results)
  }

  private parseHttpSseResponse(raw: string): ChatGPTParsedResponse | null {
    const results: ChatGPTParsedResponse[] = []
    const streamedResponses = new Map<string, ChatGPTParsedResponse>()
    let activeMessageId: string | null = null

    const upsertStreamedResponse = (
      messageId: string,
      update: (current: ChatGPTParsedResponse | null) => ChatGPTParsedResponse
    ): void => {
      streamedResponses.set(
        messageId,
        update(streamedResponses.get(messageId) ?? null)
      )
    }

    const applyAssistantMessage = (
      message: Record<string, unknown>,
      fallbackConversationId?: string
    ): void => {
      if (readRole(message) !== 'assistant' || !isVisibleMessage(message)) {
        return
      }

      const content = asRecord(message.content)
      const contentType =
        typeof content?.content_type === 'string' ? content.content_type : ''
      if (contentType !== 'text') {
        return
      }

      const messageId = readMessageId(message)
      if (messageId === undefined) {
        return
      }

      const conversationId =
        readConversationId(message) ?? fallbackConversationId
      const text = readText(content?.parts) ?? ''
      const isFinished = readFinished(message)

      upsertStreamedResponse(messageId, (current) => ({
        ...(conversationId !== undefined
          ? { conversationId }
          : current?.conversationId !== undefined
            ? { conversationId: current.conversationId }
            : {}),
        messageId,
        text: text || current?.text || '',
        isFinished: current?.isFinished === true || isFinished,
      }))
      activeMessageId = messageId
    }

    const appendToActiveMessage = (text: string): void => {
      if (activeMessageId === null || !text) {
        return
      }

      upsertStreamedResponse(activeMessageId, (current) => {
        if (current === null) {
          return {
            messageId: activeMessageId!,
            text,
            isFinished: false,
          }
        }
        return {
          ...current,
          text: `${current.text}${text}`,
        }
      })
    }

    const markActiveMessageFinished = (): void => {
      if (activeMessageId === null) {
        return
      }

      upsertStreamedResponse(activeMessageId, (current) => ({
        ...(current ?? {
          messageId: activeMessageId!,
          text: '',
          isFinished: false,
        }),
        isFinished: true,
      }))
    }

    const applyPatchOperations = (operations: readonly unknown[]): void => {
      for (const operationValue of operations) {
        const operation = asRecord(operationValue)
        if (!operation) {
          continue
        }

        const path = typeof operation.p === 'string' ? operation.p : ''
        const action = typeof operation.o === 'string' ? operation.o : ''
        const value = operation.v

        if (path === '/message/content/parts/0' && typeof value === 'string') {
          if (action === 'replace') {
            if (activeMessageId === null) {
              continue
            }
            upsertStreamedResponse(activeMessageId, (current) => ({
              ...(current ?? {
                messageId: activeMessageId!,
                text: '',
                isFinished: false,
              }),
              text: value,
            }))
            continue
          }
          if (action === 'append') {
            appendToActiveMessage(value)
            continue
          }
        }

        if (path === '/message/status' && typeof value === 'string') {
          if (
            value.toLowerCase().includes('finish') ||
            value.toLowerCase().includes('complete')
          ) {
            markActiveMessageFinished()
          }
          continue
        }

        if (path === '/message/end_turn' && value === true) {
          markActiveMessageFinished()
          continue
        }

        if (path === '/message/metadata') {
          const metadata = asRecord(value)
          if (metadata?.is_complete === true) {
            markActiveMessageFinished()
          }
        }
      }
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) {
        continue
      }

      const data = line.slice('data:'.length).trim()
      if (!data || data === '[DONE]') {
        continue
      }

      let parsedData: unknown
      try {
        parsedData = JSON.parse(data)
      } catch {
        continue
      }

      results.push(...collectResponses(parsedData))
      const payload = asRecord(parsedData)
      if (!payload) {
        continue
      }

      const deltaValue = asRecord(payload.v)
      const message = deltaValue ? asRecord(deltaValue.message) : null
      if (message) {
        applyAssistantMessage(
          message,
          readConversationId(payload) ?? readConversationId(deltaValue ?? {})
        )
      }

      if (
        typeof payload.p === 'string' &&
        payload.p === '/message/content/parts/0' &&
        payload.o === 'append' &&
        typeof payload.v === 'string'
      ) {
        appendToActiveMessage(payload.v)
        continue
      }

      if (payload.o === 'patch' && Array.isArray(payload.v)) {
        applyPatchOperations(payload.v)
        continue
      }

      if (typeof payload.v === 'string') {
        appendToActiveMessage(payload.v)
        continue
      }

      if (payload.type === 'message_stream_complete') {
        markActiveMessageFinished()
      }
    }

    results.push(...streamedResponses.values())
    return pickBestResponse(results)
  }

  private parseHttpResponse(raw: string): ChatGPTParsedResponse | null {
    let root: unknown

    try {
      root = JSON.parse(raw)
    } catch {
      return this.parseHttpSseResponse(raw)
    }

    const rootRecord = asRecord(root)
    if (!rootRecord) {
      return null
    }

    const conversationId =
      typeof rootRecord.conversation_id === 'string'
        ? rootRecord.conversation_id
        : undefined
    const currentNodeId =
      typeof rootRecord.current_node === 'string'
        ? rootRecord.current_node
        : undefined
    const mapping = asRecord(rootRecord.mapping)

    if (currentNodeId !== undefined && mapping) {
      const currentNode = asRecord(mapping[currentNodeId])
      const message = currentNode ? asRecord(currentNode.message) : null
      if (message) {
        const response = readResponseFromMessage({
          ...message,
          ...(conversationId !== undefined
            ? { conversation_id: conversationId }
            : {}),
        })
        if (response !== null) {
          return response
        }
      }
    }

    return pickBestResponse(collectResponses(root))
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
