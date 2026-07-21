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
import type { Locator } from 'playwright'
import {
  emptyHistoryResult,
  parseDoubaoHistory,
} from '../conversation-history.ts'

const DOUBAO_CHAT_URL = 'https://www.doubao.com/chat'
const DOUBAO_CHAT_COMPLETION_URL = 'https://www.doubao.com/chat/completion'
const DOUBAO_UPLOAD_TRIGGER_SELECTOR = [
  'button[data-dbx-name="button"]:has(svg path[d^="M12.0005 2.25"])',
  'button[data-dbx-name="button"]:has(svg path[d^="M12.0005 2.44971"])',
].join(', ')
const DOUBAO_FILE_INPUT_SELECTOR = 'input[type="file"]'
const DOUBAO_READY_CONTAINER_SELECTOR = 'div[class*="container-YCWnMI"]'
const DOUBAO_MODEL_TRIGGER_SELECTOR =
  'button[data-dbx-name="button"]:has(img[src*="mode_"])'
const DOUBAO_MODEL_MENU_SELECTOR = 'div[data-slot="dropdown-menu-content"]'
const DOUBAO_TOOLBAR_SELECTOR =
  '[style*="--chat-input-tool-button-overflow-list-gap"]'
const DOUBAO_SELECTED_SKILL_SELECTOR =
  '[class*="text-g-exit-skill-btn-text"][data-value]'
const DOUBAO_OVERFLOW_POPOVER_SELECTOR =
  '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"]'
const DOUBAO_DESKTOP_PROMOTION_CLOSE_SELECTOR =
  'xpath=//img[contains(@src, "/obj/flow-doubao/samantha/jianti.png")]/preceding-sibling::button[@type="button"][1]'
const DOUBAO_DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS = 5000
const DOUBAO_HISTORY_POLL_MS = 100
const DOUBAO_STOP_ICON_PATH_PREFIX = 'M12 0.5C18.3513 0.5 23.5 5.64873 23.5 12'
const DOUBAO_STOP_BUTTON_SELECTORS = [
  `div.break-btn-fISNgC:has(svg[viewBox^="0 0 24"] path[d^="${DOUBAO_STOP_ICON_PATH_PREFIX}"])`,
]

export type DoubaoActionCapability = string

export type DoubaoActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

export interface DoubaoActionCapabilityInfo {
  name: string
  state: DoubaoActionCapabilityState
}

const DOUBAO_DISABLED_ACTION_CAPABILITIES = new Set<DoubaoActionCapability>([
  'meeting_record',
])

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

interface PageWithEvaluate {
  evaluate(fn: (() => unknown) | string): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function hasPageEvaluate(value: unknown): value is PageWithEvaluate {
  return isRecord(value) && typeof value.evaluate === 'function'
}

const DOUBAO_ACTION_BAR_INPUT_ITEMS_SOURCE = String.raw`(() => {
  let requireModule = null
  ;(self.__LOADABLE_LOADED_CHUNKS__ = self.__LOADABLE_LOADED_CHUNKS__ || []).push([
    ['portal_action_bar_state_' + Date.now()],
    {},
    (runtimeRequire) => {
      requireModule = runtimeRequire
    },
  ])

  const storeMod = requireModule?.(908913)
  const state =
    storeMod?.GX?.('chatInputStore') ||
    storeMod?.Wp?.('chatInputStore')?.getState?.()
  if (!state || !Array.isArray(state.inputSkills)) {
    return []
  }

  const inputItems = []
  for (const item of state.inputSkills) {
    const skillType = item?.skill_type
    const skill = state.skillMap?.[skillType]
    const configKey = skill?.config_key
    if (typeof configKey !== 'string' || !configKey.trim()) {
      continue
    }

    const name = skill?.show_name || skill?.name_v2 || skill?.name || configKey
    inputItems.push({
      configKey: configKey.trim(),
      name,
      skillKey: skill?.skill_key,
    })
  }

  return inputItems
})()`

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

function normalizeToPathArray(path: string | readonly string[]): string[] {
  if (typeof path === 'string') {
    return [path]
  }
  return [...path]
}

export class DoubaoAdapter extends ProviderAdapter {
  private lastParsedResponse!: DoubaoParsedResponse | null

  private getSendButton() {
    return this.page.locator('button[class*="bg-g-send-msg-btn-bg"]').last()
  }

  private getReadyContainer() {
    return this.page.locator(DOUBAO_READY_CONTAINER_SELECTOR)
  }

  private getToolbar() {
    return this.page.locator(DOUBAO_TOOLBAR_SELECTOR).first()
  }

  private getSelectedSkillChip() {
    return this.page.locator(DOUBAO_SELECTED_SKILL_SELECTOR).first()
  }

  private getOverflowTrigger() {
    return this.getToolbar()
      .locator(
        'div[aria-haspopup="dialog"][aria-controls][data-state] > button[data-dbx-name="button"]'
      )
      .first()
  }

  private getOverflowPopover() {
    return this.page.locator(DOUBAO_OVERFLOW_POPOVER_SELECTOR).first()
  }

  private async dismissDesktopPromotion(
    action: 'attachText' | 'submit',
    signal?: AbortSignal
  ): Promise<void> {
    const closeButton = this.page
      .locator(DOUBAO_DESKTOP_PROMOTION_CLOSE_SELECTOR)
      .first()
    if (!(await closeButton.isVisible().catch(() => false))) {
      return
    }

    throwIfAborted(signal)
    try {
      await closeButton.click({
        timeout: DOUBAO_DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS,
      })
    } catch (error) {
      throw new ProviderAdapterError(
        action,
        'Doubao desktop promotion is visible but could not be dismissed.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_desktop_promotion_dismiss_failed',
          cause: error,
        }
      )
    }

    await waitAsync(
      async () => !(await closeButton.isVisible().catch(() => false)),
      {
        timeoutMs: DOUBAO_DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            'Doubao desktop promotion is visible but could not be dismissed.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'doubao_desktop_promotion_dismiss_failed',
            }
          )
        },
      }
    )
  }

  private getVisibleActionButtons() {
    return this.getToolbar().locator(
      'button[data-component-type="skill-item"][data-input-engine-action-source="actionbar"]'
    )
  }

  private getOverflowActionButtons() {
    return this.getOverflowPopover().locator(
      'button[data-input-engine-action-source="actionbar"]'
    )
  }

  private readActionCapabilityNameFromInputItem(
    value: unknown
  ): DoubaoActionCapability | null {
    if (!isRecord(value)) {
      return null
    }

    return typeof value.configKey === 'string' && value.configKey.trim()
      ? value.configKey.trim()
      : null
  }

  private normalizeActionCapabilityOrder(
    values: readonly unknown[]
  ): DoubaoActionCapability[] {
    const order: DoubaoActionCapability[] = []
    for (const value of values) {
      const capability = this.readActionCapabilityNameFromInputItem(value)
      if (capability && !order.includes(capability)) {
        order.push(capability)
      }
    }
    return order
  }

  private async readActionBarInputItems(): Promise<readonly unknown[]> {
    const page: unknown = this.page
    if (!hasPageEvaluate(page)) {
      throw new ProviderAdapterError(
        'selectCapability',
        'Doubao action bar data is not available on this page.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_action_bar_data_unavailable',
        }
      )
    }

    let inputItems: unknown
    try {
      inputItems = await page.evaluate(DOUBAO_ACTION_BAR_INPUT_ITEMS_SOURCE)
    } catch (error) {
      throw new ProviderAdapterError(
        'selectCapability',
        'Doubao action bar state could not be read.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_action_bar_store_read_failed',
          cause: error,
        }
      )
    }

    if (!isUnknownArray(inputItems) || inputItems.length === 0) {
      throw new ProviderAdapterError(
        'selectCapability',
        'Doubao action bar state is unavailable.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_action_bar_store_missing',
        }
      )
    }

    return inputItems
  }

  private async readActionCapabilityOrder(): Promise<DoubaoActionCapability[]> {
    const inputItems = await this.readActionBarInputItems()
    const order = this.normalizeActionCapabilityOrder(inputItems)
    if (order.length === 0) {
      throw new ProviderAdapterError(
        'selectCapability',
        'Doubao action bar state does not contain usable configKey values.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_action_bar_store_config_keys_missing',
        }
      )
    }
    return order
  }

  public async listActionCapabilities(): Promise<DoubaoActionCapabilityInfo[]> {
    const order = await this.readActionCapabilityOrder()
    return order.map((capability) => ({
      name: capability,
      state: DOUBAO_DISABLED_ACTION_CAPABILITIES.has(capability)
        ? 'disabled'
        : 'available',
    }))
  }

  private async getVisibleActionButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<Locator | null> {
    const capabilityIndex = order.indexOf(capability)
    if (capabilityIndex < 0) {
      return null
    }

    const buttons = this.getVisibleActionButtons()
    const count = await buttons.count().catch(() => 0)
    if (capabilityIndex >= count) {
      return null
    }

    return buttons.nth(capabilityIndex)
  }

  private async getOverflowActionButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<Locator | null> {
    const capabilityIndex = order.indexOf(capability)
    if (capabilityIndex < 0 || !(await this.ensureOverflowPopoverOpen())) {
      return null
    }

    const visibleCount = await this.getVisibleActionButtons()
      .count()
      .catch(() => 0)
    const overflowIndex = capabilityIndex - visibleCount
    if (overflowIndex < 0) {
      return null
    }

    const buttons = this.getOverflowActionButtons()
    const overflowCount = await buttons.count().catch(() => 0)
    if (overflowIndex >= overflowCount) {
      return null
    }

    return buttons.nth(overflowIndex)
  }

  private async ensureOverflowPopoverOpen(): Promise<boolean> {
    const popover = this.getOverflowPopover()
    if (await popover.isVisible().catch(() => false)) {
      return true
    }

    const trigger = this.getOverflowTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) {
      return false
    }

    await trigger.click()
    await waitAsync(async () => await popover.isVisible().catch(() => false), {
      timeoutMs: 5000,
    })
    return true
  }

  private async openOverflowPopoverIfPresent(): Promise<void> {
    if (
      await this.getOverflowPopover()
        .isVisible()
        .catch(() => false)
    ) {
      return
    }

    const trigger = this.getOverflowTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) {
      return
    }

    await trigger.click()
    await waitAsync(
      async () =>
        await this.getOverflowPopover()
          .isVisible()
          .catch(() => false),
      {
        timeoutMs: 5000,
      }
    )
  }

  private async cancelSelectedActionCapability(): Promise<void> {
    const selectedSkill = this.getSelectedSkillChip()
    if ((await selectedSkill.count().catch(() => 0)) === 0) {
      return
    }

    await selectedSkill.locator('svg').locator('..').click()
  }

  private async clickActionCapabilityButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<boolean> {
    const visibleButton = await this.getVisibleActionButton(capability, order)
    if (visibleButton !== null) {
      await visibleButton.click()
      return true
    }

    const overflowButton = await this.getOverflowActionButton(capability, order)
    if (overflowButton !== null) {
      await overflowButton.click()
      return true
    }

    return false
  }

  public async getActionCapabilityState(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    const order = await this.readActionCapabilityOrder()
    if (DOUBAO_DISABLED_ACTION_CAPABILITIES.has(capability)) {
      return 'disabled'
    }

    if ((await this.getVisibleActionButton(capability, order)) !== null) {
      return 'available'
    }

    if ((await this.getOverflowActionButton(capability, order)) !== null) {
      return 'available'
    }

    return 'unavailable'
  }

  public async clearActionCapability(): Promise<void> {
    await this.wrapAdapterActionErrorAsync('clearCapability', async () => {
      await this.cancelSelectedActionCapability()
    })
  }

  public async selectActionCapability(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => {
        const order = await this.readActionCapabilityOrder()
        if (DOUBAO_DISABLED_ACTION_CAPABILITIES.has(capability)) {
          return 'disabled'
        }

        await this.cancelSelectedActionCapability()

        await this.openOverflowPopoverIfPresent()

        if (await this.clickActionCapabilityButton(capability, order)) {
          return 'selected'
        }

        return 'unavailable'
      }
    )
  }

  private async waitForReadyContainer(
    action: 'restore' | 'submit',
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const readyContainers = this.getReadyContainer()
        if ((await readyContainers.count().catch(() => 0)) !== 1) return false
        return await readyContainers
          .first()
          .isVisible()
          .catch(() => false)
      },
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'Doubao did not become ready after loading.'
              : 'Doubao finished responding, but the page did not become ready for the next message.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'doubao_ready_container_missing',
            }
          )
        },
      }
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
      await this.waitForReadyContainer(
        'restore',
        this.getRestoreTimeoutMs(),
        signal
      )
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
      const scrolled = await this.page
        .evaluate(() => {
          const elements = [
            document.scrollingElement,
            ...document.querySelectorAll('*'),
          ]
          let foundScrollable = false
          for (const element of elements) {
            if (!(element instanceof HTMLElement)) continue
            if (element.scrollHeight <= element.clientHeight + 40) continue
            foundScrollable = true
            element.scrollTop = 0
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

    const loginButtonVisible = await this.page
      .locator('button.login-btn-header-CTKsn1')
      .isVisible()
      .catch(() => false)

    return !loginButtonVisible
  }

  public async changeModel(model: string): Promise<void> {
    const modelNumber = Number(model.trim())
    if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Doubao does not support model "${model}".`
      )
    }
    const index = modelNumber - 1
    await this.page.locator(DOUBAO_MODEL_TRIGGER_SELECTOR).first().click()

    const modelMenu = this.page.locator(DOUBAO_MODEL_MENU_SELECTOR).last()
    await waitAsync(
      async () => await modelMenu.isVisible().catch(() => false),
      {
        timeoutMs: 5000,
      }
    )
    const modelItems = modelMenu.locator('xpath=./div')
    if ((await modelItems.count()) <= index) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Doubao does not have model ${modelNumber}.`
      )
    }
    await modelItems.nth(index).locator('xpath=./div').click()
  }

  public async attachText(text: string) {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.dismissDesktopPromotion('attachText')
      const textarea = this.page.locator('textarea.semi-input-textarea').first()
      if (await textarea.isVisible().catch(() => false)) {
        await textarea.click()
      } else {
        await this.page.locator('div[role="textbox"]').first().click()
      }
      await this.page.keyboard.insertText(text)
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const composer = () =>
      this.page.locator('textarea.semi-input-textarea, div[role="textbox"]')
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Doubao',
      isComposerReady: async () => await this.isRetryComposerReady(composer()),
      readComposerText: async () =>
        await this.readRetryComposerText(composer()),
      writeText: async () => await this.attachText(text),
      clearComposer: async () =>
        await this.clearRetryComposerElements(composer()),
      isStopActive: async () =>
        await this.isRetryControlActive(
          this.page.locator(DOUBAO_STOP_BUTTON_SELECTORS.join(', '))
        ),
      isSendReady: async () =>
        await this.isRetryControlReady(
          this.page.locator('button[class*="bg-g-send-msg-btn-bg"]')
        ),
    })
  }

  public async attachFile(path: string | readonly string[]) {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      const paths = normalizeToPathArray(path)
      const uploadTrigger = this.page
        .locator(DOUBAO_UPLOAD_TRIGGER_SELECTOR)
        .first()

      if ((await uploadTrigger.count()) === 0) {
        throw new ProviderAdapterError(
          'attachFile',
          `Doubao upload trigger not found: ${DOUBAO_UPLOAD_TRIGGER_SELECTOR}`,
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'doubao_upload_trigger_missing',
          }
        )
      }

      await uploadTrigger.click()

      const fileInput = this.page.locator(DOUBAO_FILE_INPUT_SELECTOR).last()
      await waitAsync(async () => (await fileInput.count()) > 0, {
        timeoutMs: 5000,
      })
      await fileInput.setInputFiles(paths)
    })
  }

  public async attachImage(path: string | readonly string[]) {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    for (const selector of DOUBAO_STOP_BUTTON_SELECTORS) {
      const clicked = await this.clickLocatorIfReady(
        this.page.locator(selector)
      )
      if (clicked) {
        return
      }
    }
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
        await this.dismissDesktopPromotion('submit', signal)
        const sendButton = this.getSendButton()
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
          await this.waitForReadyContainer(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          await this.dismissDesktopPromotion('submit', signal)
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
