import type { Locator, Request, Response } from 'playwright'
import { StringDecoder } from 'node:string_decoder'
import {
  ProviderAdapter,
  type AbortOptions,
  type CapturedFetchEntry,
  awaitWithTimeout,
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

const QWEN_CHAT_URL = 'https://chat.qwen.ai'
const QWEN_AUTH_PATH = '/api/v2/users/status'
const QWEN_COMPLETION_PATH = '/api/v2/chat/completions'
const QWEN_COMPOSER_SELECTOR = '.message-input-textarea'
const QWEN_SEND_BUTTON_SELECTOR =
  '.message-input-container button.send-button, .chat-layout-input-container button.send-button'
const QWEN_STOP_BUTTON_SELECTOR =
  '.chat-layout-input-container button.stop-button'
const QWEN_UPLOAD_TRIGGER_SELECTOR = '.mode-select-open[role="button"]'
const QWEN_UPLOAD_MENU_ITEM_SELECTOR =
  '[role="menuitem"][data-menu-id$="-upload"]'
const QWEN_MODE_MENU_SELECTOR = '.mode-select-dropdown [role="menu"]'
const QWEN_MODE_MENU_ITEM_SELECTOR = ':scope > [role="menuitem"][data-menu-id]'
const QWEN_MODE_SUBMENU_SELECTOR = '[role="menuitem"][aria-haspopup="true"]'
const QWEN_SELECTED_MODE_SELECTOR = '.mode-select-current-mode'
const QWEN_SELECTED_MODE_ICON_SELECTOR = '.mode-select-current-mode-icon use'
const QWEN_SELECTED_MODE_CLOSE_SELECTOR = '.mode-select-current-mode-close'
const QWEN_MODE_MENU_ITEM_ICON_SELECTOR = '.mode-select-dropdown-item-icon use'
const QWEN_FILE_CARD_SELECTOR = '.file-card-list .fileitem-btn'
const QWEN_FILE_PARSE_STATUS_PATH = '/api/v2/files/parse/status'
const QWEN_UPLOAD_TIMEOUT_MS = 60_000
const QWEN_CDP_SETUP_TIMEOUT_MS = 5_000
const QWEN_MODEL_TRIGGER_SELECTOR =
  '#qwen-chat-header-left [role="button"][aria-haspopup="listbox"]'
const QWEN_MODEL_LISTBOX_SELECTOR = '[role="listbox"]'
const QWEN_MODEL_OPTION_SELECTOR = '[role="option"]'

export type QwenActionCapability =
  | 'deep_research'
  | 'image_generation'
  | 'video_generation'
  | 'web_dev'
  | 'slides'
  | 'search'
  | 'artifacts'
  | 'learn'
  | 'travel'

export type QwenActionCapabilityState =
  | 'available'
  | 'selected'
  | 'cleared'
  | 'disabled'
  | 'unavailable'

export interface QwenActionCapabilityInfo {
  name: QwenActionCapability
  state: Exclude<QwenActionCapabilityState, 'cleared'>
}

const QWEN_ACTION_CAPABILITIES: readonly QwenActionCapability[] = [
  'deep_research',
  'image_generation',
  'video_generation',
  'web_dev',
  'slides',
  'search',
  'artifacts',
  'learn',
  'travel',
]
const QWEN_ACTION_CAPABILITY_MENU_IDS: Record<QwenActionCapability, string> = {
  deep_research: 'deep_research',
  image_generation: 't2i',
  video_generation: 't2v',
  web_dev: 'web_dev',
  slides: 'slides',
  search: 'search',
  artifacts: 'artifacts',
  learn: 'learn',
  travel: 'travel',
}
const QWEN_NESTED_ACTION_CAPABILITIES: readonly QwenActionCapability[] = [
  'search',
  'artifacts',
  'learn',
  'travel',
]

function isQwenActionCapability(value: string): value is QwenActionCapability {
  return (QWEN_ACTION_CAPABILITIES as readonly string[]).includes(value)
}

function createQwenCapabilityError(
  action: string,
  message: string,
  detailCode: string
): ProviderAdapterError {
  return new ProviderAdapterError(action, message, {
    kind: 'ui',
    recovery: 'none',
    retryable: false,
    maxAttempts: 1,
    detailCode,
  })
}

interface QwenOwnedRequest {
  request: Request
  chatId: string
  rawRequestBody: string
  userMessageId: string | null
  userText: string
}

interface QwenCdpStreamCapture {
  setOwnedRequestBody(body: string): void
  readResponseBody(): string | null
  isAmbiguous(): boolean
  stop(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
      await this.waitForComposer('restore', this.getRestoreTimeoutMs(), signal)
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

  public async changeModel(model: string): Promise<void> {
    const modelNumber = Number(model.trim())
    if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Qwen does not support model "${model}".`
      )
    }
    const trigger = this.page.locator(QWEN_MODEL_TRIGGER_SELECTOR)
    if ((await trigger.count()) !== 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'Qwen model selector was missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_model_trigger_invalid',
        }
      )
    }
    await trigger.first().click()

    const listboxes = this.page.locator(QWEN_MODEL_LISTBOX_SELECTOR)
    await waitAsync(
      async () =>
        (await listboxes.count().catch(() => 0)) === 1 &&
        (await listboxes
          .first()
          .isVisible()
          .catch(() => false)),
      { timeoutMs: 5000 }
    )
    const options = listboxes.first().locator(QWEN_MODEL_OPTION_SELECTOR)
    const modelIndex = modelNumber - 1
    if ((await options.count()) <= modelIndex) {
      await this.page.keyboard.press('Escape').catch(() => {})
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Qwen does not have model ${modelNumber}.`
      )
    }
    await options.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      const composer = await this.getReadyComposer('attachText')
      await composer.click()
      await this.page.keyboard.insertText(text)
      this.pendingText += text
    })
  }

  protected override async prepareRetrySubmit(
    text: string,
    options: AbortOptions
  ): Promise<() => Promise<void>> {
    const composer = () => this.page.locator(QWEN_COMPOSER_SELECTOR)
    return await this.prepareRetrySubmitText(text, options, {
      provider: 'Qwen',
      isComposerReady: async () => await this.isRetryComposerReady(composer()),
      readComposerText: async () =>
        await this.readRetryComposerText(composer()),
      writeText: async () => {
        this.pendingText = ''
        await this.attachText(text)
      },
      clearComposer: async () => {
        await this.clearRetryComposerElements(composer())
        this.pendingText = ''
      },
      isStopActive: async () =>
        await this.isRetryControlActive(
          this.page.locator(QWEN_STOP_BUTTON_SELECTOR)
        ),
      isSendReady: async () =>
        await this.isRetryControlReady(
          this.page.locator(QWEN_SEND_BUTTON_SELECTOR)
        ),
    })
  }

  public async attachFile(
    path: string | readonly string[],
    waitForTextParsing = true
  ): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      const trigger = this.page.locator(QWEN_UPLOAD_TRIGGER_SELECTOR)
      if (
        (await trigger.count()) !== 1 ||
        !(await trigger
          .first()
          .isVisible()
          .catch(() => false)) ||
        !(await trigger
          .first()
          .isEnabled()
          .catch(() => false))
      ) {
        throw new ProviderAdapterUnsupportedError(
          'attachFile',
          'Qwen file upload is not available in the current conversation.'
        )
      }
      const previousFileCount = await this.page
        .locator(QWEN_FILE_CARD_SELECTOR)
        .count()
      const expectedFileCount = typeof path === 'string' ? 1 : path.length
      await trigger.first().click()
      const uploadItems = this.page.locator(QWEN_UPLOAD_MENU_ITEM_SELECTOR)
      await waitAsync(
        async () =>
          (await uploadItems.count().catch(() => 0)) === 1 &&
          (await uploadItems
            .first()
            .isVisible()
            .catch(() => false)),
        { timeoutMs: 5000 }
      )
      const [fileChooser] = await Promise.all([
        this.page.waitForEvent('filechooser'),
        uploadItems.first().click(),
      ])
      const uploadCompleted = createDeferred<void>()
      let uploadSettled = false
      const onResponse = (response: Response) => {
        if (
          response.request().method() !== 'POST' ||
          !isQwenApiUrl(response.url(), QWEN_FILE_PARSE_STATUS_PATH)
        ) {
          return
        }
        void response
          .json()
          .then((payload: unknown) => {
            if (uploadSettled || !isRecord(payload)) return
            const rows: unknown[] = Array.isArray(payload.data)
              ? payload.data
              : []
            const statuses = rows
              .map((row) => (isRecord(row) ? row.status : null))
              .filter((status): status is string => typeof status === 'string')
            if (
              statuses.length > 0 &&
              statuses.every((status) => status === 'success')
            ) {
              uploadSettled = true
              uploadCompleted.resolve()
            } else if (
              statuses.some(
                (status) =>
                  status !== 'running' &&
                  status !== 'pending' &&
                  status !== 'success'
              )
            ) {
              uploadSettled = true
              uploadCompleted.reject(
                new ProviderAdapterError(
                  'attachFile',
                  'Qwen could not finish parsing the uploaded file.',
                  {
                    kind: 'protocol',
                    recovery: 'none',
                    retryable: false,
                    maxAttempts: 1,
                    detailCode: 'qwen_file_parse_failed',
                  }
                )
              )
            }
          })
          .catch(() => {})
      }
      this.page.on('response', onResponse)
      try {
        await fileChooser.setFiles(path)
        await Promise.all([
          waitAsync(
            async () =>
              (await this.page
                .locator(QWEN_FILE_CARD_SELECTOR)
                .count()
                .catch(() => 0)) >=
              previousFileCount + expectedFileCount,
            { timeoutMs: QWEN_UPLOAD_TIMEOUT_MS }
          ),
          ...(waitForTextParsing
            ? [
                awaitWithTimeout(
                  uploadCompleted.promise,
                  QWEN_UPLOAD_TIMEOUT_MS,
                  () =>
                    new Error(
                      'Timed out waiting for Qwen to parse the uploaded file.'
                    )
                ),
              ]
            : []),
        ])
      } finally {
        this.page.off('response', onResponse)
      }
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path, false)
  }

  private async getVisibleActionCapabilityMenu(
    action: string
  ): Promise<Locator | null> {
    const menus = this.page.locator(QWEN_MODE_MENU_SELECTOR)
    const count = await menus.count().catch(() => 0)
    let visibleMenu: Locator | null = null
    for (let index = 0; index < count; index += 1) {
      const menu = menus.nth(index)
      if (!(await menu.isVisible().catch(() => false))) continue
      if (visibleMenu !== null) {
        throw createQwenCapabilityError(
          action,
          'Qwen capability menu is ambiguous.',
          'qwen_capability_menu_ambiguous'
        )
      }
      visibleMenu = menu
    }
    return visibleMenu
  }

  private async openActionCapabilityMenu(action: string): Promise<Locator> {
    const existing = await this.getVisibleActionCapabilityMenu(action)
    if (existing !== null) return existing

    const trigger = this.page
      .locator(QWEN_UPLOAD_TRIGGER_SELECTOR)
      .filter({ visible: true })
    if (
      (await trigger.count().catch(() => 0)) !== 1 ||
      !(await trigger
        .first()
        .isEnabled()
        .catch(() => false))
    ) {
      throw createQwenCapabilityError(
        action,
        'Qwen mode menu is not available in the current conversation.',
        'qwen_capability_menu_unavailable'
      )
    }

    await trigger.first().click()
    let openedMenu: Locator | null = null
    let stableChecks = 0
    try {
      await waitAsync(
        async () => {
          try {
            const current = await this.getVisibleActionCapabilityMenu(action)
            if (current === null) {
              openedMenu = null
              stableChecks = 0
              return false
            }
            openedMenu = current
            stableChecks += 1
            return stableChecks >= 2
          } catch (error) {
            if (
              error instanceof ProviderAdapterError &&
              error.detailCode === 'qwen_capability_menu_ambiguous'
            ) {
              openedMenu = null
              stableChecks = 0
              return false
            }
            throw error
          }
        },
        { timeoutMs: 5000 }
      )
    } catch (error) {
      await this.closeActionCapabilityMenu()
      throw error
    }
    if (openedMenu === null) {
      throw createQwenCapabilityError(
        action,
        'Qwen capability menu did not open.',
        'qwen_capability_menu_missing'
      )
    }
    return openedMenu
  }

  private async expandActionCapabilitySubmenu(
    rootMenu: Locator,
    action: string
  ): Promise<Locator | null> {
    const submenu = rootMenu
      .locator(QWEN_MODE_SUBMENU_SELECTOR)
      .filter({ visible: true })
    let submenuCount = await submenu.count().catch(() => 0)
    if (submenuCount === 0) return null
    if (submenuCount !== 1) {
      await waitAsync(
        async () => (await submenu.count().catch(() => 0)) === 1,
        { timeoutMs: 1000 }
      ).catch(() => {})
      submenuCount = await submenu.count().catch(() => 0)
    }
    if (submenuCount !== 1) {
      throw createQwenCapabilityError(
        action,
        'Qwen capability submenu is ambiguous.',
        'qwen_capability_submenu_ambiguous'
      )
    }

    const submenuTrigger = submenu.first()
    const popupId = await submenuTrigger
      .getAttribute('aria-controls')
      .catch(() => null)
    if (popupId === null || !popupId.trim()) {
      throw createQwenCapabilityError(
        action,
        'Qwen capability submenu has no controlled menu.',
        'qwen_capability_submenu_owner_missing'
      )
    }
    const popup = this.page
      .locator(`[id="${popupId.replaceAll('"', '\\"')}"]`)
      .filter({ visible: true })
    await submenuTrigger.dispatchEvent('mouseover')
    await waitAsync(async () => (await popup.count().catch(() => 0)) === 1, {
      timeoutMs: 5000,
    })
    const popupMenu = popup.first()
    const popupItems = popupMenu
      .locator(QWEN_MODE_MENU_ITEM_SELECTOR)
      .filter({ visible: true })
    let previousCount = -1
    let stableChecks = 0
    await waitAsync(
      async () => {
        const itemCount = await popupItems.count().catch(() => 0)
        if (itemCount === 0) {
          previousCount = -1
          stableChecks = 0
          return false
        }
        if (itemCount === previousCount) {
          stableChecks += 1
        } else {
          previousCount = itemCount
          stableChecks = 1
        }
        return stableChecks >= 2
      },
      { timeoutMs: 5000 }
    )
    return popupMenu
  }

  private async closeActionCapabilityMenu(owner?: Locator): Promise<void> {
    const menu =
      owner ??
      (await this.getVisibleActionCapabilityMenu('closeCapabilityMenu'))
    if (menu === null || !(await menu.isVisible().catch(() => false))) {
      return
    }
    await this.page.keyboard.press('Escape')
    if (await menu.isVisible().catch(() => false)) {
      await this.page.keyboard.press('Escape')
    }
    await waitAsync(async () => !(await menu.isVisible().catch(() => false)), {
      timeoutMs: 5000,
    })
  }

  private getActionCapabilityItem(
    capability: QwenActionCapability,
    rootMenu: Locator,
    nestedMenu: Locator | null
  ) {
    const isNested = QWEN_NESTED_ACTION_CAPABILITIES.includes(capability)
    const scope = isNested && nestedMenu !== null ? nestedMenu : rootMenu
    const menuId = QWEN_ACTION_CAPABILITY_MENU_IDS[capability]
    return scope
      .locator(`${QWEN_MODE_MENU_ITEM_SELECTOR}[data-menu-id$="-${menuId}"]`)
      .filter({ visible: true })
  }

  private async readActionCapabilityIconReference(
    owner: Locator,
    action: string
  ): Promise<string> {
    const icons = owner.locator(QWEN_MODE_MENU_ITEM_ICON_SELECTOR)
    if ((await icons.count().catch(() => 0)) !== 1) {
      throw createQwenCapabilityError(
        action,
        'Qwen capability icon is missing or ambiguous.',
        'qwen_capability_icon_invalid'
      )
    }
    const icon = icons.first()
    const reference =
      (await icon.getAttribute('xlink:href').catch(() => null)) ??
      (await icon.getAttribute('href').catch(() => null))
    if (reference === null || !reference.trim()) {
      throw createQwenCapabilityError(
        action,
        'Qwen capability icon does not expose a stable reference.',
        'qwen_capability_icon_reference_missing'
      )
    }
    return reference
  }

  private async readSelectedActionIconReference(
    action: string
  ): Promise<string | null> {
    const selectedMode = this.page
      .locator(QWEN_SELECTED_MODE_SELECTOR)
      .filter({ visible: true })
    const count = await selectedMode.count().catch(() => 0)
    if (count === 0) return null
    if (count !== 1) {
      throw createQwenCapabilityError(
        action,
        'Qwen selected capability is ambiguous.',
        'qwen_selected_capability_ambiguous'
      )
    }
    const icons = selectedMode.first().locator(QWEN_SELECTED_MODE_ICON_SELECTOR)
    if ((await icons.count().catch(() => 0)) !== 1) {
      throw createQwenCapabilityError(
        action,
        'Qwen selected capability icon is missing or ambiguous.',
        'qwen_selected_capability_icon_invalid'
      )
    }
    const icon = icons.first()
    const reference =
      (await icon.getAttribute('xlink:href').catch(() => null)) ??
      (await icon.getAttribute('href').catch(() => null))
    if (reference === null || !reference.trim()) {
      throw createQwenCapabilityError(
        action,
        'Qwen selected capability icon does not expose a stable reference.',
        'qwen_selected_capability_icon_reference_missing'
      )
    }
    return reference
  }

  public async listActionCapabilities(): Promise<QwenActionCapabilityInfo[]> {
    return await this.wrapAdapterActionErrorAsync(
      'listCapabilities',
      async () => {
        const rootMenu = await this.openActionCapabilityMenu('listCapabilities')
        try {
          const nestedMenu = await this.expandActionCapabilitySubmenu(
            rootMenu,
            'listCapabilities'
          )
          const selectedIcon =
            await this.readSelectedActionIconReference('listCapabilities')
          const capabilities: QwenActionCapabilityInfo[] = []
          for (const capability of QWEN_ACTION_CAPABILITIES) {
            const item = this.getActionCapabilityItem(
              capability,
              rootMenu,
              nestedMenu
            )
            const itemCount = await item.count().catch(() => 0)
            if (itemCount === 0) {
              continue
            }
            if (itemCount !== 1) {
              throw createQwenCapabilityError(
                'listCapabilities',
                `Qwen capability item is duplicated: ${capability}.`,
                'qwen_capability_item_duplicated'
              )
            }
            const disabled =
              (await item.getAttribute('aria-disabled').catch(() => null)) ===
              'true'
            const itemIcon =
              disabled || selectedIcon === null
                ? null
                : await this.readActionCapabilityIconReference(
                    item,
                    'listCapabilities'
                  )
            capabilities.push({
              name: capability,
              state: disabled
                ? 'disabled'
                : itemIcon === selectedIcon && selectedIcon !== null
                  ? 'selected'
                  : 'available',
            })
          }
          return capabilities
        } finally {
          await this.closeActionCapabilityMenu(rootMenu)
        }
      }
    )
  }

  public async clearActionCapability(): Promise<void> {
    await this.wrapAdapterActionErrorAsync('clearCapability', async () => {
      const selectedMode = this.page
        .locator(QWEN_SELECTED_MODE_SELECTOR)
        .filter({ visible: true })
      const selectedCount = await selectedMode.count().catch(() => 0)
      if (selectedCount === 0) {
        return
      }
      if (selectedCount !== 1) {
        throw createQwenCapabilityError(
          'clearCapability',
          'Qwen selected capability is ambiguous.',
          'qwen_selected_capability_ambiguous'
        )
      }
      await selectedMode.first().hover({ force: true })
      const close = this.page
        .locator(QWEN_SELECTED_MODE_SELECTOR)
        .filter({ visible: true })
        .first()
        .locator(QWEN_SELECTED_MODE_CLOSE_SELECTOR)
        .filter({ visible: true })
      await waitAsync(async () => (await close.count().catch(() => 0)) === 1, {
        timeoutMs: 1000,
      })
      await close.first().click({ force: true })
      await waitAsync(
        async () =>
          (await this.page
            .locator(QWEN_SELECTED_MODE_SELECTOR)
            .filter({ visible: true })
            .count()
            .catch(() => 0)) === 0,
        { timeoutMs: 5000 }
      )
    })
  }

  public async selectActionCapability(
    capability: QwenActionCapability
  ): Promise<QwenActionCapabilityState> {
    return await this.wrapAdapterActionErrorAsync(
      'selectCapability',
      async () => {
        if (!isQwenActionCapability(capability)) {
          return 'unavailable'
        }

        const rootMenu = await this.openActionCapabilityMenu('selectCapability')
        try {
          const nestedMenu = await this.expandActionCapabilitySubmenu(
            rootMenu,
            'selectCapability'
          )
          const item = this.getActionCapabilityItem(
            capability,
            rootMenu,
            nestedMenu
          )
          const itemCount = await item.count().catch(() => 0)
          if (itemCount === 0) {
            return 'unavailable'
          }
          if (itemCount !== 1) {
            throw createQwenCapabilityError(
              'selectCapability',
              `Qwen capability item is duplicated: ${capability}.`,
              'qwen_capability_item_duplicated'
            )
          }
          if (
            (await item.getAttribute('aria-disabled').catch(() => null)) ===
            'true'
          ) {
            return 'disabled'
          }
          const targetIcon = await this.readActionCapabilityIconReference(
            item,
            'selectCapability'
          )
          if (
            (await this.readSelectedActionIconReference('selectCapability')) ===
            targetIcon
          ) {
            return 'selected'
          }
          await item.click({ force: true })
          await waitAsync(
            async () =>
              (await this.readSelectedActionIconReference(
                'selectCapability'
              )) === targetIcon,
            { timeoutMs: 5000 }
          )
        } finally {
          await this.closeActionCapabilityMenu(rootMenu)
        }
        return 'selected'
      }
    )
  }

  public override async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(this.page.locator(QWEN_STOP_BUTTON_SELECTOR))
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

        const composer = await this.getReadyComposer('submit')
        if ((await composer.inputValue()) !== pendingText) {
          throw new ProviderAdapterError(
            'submit',
            'Qwen Composer content no longer matches the pending Portal request.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'qwen_submit_text_mismatch',
            }
          )
        }
        const sendButton = await this.getReadySendButton(signal)
        await this.ensureSubmitAuth(signal)
        const requestStarted = createDeferred<void>()
        const targetResponse = createDeferred<Response>()
        const captureStartIndex = await this.getCapturedFetchEntryCount()
        const cdpStreamCapture = await this.createCdpSubmitStreamCapture(signal)
        let ownedRequest: QwenOwnedRequest | null = null
        let requestObserved = false
        let responseObserved = false
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let stopTextPolling: (() => void) | null = null
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
          this.pendingText = ''
          stopWarningTimer()
          requestStarted.resolve()
        }
        const settleTargetResponse = (
          resolution:
            | { kind: 'resolve'; response: Response }
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

        const onRequest = (request: Request) => {
          if (!this.isTargetCompletionRequest(request)) return
          if (ownedRequest !== null) return
          const candidate = this.readOwnedRequest(request, pendingText)
          if (candidate === null) return
          ownedRequest = candidate
          requestSubmitted = true
          resolveRequestStarted()
        }
        const onRequestFailed = (request: Request) => {
          if (ownedRequest === null || request !== ownedRequest.request) return
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          settleTargetResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `Qwen request outcome is unknown after a network failure: ${failureText}`,
              {
                kind: 'unknown',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'qwen_submit_outcome_unknown',
              }
            ),
          })
        }
        const onResponse = (response: Response) => {
          if (
            ownedRequest === null ||
            response.request() !== ownedRequest.request
          ) {
            return
          }
          this.emitSubmitActivitySafely()
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

        try {
          this.emitSubmitDispatching(signal)
          await sendButton.click()
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
            await this.ensureSubmitAuth(signal)
            const warningMessage = this.getSubmitBlockedWarningMessage()
            await this.emitSubmitStatus(warningMessage)
            warningTimer = setInterval(() => {
              void this.emitSubmitStatusSafely(warningMessage)
            }, this.getSubmitBlockedWarningIntervalMs())
            while (
              !requestObserved &&
              !responseObserved &&
              terminalError === null
            ) {
              await abortable(
                Promise.race([
                  delayAsync(1000, signal),
                  requestStarted.promise,
                  targetResponse.promise,
                ]).catch(() => {}),
                signal
              )
              if (
                !requestObserved &&
                !responseObserved &&
                terminalError === null
              ) {
                await this.ensureSubmitAuth(signal)
              }
            }
          }

          const submittedRequest = this.requireOwnedRequest(ownedRequest)
          cdpStreamCapture?.setOwnedRequestBody(submittedRequest.rawRequestBody)
          let lastCdpResponseLength = 0
          stopTextPolling = this.startSubmitTextPolling(async () => {
            const cdpBody = cdpStreamCapture?.readResponseBody() ?? null
            if (cdpBody !== null) {
              if (cdpBody.length !== lastCdpResponseLength) {
                lastCdpResponseLength = cdpBody.length
                this.emitSubmitActivitySafely()
              }
              const parsed = parseQwenResponse(cdpBody)
              if (this.isOwnedStreamingResponse(parsed, submittedRequest)) {
                return parsed.text || null
              }
            }
            if (cdpStreamCapture?.isAmbiguous() === true) return null
            const entries = (
              await this.getCapturedFetchEntries(captureStartIndex)
            ).filter((entry) =>
              this.isOwnedCapturedRequest(entry, submittedRequest)
            )
            if (entries.length !== 1) return null
            const entry = entries[0]!
            const rawResponse = entry.chunks.join('')
            const parsed = parseQwenResponse(rawResponse)
            if (!this.isOwnedStreamingResponse(parsed, submittedRequest)) {
              return null
            }
            this.reportCapturedSubmitActivity([entry])
            return parsed.text || null
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
          throwIfAborted(signal)
          if (response.status() < 200 || response.status() >= 300) {
            throw this.createHttpError(response.status())
          }
          const rawResponse = await abortable(response.text(), signal)
          const parsed = parseQwenResponse(rawResponse)
          this.validateFinalResponse(parsed, submittedRequest)
          await this.waitForComposer(
            'submit',
            this.getSubmitResponseTimeoutMs(),
            signal
          )
          this.conversationIdVal =
            this.conversationIdVal ??
            parsed.chatId ??
            readQwenConversationIdFromUrl(this.page.url()) ??
            null
          await this.emitSubmitText(parsed.text)
          throwIfAborted(signal)
          return parsed.text
        } finally {
          settleTargetResponse({
            kind: 'reject',
            error: new Error('Qwen submit ended before the response settled.'),
          })
          stopTextPolling?.()
          stopWarningTimer()
          await cdpStreamCapture?.stop()
          this.page.off('request', onRequest)
          this.page.off('requestfailed', onRequestFailed)
          this.page.off('response', onResponse)
          this.page.off('close', onClose)
        }
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (requestSubmitted && this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'Qwen request outcome is unknown after submission; Portal will not replay it automatically.',
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

  private readOwnedRequest(
    request: Request,
    pendingText: string
  ): QwenOwnedRequest | null {
    if (!this.isTargetCompletionRequest(request)) return null
    const rawRequestBody = request.postData()
    if (typeof rawRequestBody !== 'string' || rawRequestBody.length === 0) {
      return null
    }
    let body: unknown
    try {
      body = request.postDataJSON()
    } catch {
      return null
    }
    if (!isRecord(body) || body.stream !== true) return null
    const chatId =
      typeof body.chat_id === 'string' && body.chat_id.length > 0
        ? body.chat_id
        : null
    if (
      chatId === null ||
      (this.conversationIdVal !== null && chatId !== this.conversationIdVal)
    ) {
      return null
    }
    const messages: unknown[] = Array.isArray(body.messages)
      ? body.messages
      : []
    const lastValue: unknown = messages.at(-1)
    const lastMessage = isRecord(lastValue) ? lastValue : null
    const userMessageId =
      typeof lastMessage?.id === 'string' && lastMessage.id.length > 0
        ? lastMessage.id
        : null
    if (
      lastMessage === null ||
      lastMessage.role !== 'user' ||
      lastMessage.content !== pendingText
    ) {
      return null
    }
    return {
      request,
      chatId,
      rawRequestBody,
      userMessageId,
      userText: pendingText,
    }
  }

  private isOwnedCapturedRequest(
    entry: CapturedFetchEntry,
    ownedRequest: QwenOwnedRequest
  ): boolean {
    if (
      entry.method !== 'POST' ||
      !isQwenApiUrl(entry.url, QWEN_COMPLETION_PATH) ||
      entry.requestBody !== ownedRequest.rawRequestBody
    ) {
      return false
    }
    return true
  }

  private isOwnedStreamingResponse(
    parsed: QwenParsedResponse | null,
    ownedRequest: QwenOwnedRequest
  ): parsed is QwenParsedResponse {
    return (
      parsed !== null &&
      parsed.error === null &&
      parsed.identityConsistent &&
      parsed.chatId === ownedRequest.chatId &&
      (ownedRequest.userMessageId === null
        ? parsed.parentId !== null
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

    const requests = new Map<string, string>()
    const responses = new Set<string>()
    const decoder = new StringDecoder('utf8')
    let ownedRequestBody: string | null = null
    let targetRequestId: string | null = null
    let streamedRequestId: string | null = null
    let streamState: 'idle' | 'pending' | 'ready' | 'failed' = 'idle'
    let pendingData: string[] = []
    let responseBody = ''
    let ambiguous = false
    let stopped = false

    const appendBase64 = (value: unknown) => {
      if (stopped || ambiguous || typeof value !== 'string' || !value) return
      responseBody += decoder.write(Buffer.from(value, 'base64'))
    }
    const startStreaming = (requestId: string) => {
      if (
        stopped ||
        ambiguous ||
        targetRequestId !== requestId ||
        streamedRequestId === requestId
      ) {
        return
      }
      streamedRequestId = requestId
      streamState = 'pending'
      void session
        .send('Network.streamResourceContent', { requestId })
        .then((result) => {
          if (
            !isRecord(result) ||
            stopped ||
            ambiguous ||
            targetRequestId !== requestId
          ) {
            return
          }
          appendBase64(result.bufferedData)
          for (const data of pendingData) appendBase64(data)
          pendingData = []
          streamState = 'ready'
        })
        .catch(() => {
          pendingData = []
          streamState = 'failed'
        })
    }
    const bindOwnedRequest = () => {
      if (stopped || ambiguous || ownedRequestBody === null) return
      const matches = [...requests.entries()].filter(
        ([, postData]) => postData === ownedRequestBody
      )
      if (matches.length > 1) {
        ambiguous = true
        targetRequestId = null
        responseBody = ''
        pendingData = []
        streamState = 'failed'
        return
      }
      const requestId = matches[0]?.[0] ?? null
      if (requestId === null) return
      targetRequestId = requestId
      if (responses.has(requestId)) startStreaming(requestId)
    }

    session.on('Network.requestWillBeSent', (event: unknown) => {
      if (stopped || !isRecord(event) || !isRecord(event.request)) return
      const requestId = event.requestId
      const request = event.request
      if (
        typeof requestId !== 'string' ||
        request.method !== 'POST' ||
        typeof request.url !== 'string' ||
        !isQwenApiUrl(request.url, QWEN_COMPLETION_PATH) ||
        typeof request.postData !== 'string'
      ) {
        return
      }
      requests.set(requestId, request.postData)
      bindOwnedRequest()
    })
    session.on('Network.responseReceived', (event: unknown) => {
      if (stopped || !isRecord(event) || typeof event.requestId !== 'string') {
        return
      }
      responses.add(event.requestId)
      bindOwnedRequest()
      if (targetRequestId === event.requestId) startStreaming(event.requestId)
    })
    session.on('Network.dataReceived', (event: unknown) => {
      if (
        stopped ||
        ambiguous ||
        !isRecord(event) ||
        event.requestId !== targetRequestId
      ) {
        return
      }
      if (typeof event.data !== 'string' || !event.data) return
      if (streamState === 'pending') {
        pendingData.push(event.data)
      } else if (streamState === 'ready') {
        appendBase64(event.data)
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
      setOwnedRequestBody: (body) => {
        if (stopped || ambiguous) return
        ownedRequestBody = body
        bindOwnedRequest()
      },
      readResponseBody: () => (responseBody ? responseBody : null),
      isAmbiguous: () => ambiguous,
      stop: async () => {
        if (stopped) return
        stopped = true
        pendingData = []
        decoder.end()
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
      parsed.chatId !== ownedRequest.chatId ||
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
        'Qwen response ended without a completion marker.',
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
        `Qwen returned HTTP ${status} after accepting the request; its outcome is unknown.`,
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

  private async getReadyComposer(action: string) {
    const composers = this.page.locator(QWEN_COMPOSER_SELECTOR)
    if ((await composers.count()) !== 1) {
      throw new ProviderAdapterError(
        action,
        'Qwen Composer was missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'qwen_composer_invalid',
        }
      )
    }
    const composer = composers.first()
    if (
      !(await composer.isVisible().catch(() => false)) ||
      !(await composer.isEnabled().catch(() => false))
    ) {
      throw new ProviderAdapterError(action, 'Qwen Composer is not ready.', {
        kind: 'ui',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'qwen_composer_not_ready',
      })
    }
    return composer
  }

  private async waitForComposer(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const composers = this.page.locator(QWEN_COMPOSER_SELECTOR)
        return (
          (await composers.count().catch(() => 0)) === 1 &&
          (await composers
            .first()
            .isVisible()
            .catch(() => false)) &&
          (await composers
            .first()
            .isEnabled()
            .catch(() => false))
        )
      },
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'Qwen did not become ready after loading.'
              : 'Qwen finished responding, but the Composer did not become ready again.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'qwen_composer_ready_timeout',
            }
          )
        },
      }
    )
  }

  private async getReadySendButton(signal?: AbortSignal) {
    const buttons = this.page.locator(QWEN_SEND_BUTTON_SELECTOR)
    await waitAsync(
      async () =>
        (await buttons.count().catch(() => 0)) === 1 &&
        (await buttons
          .first()
          .isVisible()
          .catch(() => false)) &&
        (await buttons
          .first()
          .isEnabled()
          .catch(() => false)),
      {
        timeoutMs: this.getSubmitResponseTimeoutMs(),
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            'submit',
            'Qwen send button did not become ready.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'qwen_send_button_not_ready',
            }
          )
        },
      }
    )
    return buttons.first()
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
