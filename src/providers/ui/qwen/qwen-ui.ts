import type { FileChooser, Locator, Page, Response } from 'playwright'

import { waitAsync } from '../../../shared/wait.ts'
import {
  awaitWithTimeout,
  createDeferred,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import {
  defineProviderUiSelectors,
  defineProviderUiCapabilityMap,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
  resolveUniqueVisibleLocator,
} from '../provider-ui.ts'

const QWEN_CHAT_URL = 'https://chat.qwen.ai'
const QWEN_FILE_PARSE_STATUS_PATH = '/api/v2/files/parse/status'
const QWEN_UPLOAD_TIMEOUT_MS = 60_000
const modelPositions = defineProviderUiModelPositions('qwen', {
  'qwen3.7-plus': 1,
  'qwen3.8-max-preview': 2,
  'qwen3.7-max': 3,
})
const QWEN_UI_SELECTORS = defineProviderUiSelectors({
  composer: {
    input: ['.message-input-textarea'],
    send: [
      '.message-input-container button.send-button',
      '.chat-layout-input-container button.send-button',
    ],
    stop: ['.chat-layout-input-container button.stop-button'],
  },
  upload: {
    trigger: ['.mode-select-open[role="button"]'],
    menuItem: ['[role="menuitem"][data-menu-id$="-upload"]'],
    fileCard: ['.file-card-list .fileitem-btn'],
  },
  model: {
    trigger: [
      '#qwen-chat-header-left [role="button"][aria-haspopup="listbox"]',
    ],
    listbox: ['[role="listbox"]'],
    item: ['[role="option"]'],
  },
  capability: {
    menu: ['.mode-select-dropdown [role="menu"]'],
    item: [':scope > [role="menuitem"][data-menu-id]'],
    submenu: ['[role="menuitem"][aria-haspopup="true"]'],
    selected: ['.mode-select-current-mode'],
    selectedIcon: ['.mode-select-current-mode-icon use'],
    selectedClose: ['.mode-select-current-mode-close'],
    itemIcon: ['.mode-select-dropdown-item-icon use'],
  },
} as const)

const QWEN_ACTION_CAPABILITY_UI = defineProviderUiCapabilityMap('qwen', {
  deep_research: { menuId: 'deep_research', scope: 'root' },
  image_generation: { menuId: 't2i', scope: 'root' },
  video_generation: { menuId: 't2v', scope: 'root' },
  web_dev: { menuId: 'web_dev', scope: 'root' },
  slides: { menuId: 'slides', scope: 'root' },
  search: { menuId: 'search', scope: 'nested' },
  artifacts: { menuId: 'artifacts', scope: 'nested' },
  learn: { menuId: 'learn', scope: 'nested' },
  travel: { menuId: 'travel', scope: 'nested' },
} as const)

export type QwenActionCapability = string
const QWEN_ACTION_CAPABILITIES = Object.entries(QWEN_ACTION_CAPABILITY_UI).map(
  ([name, metadata]) => ({
    name,
    ...metadata,
  })
)

export type QwenActionCapabilityState =
  | 'available'
  | 'selected'
  | 'cleared'
  | 'disabled'
  | 'unavailable'

export interface QwenActionCapabilityInfo {
  readonly name: QwenActionCapability
  readonly state: Exclude<QwenActionCapabilityState, 'cleared'>
}

export interface QwenRetryLocators {
  readonly composer: Locator
  readonly send: Locator
  readonly stop: Locator
}

export class QwenUi {
  public constructor(private readonly page: Page) {}

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined || model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Qwen does not support model "${model.key}".`
      )
    }
    const modelIndex = position - 1
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.model.trigger
    )
    if (trigger === null) {
      throw createQwenUiError(
        'changeModel',
        'Qwen model selector was missing or ambiguous.',
        'qwen_model_trigger_invalid'
      )
    }
    await trigger.click()
    const listboxes = this.page.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.model.listbox, ':visible')
    )
    const scopedOptions = listboxes.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.model.item)
    )
    const globalOptions = this.page.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.model.item, ':visible')
    )
    await waitAsync(
      async () =>
        (await scopedOptions.count().catch(() => 0)) > 0 ||
        (await globalOptions.count().catch(() => 0)) > 0,
      { timeoutMs: 5000 }
    )
    if ((await listboxes.count()) > 1) {
      throw createQwenUiError(
        'changeModel',
        'Qwen model menu was ambiguous.',
        'qwen_model_menu_ambiguous'
      )
    }
    const useScopedOptions = (await scopedOptions.count()) > 0
    const options = useScopedOptions ? scopedOptions : globalOptions
    if (
      !useScopedOptions &&
      !(await options.evaluateAll(
        (candidates) =>
          new Set(candidates.map((candidate) => candidate.parentElement))
            .size === 1
      ))
    ) {
      throw createQwenUiError(
        'changeModel',
        'Qwen model options were ambiguous.',
        'qwen_model_options_ambiguous'
      )
    }
    if ((await options.count()) <= modelIndex) {
      await this.page.keyboard.press('Escape').catch(() => {})
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Qwen does not have model "${model.key}".`
      )
    }
    await options.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    const composer = await this.getReadyComposer('attachText')
    await composer.click()
    await this.page.keyboard.insertText(text)
  }

  public getRetryLocators(): QwenRetryLocators {
    return {
      composer: this.page.locator(
        joinCssLocatorCandidates(QWEN_UI_SELECTORS.composer.input)
      ),
      send: this.page.locator(
        joinCssLocatorCandidates(QWEN_UI_SELECTORS.composer.send)
      ),
      stop: this.page.locator(
        joinCssLocatorCandidates(QWEN_UI_SELECTORS.composer.stop)
      ),
    }
  }

  public async attachFile(
    path: string | readonly string[],
    waitForTextParsing: boolean
  ): Promise<void> {
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.upload.trigger
    )
    if (trigger === null || !(await trigger.isEnabled().catch(() => false))) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'Qwen file upload is not available in the current conversation.'
      )
    }
    const cards = this.page.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.upload.fileCard)
    )
    const previousFileCount = await cards.count()
    const expectedFileCount = typeof path === 'string' ? 1 : path.length
    const fileChooser = await this.openFileChooser(trigger)
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
          const statuses = (Array.isArray(payload.data) ? payload.data : [])
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
            (await cards.count().catch(() => 0)) >=
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
  }

  public async listActionCapabilities(): Promise<QwenActionCapabilityInfo[]> {
    const rootMenu = await this.openActionCapabilityMenu('listCapabilities')
    try {
      const nestedMenu = await this.expandActionCapabilitySubmenu(
        rootMenu,
        'listCapabilities'
      )
      const selectedIcon =
        await this.readSelectedActionIconReference('listCapabilities')
      const capabilities: QwenActionCapabilityInfo[] = []
      for (const definition of QWEN_ACTION_CAPABILITIES) {
        const item = this.getActionCapabilityItem(
          definition,
          rootMenu,
          nestedMenu
        )
        const itemCount = await item.count().catch(() => 0)
        if (itemCount === 0) continue
        if (itemCount !== 1) {
          throw createQwenUiError(
            'listCapabilities',
            `Qwen capability item is duplicated: ${definition.name}.`,
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
          name: definition.name,
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

  public async clearActionCapability(): Promise<void> {
    const selected = this.page
      .locator(joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.selected))
      .filter({ visible: true })
    const count = await selected.count().catch(() => 0)
    if (count === 0) return
    if (count !== 1) {
      throw createQwenUiError(
        'clearCapability',
        'Qwen selected capability is ambiguous.',
        'qwen_selected_capability_ambiguous'
      )
    }
    await selected.first().hover({ force: true })
    const close = selected
      .first()
      .locator(
        joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.selectedClose)
      )
      .filter({ visible: true })
    await waitAsync(async () => (await close.count().catch(() => 0)) === 1, {
      timeoutMs: 1000,
    })
    await close.first().click({ force: true })
    await waitAsync(async () => (await selected.count().catch(() => 0)) === 0, {
      timeoutMs: 5000,
    })
  }

  public async selectActionCapability(
    capability: string
  ): Promise<QwenActionCapabilityState> {
    const definition = QWEN_ACTION_CAPABILITIES.find(
      (candidate) => candidate.name === capability
    )
    if (definition === undefined) return 'unavailable'
    const rootMenu = await this.openActionCapabilityMenu('selectCapability')
    try {
      const nestedMenu = await this.expandActionCapabilitySubmenu(
        rootMenu,
        'selectCapability'
      )
      const item = this.getActionCapabilityItem(
        definition,
        rootMenu,
        nestedMenu
      )
      const count = await item.count().catch(() => 0)
      if (count === 0) return 'unavailable'
      if (count !== 1) {
        throw createQwenUiError(
          'selectCapability',
          `Qwen capability item is duplicated: ${capability}.`,
          'qwen_capability_item_duplicated'
        )
      }
      if (
        (await item.getAttribute('aria-disabled').catch(() => null)) === 'true'
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
          (await this.readSelectedActionIconReference('selectCapability')) ===
          targetIcon,
        { timeoutMs: 5000 }
      )
      return 'selected'
    } finally {
      await this.closeActionCapabilityMenu(rootMenu)
    }
  }

  public async stopGeneration(): Promise<void> {
    const stop = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.composer.stop
    )
    if (stop !== null) await stop.click().catch(() => {})
  }

  public async waitForComposer(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const composer = await resolveUniqueVisibleLocator(
          this.page,
          QWEN_UI_SELECTORS.composer.input
        )
        return (
          composer !== null && (await composer.isEnabled().catch(() => false))
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

  public async assertComposerText(
    action: string,
    expected: string
  ): Promise<void> {
    const composer = await this.getReadyComposer(action)
    if ((await composer.inputValue()) !== expected) {
      throw new ProviderAdapterError(
        action,
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
  }

  public async waitForSendReady(
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const send = await resolveUniqueVisibleLocator(
          this.page,
          QWEN_UI_SELECTORS.composer.send
        )
        return send !== null && (await send.isEnabled().catch(() => false))
      },
      {
        timeoutMs,
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
  }

  public async clickSend(): Promise<void> {
    const send = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.composer.send
    )
    if (send === null) {
      throw createQwenUiError(
        'submit',
        'Qwen send button did not become ready.',
        'qwen_send_button_not_ready'
      )
    }
    await send.click()
  }

  private async getReadyComposer(action: string): Promise<Locator> {
    const composer = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.composer.input
    )
    if (composer === null) {
      throw createQwenUiError(
        action,
        'Qwen Composer was missing, ambiguous, or not visible.',
        'qwen_composer_invalid'
      )
    }
    if (!(await composer.isEnabled().catch(() => false))) {
      throw createQwenUiError(
        action,
        'Qwen Composer is not ready.',
        'qwen_composer_not_ready'
      )
    }
    return composer
  }

  private async openFileChooser(trigger: Locator): Promise<FileChooser> {
    await trigger.click()
    const uploadItem = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.upload.menuItem
    )
    if (uploadItem === null) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'Qwen file upload menu item is not available.'
      )
    }
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      uploadItem.click(),
    ])
    return chooser
  }

  private async getVisibleActionCapabilityMenu(
    action: string
  ): Promise<Locator | null> {
    const menus = this.page.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.menu)
    )
    const count = await menus.count().catch(() => 0)
    let visibleMenu: Locator | null = null
    for (let index = 0; index < count; index += 1) {
      const menu = menus.nth(index)
      if (!(await menu.isVisible().catch(() => false))) continue
      if (visibleMenu !== null) {
        throw createQwenUiError(
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
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      QWEN_UI_SELECTORS.upload.trigger
    )
    if (trigger === null || !(await trigger.isEnabled().catch(() => false))) {
      throw createQwenUiError(
        action,
        'Qwen mode menu is not available in the current conversation.',
        'qwen_capability_menu_unavailable'
      )
    }
    await trigger.click()
    let opened: Locator | null = null
    await waitAsync(
      async () => {
        opened = await this.getVisibleActionCapabilityMenu(action)
        return opened !== null
      },
      { timeoutMs: 5000 }
    )
    const resolved = await this.getVisibleActionCapabilityMenu(action)
    if (resolved === null) {
      throw createQwenUiError(
        action,
        'Qwen capability menu did not open.',
        'qwen_capability_menu_missing'
      )
    }
    return resolved
  }

  private async expandActionCapabilitySubmenu(
    rootMenu: Locator,
    action: string
  ): Promise<Locator | null> {
    const submenu = rootMenu
      .locator(joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.submenu))
      .filter({ visible: true })
    const count = await submenu.count().catch(() => 0)
    if (count === 0) return null
    if (count !== 1) {
      throw createQwenUiError(
        action,
        'Qwen capability submenu is ambiguous.',
        'qwen_capability_submenu_ambiguous'
      )
    }
    const trigger = submenu.first()
    const popupId = await trigger
      .getAttribute('aria-controls')
      .catch(() => null)
    if (popupId === null || !popupId.trim()) {
      throw createQwenUiError(
        action,
        'Qwen capability submenu has no controlled menu.',
        'qwen_capability_submenu_owner_missing'
      )
    }
    await trigger.dispatchEvent('mouseover')
    const popup = this.page
      .locator(`[id="${popupId.replaceAll('"', '\\"')}"]`)
      .filter({ visible: true })
    await waitAsync(async () => (await popup.count().catch(() => 0)) === 1, {
      timeoutMs: 5000,
    })
    return popup.first()
  }

  private async closeActionCapabilityMenu(owner?: Locator): Promise<void> {
    const menu = owner ?? (await this.getVisibleActionCapabilityMenu('close'))
    if (menu === null || !(await menu.isVisible().catch(() => false))) return
    await this.page.keyboard.press('Escape')
    if (await menu.isVisible().catch(() => false)) {
      await this.page.keyboard.press('Escape')
    }
  }

  private getActionCapabilityItem(
    definition: (typeof QWEN_ACTION_CAPABILITIES)[number],
    rootMenu: Locator,
    nestedMenu: Locator | null
  ): Locator {
    const owner =
      definition.scope === 'nested' && nestedMenu !== null
        ? nestedMenu
        : rootMenu
    return owner
      .locator(
        mapCssLocatorCandidates(
          QWEN_UI_SELECTORS.capability.item,
          (candidate) => `${candidate}[data-menu-id$="-${definition.menuId}"]`
        )
      )
      .filter({ visible: true })
  }

  private async readActionCapabilityIconReference(
    owner: Locator,
    action: string
  ): Promise<string> {
    const icons = owner.locator(
      joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.itemIcon)
    )
    if ((await icons.count().catch(() => 0)) !== 1) {
      throw createQwenUiError(
        action,
        'Qwen capability icon is missing or ambiguous.',
        'qwen_capability_icon_invalid'
      )
    }
    return await readIconReference(
      icons.first(),
      action,
      'qwen_capability_icon_reference_missing'
    )
  }

  private async readSelectedActionIconReference(
    action: string
  ): Promise<string | null> {
    const selected = this.page
      .locator(joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.selected))
      .filter({ visible: true })
    const count = await selected.count().catch(() => 0)
    if (count === 0) return null
    if (count !== 1) {
      throw createQwenUiError(
        action,
        'Qwen selected capability is ambiguous.',
        'qwen_selected_capability_ambiguous'
      )
    }
    const icons = selected
      .first()
      .locator(
        joinCssLocatorCandidates(QWEN_UI_SELECTORS.capability.selectedIcon)
      )
    if ((await icons.count().catch(() => 0)) !== 1) {
      throw createQwenUiError(
        action,
        'Qwen selected capability icon is missing or ambiguous.',
        'qwen_selected_capability_icon_invalid'
      )
    }
    return await readIconReference(
      icons.first(),
      action,
      'qwen_selected_capability_icon_reference_missing'
    )
  }
}

function createQwenUiError(
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

async function readIconReference(
  icon: Locator,
  action: string,
  detailCode: string
): Promise<string> {
  const reference =
    (await icon.getAttribute('xlink:href').catch(() => null)) ??
    (await icon.getAttribute('href').catch(() => null))
  if (reference === null || !reference.trim()) {
    throw createQwenUiError(
      action,
      'Qwen capability icon does not expose a stable reference.',
      detailCode
    )
  }
  return reference
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isQwenApiUrl(value: string, pathname: string): boolean {
  try {
    const url = new URL(value, QWEN_CHAT_URL)
    return url.origin === QWEN_CHAT_URL && url.pathname === pathname
  } catch {
    return false
  }
}
