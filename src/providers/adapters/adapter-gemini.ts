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
import type { Locator } from 'playwright'
import {
  emptyHistoryResult,
  parseGeminiHistory,
} from '../conversation-history.ts'

const GEMINI_CHAT_URL = 'https://gemini.google.com/app'
const GEMINI_SIGNED_OUT_TEST_ID = 'conversations-list-signed-out'
const GEMINI_MODE_MENU_BUTTON_TEST_ID = 'bard-mode-menu-button'
const GEMINI_MODE_MENU_SELECTOR = 'gem-menu[data-test-id="gem-mode-menu"]'
const GEMINI_MODE_MENU_ITEM_SELECTOR = 'gem-menu-item'
const GEMINI_MODEL_EXTENSION_SUFFIX = '+extended'
const GEMINI_TEXTAREA_WRAPPER_TEST_ID = 'textarea-wrapper'
const GEMINI_TEXTAREA_INNER_TEST_ID = 'textarea-inner'
const GEMINI_SEND_BUTTON_CONTAINER_TEST_ID = 'send-button-container'
const GEMINI_UPLOAD_TRIGGER_SELECTOR = 'div.has-model-picker button'
const GEMINI_UPLOAD_ACTION_SELECTOR = 'images-files-uploader button'
const GEMINI_ACTION_CAPABILITY_BUTTON_SELECTOR =
  'button[role="menuitemcheckbox"]'
const GEMINI_ACTION_CAPABILITY_ICON_SELECTOR = '[data-mat-icon-name]'
const GEMINI_MORE_TOOLS_BUTTON_SELECTOR =
  'button[data-test-id="more-tools-button"]'
const GEMINI_SELECTED_CAPABILITY_BUTTON_SELECTOR =
  'gem-button[data-test-id="deselect-drawer-item-gem-button"] > button'
const GEMINI_MICROPHONE_BUTTON_SELECTOR = [
  'button.speech_dictation_mic_button',
  '[data-node-type="speech_dictation_mic_button"] .speech_dictation_mic_button',
  'speech-dictation-mic-button .speech_dictation_mic_button',
].join(', ')
const GEMINI_STREAM_GENERATE_PATH =
  '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
const GEMINI_HISTORY_POLL_MS = 100

type GeminiParsedResponse = {
  conversationId?: string
  responseId?: string
  candidateId?: string
  text: string
  isFinished: boolean
  title?: string
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return isUnknownRecord(value) ? value : null
}

function normalizeGeminiConversationId(
  conversationId: string | null | undefined
): string | undefined {
  if (!conversationId) {
    return undefined
  }

  return conversationId.replace(/^c_/, '')
}

export type GeminiActionCapability = string

export type GeminiActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

export interface GeminiActionCapabilityInfo {
  name: string
  state: GeminiActionCapabilityState
}

function readGeminiConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'gemini.google.com') {
      return undefined
    }
    const match = url.pathname.match(/^\/app\/([^/?#]+)/)
    return normalizeGeminiConversationId(
      match?.[1] ? decodeURIComponent(match[1]) : undefined
    )
  } catch {
    return undefined
  }
}

function normalizeToPathArray(path: string | readonly string[]): string[] {
  if (typeof path === 'string') {
    return [path]
  }
  return [...path]
}

function parseGeminiModel(
  model: string
): { index: number; extended: boolean | null } | null {
  const normalized = model.trim().toLowerCase()
  const hasExtendedSuffix = normalized.endsWith(GEMINI_MODEL_EXTENSION_SUFFIX)
  const modelName = hasExtendedSuffix
    ? normalized.slice(0, -GEMINI_MODEL_EXTENSION_SUFFIX.length)
    : normalized
  const modelNumber = Number(modelName)
  if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
    return null
  }
  return {
    index: modelNumber - 1,
    extended: hasExtendedSuffix ? true : null,
  }
}

export class GeminiAdapter extends ProviderAdapter {
  protected override get composerLimitProvider() {
    return 'gemini' as const
  }

  private lastParsedResponse!: GeminiParsedResponse | null

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
    const initialConversationId = readGeminiConversationIdFromUrl(
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
      return this.page.url().startsWith(GEMINI_CHAT_URL)
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
          'Gemini is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'gemini_signed_out',
          }
        )
      }
      await this.waitForMicrophoneReady(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'Gemini restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'gemini_restore_transient_failure',
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
            entry.url.includes('/_/BardChatUi/data/batchexecute') &&
            new URL(entry.url, GEMINI_CHAT_URL).searchParams.get('rpcids') ===
              'hNvQHb',
          options
        )
      )
        .map((entry) => entry.chunks.join(''))
        .filter((body) => body.trim())
      return {
        bodyCount: bodies.length,
        result:
          bodies.length === 0
            ? emptyHistoryResult('Gemini history response was not captured.')
            : parseGeminiHistory(bodies),
      }
    }

    let state = await readResult()
    const deadline = Date.now() + this.getHistoryLoadTimeoutMs()
    while (!state.result.complete && Date.now() < deadline) {
      throwIfAborted(signal)
      const scrolled = await this.page
        .evaluate(() => {
          const candidates = [
            document.querySelector('infinite-scroller.chat-history'),
            document.scrollingElement,
          ]
          let foundScrollable = false
          for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement)) continue
            if (candidate.scrollHeight <= candidate.clientHeight + 40) {
              continue
            }
            foundScrollable = true
            candidate.scrollTo({ top: 0, behavior: 'auto' })
            candidate.dispatchEvent(new Event('scroll', { bubbles: true }))
          }
          return foundScrollable
        })
        .catch(() => false)
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
          Math.min(GEMINI_HISTORY_POLL_MS, pageDeadline - Date.now()),
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
    if (!this.page.url().startsWith(GEMINI_CHAT_URL)) {
      return false
    }

    const signedOutVisible = await this.page
      .locator(`[data-test-id="${GEMINI_SIGNED_OUT_TEST_ID}"]`)
      .isVisible()
      .catch(() => false)

    return !signedOutVisible
  }

  public async changeModel(model: string): Promise<void> {
    const parsed = parseGeminiModel(model)
    if (parsed === null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Gemini does not support model "${model}".`
      )
    }
    const modelMenu = await this.openModelMenu()
    const menuItems = modelMenu.locator(GEMINI_MODE_MENU_ITEM_SELECTOR)
    const itemCount = await menuItems.count()
    if (itemCount - 1 <= parsed.index) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Gemini does not have model ${parsed.index + 1}.`
      )
    }
    await menuItems.nth(parsed.index).click()
    await this.waitForModelMenuClosed()

    if (parsed.extended === null) {
      return
    }

    const extensionMenu = await this.openModelMenu()
    const extensionItem = await this.getModelExtensionItem(
      extensionMenu,
      parsed.index
    )
    if (
      (await this.isModelExtensionItemSelected(extensionItem)) !==
      parsed.extended
    ) {
      await extensionItem.click()
    } else {
      await this.closeModelMenu()
    }
  }

  public async attachText(text: string) {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      const editor = this.page
        .locator(
          `[data-test-id="${GEMINI_TEXTAREA_WRAPPER_TEST_ID}"] rich-textarea [contenteditable="true"]`
        )
        .first()
      const textarea = this.page.locator('rich-textarea').first()
      if (await editor.isVisible().catch(() => false)) {
        await editor.click()
      } else if (
        await this.page
          .locator(`[data-test-id="${GEMINI_TEXTAREA_INNER_TEST_ID}"]`)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await this.page
          .locator(`[data-test-id="${GEMINI_TEXTAREA_INNER_TEST_ID}"]`)
          .first()
          .click()
      } else {
        await textarea.click()
      }
      await this.page.keyboard.insertText(text)
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const composer = () =>
      this.page.locator(
        [
          `[data-test-id="${GEMINI_TEXTAREA_WRAPPER_TEST_ID}"] rich-textarea [contenteditable="true"]`,
          `[data-test-id="${GEMINI_TEXTAREA_INNER_TEST_ID}"][contenteditable="true"]`,
          `[data-test-id="${GEMINI_TEXTAREA_INNER_TEST_ID}"] [contenteditable="true"]`,
          'rich-textarea [contenteditable="true"]',
        ].join(', ')
      )
    const stopButton = () =>
      this.page
        .locator(`[data-test-id="${GEMINI_SEND_BUTTON_CONTAINER_TEST_ID}"]`)
        .locator(
          'xpath=./gem-icon-button[contains(concat(" ", normalize-space(@class), " "), " send-button ") and contains(concat(" ", normalize-space(@class), " "), " stop ")]'
        )
        .locator('xpath=./button')
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Gemini',
      isComposerReady: async () => await this.isRetryComposerReady(composer()),
      readComposerText: async () =>
        await this.readRetryComposerText(composer()),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(composer()),
      isStopActive: async () => await this.isRetryControlActive(stopButton()),
      isSendReady: async () =>
        await this.isRetryControlReady(
          this.page.locator(
            `[data-test-id="${GEMINI_SEND_BUTTON_CONTAINER_TEST_ID}"] button`
          )
        ),
    })
  }

  private getUploadTrigger(): Locator {
    return this.page.locator(GEMINI_UPLOAD_TRIGGER_SELECTOR).first()
  }

  private async openModelMenu(): Promise<Locator> {
    const modelMenu = this.page.locator(GEMINI_MODE_MENU_SELECTOR).last()
    if (!(await modelMenu.isVisible().catch(() => false))) {
      await this.page
        .locator(`[data-test-id="${GEMINI_MODE_MENU_BUTTON_TEST_ID}"]`)
        .click()
      await waitAsync(
        async () => await modelMenu.isVisible().catch(() => false),
        { timeoutMs: 5000 }
      )
    }
    return modelMenu
  }

  private async closeModelMenu(): Promise<void> {
    const modelMenu = this.page.locator(GEMINI_MODE_MENU_SELECTOR).last()
    if (await modelMenu.isVisible().catch(() => false)) {
      await this.page
        .locator(`[data-test-id="${GEMINI_MODE_MENU_BUTTON_TEST_ID}"]`)
        .click()
      await this.waitForModelMenuClosed()
    }
  }

  private async waitForModelMenuClosed(): Promise<void> {
    const modelMenu = this.page.locator(GEMINI_MODE_MENU_SELECTOR).last()
    await waitAsync(
      async () => !(await modelMenu.isVisible().catch(() => false)),
      { timeoutMs: 5000 }
    )
  }

  private async getModelExtensionItem(
    modelMenu: Locator,
    modelIndex: number
  ): Promise<Locator> {
    const extensionItems = modelMenu.locator(GEMINI_MODE_MENU_ITEM_SELECTOR)
    const extensionIndex = (await extensionItems.count()) - 1
    if (extensionIndex <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'Gemini model extension toggle is unavailable.'
      )
    }
    return extensionItems.nth(extensionIndex)
  }

  private async isModelExtensionItemSelected(item: Locator): Promise<boolean> {
    const ariaChecked = await item
      .getAttribute('aria-checked')
      .catch(() => null)
    if (ariaChecked !== null) {
      return ariaChecked === 'true'
    }
    const ariaSelected = await item
      .getAttribute('aria-selected')
      .catch(() => null)
    if (ariaSelected !== null) {
      return ariaSelected === 'true'
    }
    const className = await item.getAttribute('class').catch(() => null)
    return className === null ? false : /\b(selected|checked)\b/.test(className)
  }

  private getActionCapabilityButtons(): Locator {
    return this.page.locator(GEMINI_ACTION_CAPABILITY_BUTTON_SELECTOR)
  }

  private getMoreToolsButton(): Locator {
    return this.page.locator(GEMINI_MORE_TOOLS_BUTTON_SELECTOR).first()
  }

  private getSelectedActionCapabilityButton(): Locator {
    return this.page.locator(GEMINI_SELECTED_CAPABILITY_BUTTON_SELECTOR).first()
  }

  private async openActionCapabilityMenu(action: string): Promise<void> {
    const buttons = this.getActionCapabilityButtons()
    if ((await buttons.count().catch(() => 0)) > 0) {
      return
    }

    const trigger = this.getUploadTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) {
      throw new ProviderAdapterError(
        action,
        `Gemini capability trigger not found: ${GEMINI_UPLOAD_TRIGGER_SELECTOR}`,
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'gemini_capability_trigger_missing',
        }
      )
    }

    await trigger.click()
    await waitAsync(async () => (await buttons.count().catch(() => 0)) > 0, {
      timeoutMs: 5000,
    })
  }

  private async expandMoreActionCapabilities(): Promise<void> {
    const moreToolsButton = this.getMoreToolsButton()
    if ((await moreToolsButton.count().catch(() => 0)) === 0) {
      return
    }
    if (!(await moreToolsButton.isVisible().catch(() => false))) {
      return
    }
    if (
      (await moreToolsButton
        .getAttribute('aria-disabled')
        .catch(() => null)) === 'true'
    ) {
      return
    }

    const previousCount = await this.getActionCapabilityButtons()
      .count()
      .catch(() => 0)
    await moreToolsButton.click()
    await waitAsync(
      async () =>
        (await this.getActionCapabilityButtons()
          .count()
          .catch(() => 0)) > previousCount,
      {
        timeoutMs: 5000,
      }
    ).catch(() => {})
  }

  private async closeActionCapabilityMenu(): Promise<void> {
    if (
      (await this.getActionCapabilityButtons()
        .count()
        .catch(() => 0)) === 0
    ) {
      return
    }

    await this.getUploadTrigger().click()
  }

  private async readActionCapabilityName(
    button: Locator
  ): Promise<GeminiActionCapability | null> {
    const icon = button.locator(GEMINI_ACTION_CAPABILITY_ICON_SELECTOR).first()
    const name = await icon.getAttribute('data-mat-icon-name').catch(() => null)
    if (typeof name !== 'string' || !name.trim()) {
      return null
    }
    return name.trim()
  }

  public async listActionCapabilities(): Promise<GeminiActionCapabilityInfo[]> {
    return await this.wrapAdapterActionErrorAsync(
      'listCapabilities',
      async () => {
        await this.openActionCapabilityMenu('listCapabilities')
        await this.expandMoreActionCapabilities()
        try {
          const buttons = this.getActionCapabilityButtons()
          const count = await buttons.count().catch(() => 0)
          const capabilities: GeminiActionCapabilityInfo[] = []
          const seen = new Set<string>()
          for (let index = 0; index < count; index += 1) {
            const button = buttons.nth(index)
            const name = await this.readActionCapabilityName(button)
            if (name === null || seen.has(name)) {
              continue
            }
            seen.add(name)
            const isDisabled =
              (await button.getAttribute('aria-disabled').catch(() => null)) ===
              'true'
            capabilities.push({
              name,
              state: isDisabled ? 'disabled' : 'available',
            })
          }
          return capabilities
        } finally {
          await this.closeActionCapabilityMenu()
        }
      }
    )
  }

  public async clearActionCapability(): Promise<void> {
    await this.wrapAdapterActionErrorAsync('clearCapability', async () => {
      const selectedButton = this.getSelectedActionCapabilityButton()
      if ((await selectedButton.count().catch(() => 0)) === 0) {
        return
      }
      if (!(await selectedButton.isVisible().catch(() => false))) {
        return
      }
      await selectedButton.click()
    })
  }

  public async selectActionCapability(
    capability: GeminiActionCapability
  ): Promise<GeminiActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => {
        await this.clearActionCapability()
        await this.openActionCapabilityMenu('selectCapability')
        await this.expandMoreActionCapabilities()

        const buttons = this.getActionCapabilityButtons()
        const count = await buttons.count().catch(() => 0)
        for (let index = 0; index < count; index += 1) {
          const button = buttons.nth(index)
          if ((await this.readActionCapabilityName(button)) !== capability) {
            continue
          }

          const isDisabled =
            (await button.getAttribute('aria-disabled').catch(() => null)) ===
            'true'
          if (isDisabled) {
            return 'disabled'
          }

          await button.click()
          return 'selected'
        }
        return 'unavailable'
      }
    )
  }

  public async attachFile(path: string | readonly string[]) {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      const paths = normalizeToPathArray(path)
      const uploadTrigger = this.getUploadTrigger()
      const uploadAction = this.page
        .locator(GEMINI_UPLOAD_ACTION_SELECTOR)
        .first()

      if ((await uploadTrigger.count()) === 0) {
        throw new ProviderAdapterError(
          'attachFile',
          `Gemini upload trigger not found: ${GEMINI_UPLOAD_TRIGGER_SELECTOR}`,
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'gemini_upload_trigger_missing',
          }
        )
      }

      await uploadTrigger.click()

      if ((await uploadAction.count()) === 0) {
        throw new ProviderAdapterError(
          'attachFile',
          `Gemini upload action not found: ${GEMINI_UPLOAD_ACTION_SELECTOR}`,
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'gemini_upload_action_missing',
          }
        )
      }

      const [fileChooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 5000 }),
        uploadAction.click(),
      ])
      await fileChooser.setFiles(paths)
    })
  }

  public async attachImage(path: string | readonly string[]) {
    await this.attachFile(path)
  }

  private isTargetStreamRequest(
    request: import('playwright').Request
  ): boolean {
    return (
      request.method() === 'POST' &&
      request.url().includes(GEMINI_STREAM_GENERATE_PATH)
    )
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('Gemini')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    const raw = await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) =>
        entry.method === 'POST' &&
        entry.url.includes(GEMINI_STREAM_GENERATE_PATH)
    )
    if (!raw) {
      return null
    }

    const parsedResponse = await this.parseResponse(raw)
    const text = parsedResponse?.text?.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  private pickBestParsedResponse(
    results: readonly GeminiParsedResponse[]
  ): GeminiParsedResponse | null {
    if (results.length === 0) {
      return null
    }

    const finished = [...results]
      .reverse()
      .find((item) => item.isFinished && item.text.trim())
    if (finished) {
      return finished
    }

    return [...results].reverse().find((item) => item.text.trim()) ?? null
  }

  private getMicrophoneButton() {
    return this.page.locator(GEMINI_MICROPHONE_BUTTON_SELECTOR)
  }

  public override async stopGeneration(): Promise<void> {
    const stopButton = this.page
      .locator(`[data-test-id="${GEMINI_SEND_BUTTON_CONTAINER_TEST_ID}"]`)
      .locator(
        'xpath=./gem-icon-button[contains(concat(" ", normalize-space(@class), " "), " send-button ") and contains(concat(" ", normalize-space(@class), " "), " stop ")]'
      )
      .locator('xpath=./button')

    await this.clickLocatorIfReady(stopButton)
  }

  private async waitForMicrophoneReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const microphoneButtons = this.getMicrophoneButton()
        if ((await microphoneButtons.count().catch(() => 0)) !== 1) return false
        const microphoneButton = microphoneButtons.first()
        return (
          (await microphoneButton.isVisible().catch(() => false)) &&
          (await microphoneButton.isEnabled().catch(() => false))
        )
      },
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'Gemini did not become ready after loading.'
              : 'Gemini finished responding, but the page did not become ready for the next message.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'gemini_microphone_button_missing',
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
        const sendButton = this.page
          .locator(
            `[data-test-id="${GEMINI_SEND_BUTTON_CONTAINER_TEST_ID}"] button`
          )
          .first()
        // wait sendable
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
          if (!this.isTargetStreamRequest(request)) {
            return
          }
          resolveRequestStarted()
        }

        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetStreamRequest(request)) {
            return
          }
          resolveRequestStarted()
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          settleTargetResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `Gemini request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'gemini_submit_request_failed',
              }
            ),
          })
        }

        const handleResponse = async (
          response: import('playwright').Response
        ) => {
          if (!this.isTargetStreamRequest(response.request())) {
            return
          }
          this.emitSubmitActivitySafely()
          resolveRequestStarted()
          if (response.status() !== 200) {
            return
          }

          let raw: string
          try {
            raw = await response.text()
          } catch {
            return
          }

          const parsedResponse = await this.parseResponse(raw)
          if (!parsedResponse) {
            return
          }

          this.lastParsedResponse = parsedResponse
          settleTargetResponse({ kind: 'resolve', response })
        }
        const onResponse = (response: import('playwright').Response) => {
          void handleResponse(response).catch((error) => {
            settleTargetResponse({ kind: 'reject', error })
          })
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
            () => new Error('Timed out waiting for Gemini response payload.'),
            { signal }
          )
        } finally {
          stopSubmitTextPolling()
          stopWarningTimer()
          this.page.off('request', onRequest)
          this.page.off('requestfailed', onRequestFailed)
          this.page.off('response', onResponse)
          this.page.off('close', onClose)
        }
        if (!this.lastParsedResponse) {
          throw new ProviderAdapterError(
            'submit',
            'Failed to parse Gemini response.',
            {
              kind: 'protocol',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'gemini_response_parse_failed',
            }
          )
        }
        await this.emitSubmitText(this.lastParsedResponse.text)
        await this.waitForMicrophoneReady(
          'submit',
          this.getSubmitResponseTimeoutMs(),
          signal
        )
        throwIfAborted(signal)
        return this.lastParsedResponse.text
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes('waitasync timed out')
      ) {
        throw new ProviderAdapterError(
          'submit',
          'Gemini finished responding, but the page did not become ready for the next message.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'gemini_microphone_button_missing',
            cause: error,
          }
        )
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'Gemini submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'gemini_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private async parseResponse(
    raw: string
  ): Promise<GeminiParsedResponse | null> {
    const results: GeminiParsedResponse[] = []
    let title: string | undefined
    const isInternalGeminiImageUrl = (url: string): boolean =>
      url.includes('googleusercontent.com/image_collection/image_retrieval/') ||
      url.includes('googleusercontent.com/image_generation_content/')
    const isHttpUrl = (value: unknown): value is string =>
      typeof value === 'string' && /^https?:\/\//.test(value)
    const parseJsonLenient = (value: string): unknown => {
      try {
        return JSON.parse(value)
      } catch {
        return JSON.parse(escapeBareJsonStringLineBreaks(value))
      }
    }
    const escapeBareJsonStringLineBreaks = (value: string): string => {
      let result = ''
      let inString = false
      let isEscaped = false

      for (let index = 0; index < value.length; index += 1) {
        const char = value[index]
        if (!inString) {
          result += char
          if (char === '"') {
            inString = true
          }
          continue
        }

        if (isEscaped) {
          result += char
          isEscaped = false
          continue
        }

        if (char === '\\') {
          result += char
          isEscaped = true
          continue
        }

        if (char === '"') {
          result += char
          inString = false
          continue
        }

        if (char === '\r') {
          if (value[index + 1] === '\n') {
            index += 1
          }
          result += '\\n'
          continue
        }

        if (char === '\n') {
          result += '\\n'
          continue
        }

        result += char
      }

      return result
    }
    const readFirstUrl = (value: unknown): string | undefined => {
      if (isHttpUrl(value)) {
        return value
      }
      if (!Array.isArray(value)) {
        return undefined
      }
      for (const item of value) {
        const url = readFirstUrl(item)
        if (url !== undefined) {
          return url
        }
      }
      return undefined
    }
    const collectPlaceholderImageQueues = (
      value: unknown
    ): {
      placeholderImageQueues: Map<string, string[]>
      orderedImageUrls: string[]
    } => {
      const placeholderImageQueues = new Map<string, string[]>()
      const orderedImageUrls: string[] = []

      const visit = (node: unknown): void => {
        if (!Array.isArray(node)) {
          return
        }

        const imageUrl = readFirstUrl(node[0])
        const placeholderUrl = readFirstUrl(node[7]) ?? readFirstUrl(node[1])

        if (
          imageUrl !== undefined &&
          placeholderUrl !== undefined &&
          isHttpUrl(imageUrl) &&
          !isInternalGeminiImageUrl(imageUrl) &&
          isInternalGeminiImageUrl(placeholderUrl)
        ) {
          const queue = placeholderImageQueues.get(placeholderUrl) ?? []
          queue.push(imageUrl)
          placeholderImageQueues.set(placeholderUrl, queue)
          if (!orderedImageUrls.includes(imageUrl)) {
            orderedImageUrls.push(imageUrl)
          }
        }

        for (const child of node) {
          visit(child)
        }
      }

      visit(value)
      return {
        placeholderImageQueues,
        orderedImageUrls,
      }
    }
    const extractJsonChunks = (value: string): string[] => {
      const chunks: string[] = []

      for (let i = 0; i < value.length; i++) {
        if (value.startsWith(")]}'", i)) {
          i += 3
          continue
        }

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
    const chunks = extractJsonChunks(raw)
    for (const chunk of chunks) {
      let outerValue: unknown
      try {
        outerValue = parseJsonLenient(chunk)
      } catch {
        continue
      }
      const outer = asUnknownArray(outerValue)
      if (outer === null) continue
      for (const item of outer) {
        const itemParts = asUnknownArray(item)
        if (itemParts === null || itemParts[0] !== 'wrb.fr') continue
        const encodedInner = itemParts[2]
        if (typeof encodedInner !== 'string') continue
        let innerValue: unknown
        try {
          innerValue = parseJsonLenient(encodedInner)
        } catch {
          continue
        }
        const inner = asUnknownArray(innerValue)
        if (inner === null) continue

        const identifiers = asUnknownArray(inner[1])
        const rawConversationId = identifiers?.[0]
        const conversationId = normalizeGeminiConversationId(
          typeof rawConversationId === 'string' ? rawConversationId : undefined
        )
        const rawResponseId = identifiers?.[1]
        const responseId =
          typeof rawResponseId === 'string' ? rawResponseId : undefined

        const metadata = asUnknownRecord(inner[2])
        const titleParts = asUnknownArray(metadata?.['11'])
        if (typeof titleParts?.[0] === 'string' && titleParts[0]) {
          title = titleParts[0]
        }

        const innerRoot = asUnknownArray(inner[0])
        const innerRootEntry = asUnknownArray(innerRoot?.[0])
        const embeddedCandidates = asUnknownArray(innerRootEntry?.[3])
        const rawCandidates = embeddedCandidates ?? asUnknownArray(inner[4])
        if (rawCandidates === null) continue
        const candidates = rawCandidates.every(
          (candidate) =>
            asUnknownArray(candidate) !== null &&
            typeof asUnknownArray(candidate)?.[0] === 'string'
        )
          ? rawCandidates
          : rawCandidates.flatMap((group) => asUnknownArray(group) ?? [])
        for (const candidateValue of candidates) {
          const candidate = asUnknownArray(candidateValue)
          if (candidate === null) continue
          const candidateId =
            typeof candidate[0] === 'string' ? candidate[0] : undefined
          const rawText =
            typeof candidate[1] === 'string'
              ? candidate[1]
              : asUnknownArray(candidate[1]) !== null
                ? (asUnknownArray(candidate[1]) ?? [])
                    .filter((part) => typeof part === 'string')
                    .join('')
                : undefined
          const { placeholderImageQueues, orderedImageUrls } =
            collectPlaceholderImageQueues(candidate[12])
          const text =
            typeof rawText === 'string'
              ? placeholderImageQueues.size > 0
                ? (() => {
                    const usedImageUrls: string[] = []
                    const replacedText = rawText.replace(
                      /https?:\/\/googleusercontent\.com\/(?:image_collection\/image_retrieval|image_generation_content)\/\S+/g,
                      (matchedUrl) => {
                        const queue = placeholderImageQueues.get(matchedUrl)
                        const imageUrl = queue?.shift()
                        if (imageUrl !== undefined) {
                          usedImageUrls.push(imageUrl)
                          return imageUrl
                        }
                        return matchedUrl
                      }
                    )
                    const remainingImageUrls = orderedImageUrls.filter(
                      (url) =>
                        !usedImageUrls.includes(url) &&
                        !replacedText.includes(url)
                    )
                    return remainingImageUrls.length > 0
                      ? `${replacedText}\n${remainingImageUrls.join('\n')}`
                      : replacedText
                  })()
                : rawText
              : rawText
          if (typeof text !== 'string' || !text.trim()) {
            continue
          }
          const statusParts = asUnknownArray(candidate[8])
          const status = statusParts?.[0] ?? candidate[8]
          results.push({
            ...(conversationId !== undefined ? { conversationId } : {}),
            ...(responseId !== undefined ? { responseId } : {}),
            ...(candidateId !== undefined ? { candidateId } : {}),
            ...(title !== undefined ? { title } : {}),
            text,
            isFinished: status === 2,
          })
        }
      }
    }
    return this.pickBestParsedResponse(results)
  }

  public get conversationId(): string | null {
    return (
      normalizeGeminiConversationId(this.lastParsedResponse?.conversationId) ??
      null
    )
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${GEMINI_CHAT_URL}/${this.conversationId}`
        : GEMINI_CHAT_URL
    ).toString()
  }
}
