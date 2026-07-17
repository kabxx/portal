import type { Locator } from 'playwright'

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

const KIMI_CHAT_URL = 'https://www.kimi.com'
const KIMI_INPUT_SELECTOR =
  '.chat-editor .chat-input-editor[contenteditable="true"]'
const KIMI_SEND_SELECTOR = '.chat-editor .send-button-container'
const KIMI_STOP_SELECTOR = '.chat-editor .send-button-container.stop'
const KIMI_MODEL_TRIGGER_SELECTOR = '.chat-editor .current-model'
const KIMI_MODEL_MENU_SELECTOR = '.models-popover'
const KIMI_MODEL_ITEM_SELECTOR = '.models-popover .model-item'
const KIMI_TOOLKIT_TRIGGER_SELECTOR = '.chat-editor .toolkit-trigger-btn'
const KIMI_TOOLKIT_POPOVER_SELECTOR = '.toolkit-popover'
const KIMI_SEARCH_ITEM_SELECTOR =
  '.toolkit-popover .toolkit-item:has(svg[name="InternetOn"])'
const KIMI_SEARCH_POPOVER_SELECTOR = '.connect-popover'
const KIMI_SEARCH_OPTION_SELECTOR = '.connect-popover .connect-item'
const KIMI_SELECTED_OPTION_ICON_SELECTOR = 'svg[name="Check"]'
const KIMI_SEARCH_STORAGE_KEY = 'selectSearch'
const KIMI_FILE_INPUT_SELECTOR = '.toolkit-popover input[type="file"]'
const KIMI_FILE_CARD_SELECTOR = '.chat-editor .file-card-container'
const KIMI_SIGNED_OUT_SELECTOR = 'button.next-sidebar-history-list__login'
const KIMI_ASSISTANT_TEXT_SELECTOR = '.segment.segment-assistant .markdown'
const KIMI_CHAT_REQUEST_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const KIMI_HISTORY_REQUEST_PATH =
  '/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages'
const KIMI_USER_REQUEST_PATH = '/api/user'
const KIMI_HISTORY_PAGE_SIZE = 100
const KIMI_FILE_UPLOAD_TIMEOUT_MS = 30_000
const KIMI_CAPABILITY_UI_TIMEOUT_MS = 5_000

export type KimiToggleCapability = 'search'
export type KimiToggleState = 'on' | 'off'

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
  error: KimiStreamError | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeToPathArray(path: string | readonly string[]): string[] {
  return typeof path === 'string' ? [path] : [...path]
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
    const blocks = Array.isArray(message.blocks) ? message.blocks : []
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
  let assistantMessageId: string | null = null
  let streamError: KimiStreamError | null = null

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isRecord(value)) return

    const messageId = readString(value.id)
    const isAssistant = value.role === 'assistant'
    if (isAssistant && messageId !== null && assistantMessageId === null) {
      assistantMessageId = messageId
    }
    const status = readString(value.status)
    if (
      status?.startsWith('MESSAGE_STATUS_') &&
      messageId !== null &&
      messageId === assistantMessageId
    ) {
      statuses.add(status)
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
    Object.values(value).forEach(visit)
  }

  extractKimiJsonObjects(raw).forEach(visit)
  return {
    isFinished: statuses.has('MESSAGE_STATUS_COMPLETED'),
    statuses: [...statuses],
    error: streamError,
  }
}

export class KimiAdapter extends ProviderAdapter {
  private conversationIdVal!: string | null
  private pendingTextVal = ''

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

  private async isSignedOutVisible(): Promise<boolean> {
    const targets = this.page.locator(KIMI_SIGNED_OUT_SELECTOR)
    if ((await targets.count().catch(() => 0)) !== 1) return false
    return await targets
      .first()
      .isVisible()
      .catch(() => false)
  }

  private async isReady(): Promise<boolean> {
    for (const selector of [
      KIMI_INPUT_SELECTOR,
      KIMI_SEND_SELECTOR,
      KIMI_MODEL_TRIGGER_SELECTOR,
    ]) {
      const targets = this.page.locator(selector)
      if ((await targets.count().catch(() => 0)) !== 1) return false
      if (
        !(await targets
          .first()
          .isVisible()
          .catch(() => false))
      )
        return false
    }
    return true
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
          if (await this.isSignedOutVisible()) {
            finalState = 'signed_out'
            return true
          }
          const authState = await this.getAuthState(captureStartIndex)
          if (authState === 'signed_out') {
            finalState = authState
            return true
          }
          if (authState === 'signed_in' && (await this.isReady())) {
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
    if (await this.isSignedOutVisible()) return false
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

  public async changeModel(model: string): Promise<void> {
    const modelNumber = Number(model.trim())
    if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Kimi does not support model "${model}".`
      )
    }
    const modelIndex = modelNumber - 1
    const trigger = this.page.locator(KIMI_MODEL_TRIGGER_SELECTOR)
    if (
      (await trigger.count()) !== 1 ||
      !(await trigger
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'Kimi model selection is not available in the current conversation.'
      )
    }

    try {
      await trigger.first().click()
      const menu = this.page.locator(KIMI_MODEL_MENU_SELECTOR)
      await waitAsync(
        async () =>
          (await menu.count().catch(() => 0)) === 1 &&
          (await menu
            .first()
            .isVisible()
            .catch(() => false)),
        { timeoutMs: 5000 }
      )
      const items = this.page.locator(KIMI_MODEL_ITEM_SELECTOR)
      if ((await items.count()) <= modelIndex) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `Kimi does not have model ${modelNumber}.`
        )
      }
      await items.nth(modelIndex).click()
      await this.page.keyboard.press('Escape').catch(() => {})
      await trigger.first().click()
      await waitAsync(
        async () =>
          (await menu.count().catch(() => 0)) === 1 &&
          (await menu
            .first()
            .isVisible()
            .catch(() => false)),
        { timeoutMs: 5000 }
      )
      const selectedClass =
        (await this.page
          .locator(KIMI_MODEL_ITEM_SELECTOR)
          .nth(modelIndex)
          .getAttribute('class')) ?? ''
      if (!selectedClass.split(/\s+/).includes('checked')) {
        throw new ProviderAdapterError(
          'changeModel',
          `Kimi did not verify model ${modelNumber} as selected.`,
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_model_selection_unverified',
          }
        )
      }
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {})
    }
  }

  private async closeToolkitMenu(): Promise<void> {
    const isClosed = async () => {
      for (const selector of [
        KIMI_TOOLKIT_POPOVER_SELECTOR,
        KIMI_SEARCH_POPOVER_SELECTOR,
      ]) {
        const popovers = this.page.locator(selector)
        if (
          (await popovers.count().catch(() => 0)) > 0 &&
          (await popovers
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          return false
        }
      }
      return true
    }
    await this.page.keyboard.press('Escape').catch(() => {})
    const composers = this.page.locator(KIMI_INPUT_SELECTOR)
    if (
      (await composers.count().catch(() => 0)) === 1 &&
      (await composers
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      await composers.first().click()
    }
    await waitAsync(isClosed, { timeoutMs: KIMI_CAPABILITY_UI_TIMEOUT_MS })
    await delayAsync(100)
  }

  private async openSearchOptions(): Promise<Locator | null> {
    await this.closeToolkitMenu()
    const trigger = this.page.locator(KIMI_TOOLKIT_TRIGGER_SELECTOR)
    if ((await trigger.count().catch(() => 0)) !== 1) return null
    const triggerTarget = trigger.first()
    if (
      !(await triggerTarget.isVisible().catch(() => false)) ||
      !(await triggerTarget.isEnabled().catch(() => false))
    ) {
      return null
    }
    await triggerTarget.click()
    await waitAsync(
      async () => {
        const popovers = this.page.locator(KIMI_TOOLKIT_POPOVER_SELECTOR)
        return (
          (await popovers.count().catch(() => 0)) === 1 &&
          (await popovers
            .first()
            .isVisible()
            .catch(() => false))
        )
      },
      {
        timeoutMs: KIMI_CAPABILITY_UI_TIMEOUT_MS,
        onTimeout: async () => {},
      }
    )
    const searchItems = this.page.locator(KIMI_SEARCH_ITEM_SELECTOR)
    if ((await searchItems.count().catch(() => 0)) !== 1) return null
    const searchItem = searchItems.first()
    if (
      !(await searchItem.isVisible().catch(() => false)) ||
      !(await searchItem.isEnabled().catch(() => false))
    ) {
      return null
    }
    await searchItem.click()
    await waitAsync(
      async () => {
        const popovers = this.page.locator(KIMI_SEARCH_POPOVER_SELECTOR)
        return (
          (await popovers.count().catch(() => 0)) === 1 &&
          (await popovers
            .first()
            .isVisible()
            .catch(() => false))
        )
      },
      {
        timeoutMs: KIMI_CAPABILITY_UI_TIMEOUT_MS,
        onTimeout: async () => {},
      }
    )
    const options = this.page.locator(KIMI_SEARCH_OPTION_SELECTOR)
    if ((await options.count().catch(() => 0)) !== 2) return null
    for (let index = 0; index < 2; index += 1) {
      const option = options.nth(index)
      if (
        !(await option.isVisible().catch(() => false)) ||
        !(await option.isEnabled().catch(() => false))
      ) {
        return null
      }
    }
    return options
  }

  private async readSearchToggleSnapshot(options: Locator): Promise<{
    state: KimiToggleState
    selectedOptionIndex: number
  } | null> {
    const selectedOptionIndexes: number[] = []
    for (let index = 0; index < 2; index += 1) {
      const icons = options
        .nth(index)
        .locator(KIMI_SELECTED_OPTION_ICON_SELECTOR)
      const iconCount = await icons.count().catch(() => 0)
      if (iconCount > 1) return null
      if (
        iconCount === 1 &&
        (await icons
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        selectedOptionIndexes.push(index)
      }
    }
    if (selectedOptionIndexes.length !== 1) return null

    const storedState = await this.page
      .evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        KIMI_SEARCH_STORAGE_KEY
      )
      .catch(() => null)
    if (storedState !== 'true' && storedState !== 'false') return null
    return {
      state: storedState === 'true' ? 'on' : 'off',
      selectedOptionIndex: selectedOptionIndexes[0]!,
    }
  }

  private createSearchStateMissingError(action: 'searchStatus' | 'searchSet') {
    return new ProviderAdapterError(
      action,
      'Kimi search did not expose one verifiable selected state.',
      {
        kind: 'ui',
        recovery: 'none',
        retryable: false,
        detailCode: 'kimi_search_state_missing',
      }
    )
  }

  public async hasToggleCapability(capability: string): Promise<boolean> {
    if (capability !== 'search') return false
    return await this.wrapAdapterActionErrorAsync(
      'searchAvailable',
      async () => {
        try {
          const options = await this.openSearchOptions()
          return (
            options !== null &&
            (await this.readSearchToggleSnapshot(options)) !== null
          )
        } finally {
          await this.closeToolkitMenu()
        }
      }
    )
  }

  public async getToggleState(capability: string): Promise<KimiToggleState> {
    if (capability !== 'search') {
      throw new ProviderAdapterUnsupportedError(
        'searchStatus',
        'Kimi search capability is not available on this page.'
      )
    }
    return await this.wrapAdapterActionErrorAsync('searchStatus', async () => {
      try {
        const options = await this.openSearchOptions()
        if (options === null) {
          throw new ProviderAdapterUnsupportedError(
            'searchStatus',
            'Kimi search capability is not available on this page.'
          )
        }
        const snapshot = await this.readSearchToggleSnapshot(options)
        if (snapshot === null) {
          throw this.createSearchStateMissingError('searchStatus')
        }
        return snapshot.state
      } finally {
        await this.closeToolkitMenu()
      }
    })
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
    return await this.wrapAdapterActionErrorAsync('searchSet', async () => {
      try {
        const options = await this.openSearchOptions()
        if (options === null) {
          throw new ProviderAdapterUnsupportedError(
            'searchSet',
            'Kimi search capability is not available on this page.'
          )
        }
        const currentSnapshot = await this.readSearchToggleSnapshot(options)
        if (currentSnapshot === null) {
          throw this.createSearchStateMissingError('searchSet')
        }
        if (currentSnapshot.state === targetState) return currentSnapshot.state

        const targetOptionIndex =
          currentSnapshot.selectedOptionIndex === 0 ? 1 : 0
        await options.nth(targetOptionIndex).click()
        await waitAsync(
          async () => {
            const snapshot = await this.readSearchToggleSnapshot(options)
            return (
              snapshot?.state === targetState &&
              snapshot.selectedOptionIndex === targetOptionIndex
            )
          },
          {
            timeoutMs: KIMI_CAPABILITY_UI_TIMEOUT_MS,
            onTimeout: async () => {
              throw new ProviderAdapterError(
                'searchSet',
                `Kimi did not verify search as ${targetState}.`,
                {
                  kind: 'ui',
                  recovery: 'none',
                  retryable: false,
                  detailCode: 'kimi_search_state_unverified',
                }
              )
            },
          }
        )
        return targetState
      } finally {
        await this.closeToolkitMenu()
      }
    })
  }

  private async getUniqueVisibleLocator(
    selector: string
  ): Promise<Locator | null> {
    const targets = this.page.locator(selector)
    if ((await targets.count().catch(() => 0)) !== 1) return null
    const target = targets.first()
    return (await target.isVisible().catch(() => false)) ? target : null
  }

  public async attachText(text: string): Promise<void> {
    const input = await this.getUniqueVisibleLocator(KIMI_INPUT_SELECTOR)
    if (input === null) {
      throw new ProviderAdapterError(
        'attachText',
        'Kimi Composer is missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'restore',
          retryable: false,
          detailCode: 'kimi_composer_missing',
        }
      )
    }
    await input.click()
    await this.page.keyboard.insertText(text)
    this.pendingTextVal += text
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const paths = normalizeToPathArray(path)
    const trigger = await this.getUniqueVisibleLocator(
      KIMI_TOOLKIT_TRIGGER_SELECTOR
    )
    if (trigger === null) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'Kimi file upload is not available in the current conversation.'
      )
    }
    await trigger.click()
    const input = this.page.locator(KIMI_FILE_INPUT_SELECTOR)
    await waitAsync(async () => (await input.count().catch(() => 0)) === 1, {
      timeoutMs: 5000,
    })
    const cards = this.page.locator(KIMI_FILE_CARD_SELECTOR)
    const cardCountBeforeUpload = await cards.count()
    await input.first().setInputFiles(paths)
    await waitAsync(
      async () => {
        if (
          (await cards.count().catch(() => 0)) <
          cardCountBeforeUpload + paths.length
        ) {
          return false
        }
        for (let index = 0; index < paths.length; index += 1) {
          const className =
            (await cards
              .nth(cardCountBeforeUpload + index)
              .getAttribute('class')
              .catch(() => null)) ?? ''
          const classNames = className.split(/\s+/)
          if (
            classNames.some((value) =>
              ['error', 'failed', 'failure'].includes(value)
            )
          ) {
            throw new ProviderAdapterError(
              'attachFile',
              'Kimi file upload failed before submission.',
              {
                kind: 'ui',
                recovery: 'none',
                retryable: false,
                detailCode: 'kimi_file_upload_failed',
              }
            )
          }
          if (!classNames.includes('success')) return false
        }
        return true
      },
      {
        timeoutMs: KIMI_FILE_UPLOAD_TIMEOUT_MS,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            'attachFile',
            'Kimi file upload did not finish before submission.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              detailCode: 'kimi_file_upload_incomplete',
            }
          )
        },
      }
    )
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(this.page.locator(KIMI_STOP_SELECTOR))
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('Kimi')
  }

  private async readCurrentAssistantText(
    assistantCountBeforeSubmit: number
  ): Promise<string | null> {
    const assistants = this.page.locator(KIMI_ASSISTANT_TEXT_SELECTOR)
    if ((await assistants.count().catch(() => 0)) <= assistantCountBeforeSubmit)
      return null
    const text =
      (
        await assistants
          .last()
          .textContent()
          .catch(() => null)
      )?.trim() ?? ''
    return text || null
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
    const deadline = Date.now() + this.getSubmitResponseTimeoutMs()
    while (Date.now() < deadline) {
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
      if (target?.done) return target
      if (target !== undefined) {
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
    let stopTextPolling = () => {}
    let onRequest: ((request: import('playwright').Request) => void) | null =
      null
    let onResponse: ((response: import('playwright').Response) => void) | null =
      null
    try {
      throwIfAborted(signal)
      const send = await this.getUniqueVisibleLocator(
        `${KIMI_SEND_SELECTOR}:not(.disabled):not(.stop)`
      )
      if (send === null) {
        throw new ProviderAdapterError(
          'submit',
          'Kimi send control is missing, disabled, or ambiguous.',
          {
            kind: 'ui',
            recovery: 'restore',
            retryable: false,
            detailCode: 'kimi_send_control_unavailable',
          }
        )
      }

      const captureStartIndex = await this.getCapturedFetchEntryCount()
      const assistantCountBeforeSubmit = await this.page
        .locator(KIMI_ASSISTANT_TEXT_SELECTOR)
        .count()
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
      stopTextPolling = this.startSubmitTextPolling(
        async () =>
          await this.readCurrentAssistantText(assistantCountBeforeSubmit)
      )

      dispatchStarted = true
      await send.click()
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
          'Kimi response ended without an assistant completion status.',
          {
            kind: 'protocol',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_response_incomplete',
          }
        )
      }

      await waitAsync(
        async () =>
          (await this.isReady()) &&
          !(await this.page.locator(KIMI_STOP_SELECTOR).count()),
        { timeoutMs: this.getSubmitResponseTimeoutMs(), signal }
      )
      const text = await this.readCurrentAssistantText(
        assistantCountBeforeSubmit
      )
      if (text === null) {
        throw new ProviderAdapterError(
          'submit',
          'Kimi completed without visible assistant text.',
          {
            kind: 'protocol',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_response_text_missing',
          }
        )
      }

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
      stopTextPolling()
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
