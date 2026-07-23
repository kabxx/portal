import type { Locator, Page } from 'playwright'
import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import { throwIfAborted } from '../../../runtime/runtime-cancellation.ts'
import { waitAsync } from '../../../shared/wait.ts'
import {
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
} from '../provider-ui.ts'

const modelPositions = defineProviderUiModelPositions('doubao', {
  quick: 1,
  expert: 2,
  'office-turbo': 3,
  'office-pro': 4,
})
const DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS = 5000
// Deliberate XPath exception: this legacy promotion has no stable CSS owner.
// Keep it local to the behavior that dismisses the overlay; it is not part of
// the reusable CSS selector contract.
const DESKTOP_PROMOTION_CLOSE_XPATH =
  'xpath=//img[contains(@src, "/obj/flow-doubao/samantha/jianti.png")]/preceding-sibling::button[@type="button"][1]'

const SELECTORS = defineProviderUiSelectors({
  auth: {
    signedOut: ['button.login-btn-header-CTKsn1'],
  },
  composer: {
    input: ['textarea.semi-input-textarea', 'div[role="textbox"]'],
    send: ['button[class*="bg-g-send-msg-btn-bg"]'],
    ready: ['div[class*="container-YCWnMI"]'],
    stop: [
      'div.break-btn-fISNgC:has(svg[viewBox^="0 0 24"] path[d^="M12 0.5C18.3513 0.5 23.5 5.64873 23.5 12"])',
    ],
  },
  upload: {
    trigger: [
      'button[data-dbx-name="button"]:has(svg path[d^="M12.0005 2.25"])',
      'button[data-dbx-name="button"]:has(svg path[d^="M12.0005 2.44971"])',
    ],
    input: ['input[type="file"]'],
  },
  model: {
    trigger: [
      'button[data-dbx-name="button"]:has(img[src*="mode_"])',
      'button[data-dbx-name="button"][aria-haspopup="menu"]',
      'button[data-dbx-name="button"]:has(svg path[d^="M3.70898 9.23633"])',
    ],
    menu: [
      'div[data-slot="dropdown-menu-content"]',
      '[role="menu"]',
      'div[data-radix-menu-content][data-state="open"]',
    ],
    item: ['[role="menuitem"]'],
  },
  capability: {
    toolbar: [
      '[style*="--chat-input-tool-button-overflow-list-gap"]',
      'div[data-testid="chat-input-action-bar"]',
    ],
    selected: [
      '[class*="text-g-exit-skill-btn-text"][data-value]',
      'div[data-testid="chat-input-selected-skill"]',
    ],
    overflowPopover: [
      '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"]',
      'div[data-radix-popper-content-wrapper]',
    ],
    overflowTrigger: [
      'div[aria-haspopup="dialog"][aria-controls][data-state] > button[data-dbx-name="button"]',
    ],
    visibleAction: [
      'button[data-component-type="skill-item"][data-input-engine-action-source="actionbar"]',
    ],
    overflowAction: ['button[data-input-engine-action-source="actionbar"]'],
    selectedClose: ['svg'],
  },
})

const ACTION_BAR_INPUT_ITEMS_SOURCE = String.raw`(() => {
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

    inputItems.push({ configKey: configKey.trim() })
  }

  return inputItems
})()`

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

const DISABLED_ACTION_CAPABILITIES = new Set<DoubaoActionCapability>([
  'meeting_record',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class DoubaoUi {
  public constructor(private readonly page: Page) {}

  public getSendButton(): Locator {
    return this.page.locator(SELECTORS.composer.send[0]).last()
  }

  public getRetryLocators(): {
    composer: Locator
    stop: Locator
    send: Locator
  } {
    return {
      composer: this.page.locator(
        joinCssLocatorCandidates(SELECTORS.composer.input)
      ),
      stop: this.page.locator(
        joinCssLocatorCandidates(SELECTORS.composer.stop)
      ),
      send: this.page.locator(
        joinCssLocatorCandidates(SELECTORS.composer.send)
      ),
    }
  }

  public async isLoggedIn(): Promise<boolean> {
    const signedOutVisible = await this.page
      .locator(SELECTORS.auth.signedOut[0])
      .isVisible()
      .catch(() => false)
    return !signedOutVisible
  }

  public async waitForReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    const ready = this.page.locator(SELECTORS.composer.ready[0])
    await waitAsync(
      async () => {
        if ((await ready.count().catch(() => 0)) !== 1) return false
        return await ready
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

  public async dismissDesktopPromotion(
    action: 'attachText' | 'submit',
    signal?: AbortSignal
  ): Promise<void> {
    const closeButton = this.page.locator(DESKTOP_PROMOTION_CLOSE_XPATH).first()
    if (!(await closeButton.isVisible().catch(() => false))) return

    throwIfAborted(signal)
    try {
      await closeButton.click({ timeout: DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS })
    } catch (error) {
      throw this.desktopPromotionError(action, error)
    }
    await waitAsync(
      async () => !(await closeButton.isVisible().catch(() => false)),
      {
        timeoutMs: DESKTOP_PROMOTION_DISMISS_TIMEOUT_MS,
        signal,
        onTimeout: async () => {
          throw this.desktopPromotionError(action)
        },
      }
    )
  }

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    if (model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Doubao model "${model.key}" does not support option "${model.option}".`
      )
    }
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Doubao does not support model "${model.key}".`
      )
    }

    const index = position - 1
    const triggers = this.page.locator(
      joinCssLocatorCandidates(SELECTORS.model.trigger, ':visible')
    )
    if ((await triggers.count()) !== 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'Doubao model selector was missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_model_trigger_invalid',
        }
      )
    }
    await triggers.first().click()

    const menus = this.page.locator(
      joinCssLocatorCandidates(SELECTORS.model.menu, ':visible')
    )
    await waitAsync(async () => (await menus.count().catch(() => 0)) > 0, {
      timeoutMs: 5000,
    })
    if ((await menus.count()) !== 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'Doubao model menu was ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'doubao_model_menu_ambiguous',
        }
      )
    }

    const menu = menus.first()
    const roleItems = menu.locator(SELECTORS.model.item[0])
    const items =
      (await roleItems.count()) > 0 ? roleItems : menu.locator('xpath=./div')
    if ((await items.count()) <= index) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Doubao does not have model ${index + 1}.`
      )
    }
    const target = items.nth(index)
    await ((await roleItems.count()) > 0
      ? target.click()
      : target.locator('xpath=./div').click())
  }

  public async attachText(text: string): Promise<void> {
    await this.dismissDesktopPromotion('attachText')
    const textarea = this.page.locator(SELECTORS.composer.input[0]).first()
    if (await textarea.isVisible().catch(() => false)) {
      await textarea.click()
    } else {
      await this.page.locator(SELECTORS.composer.input[1]).first().click()
    }
    await this.page.keyboard.insertText(text)
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const paths = typeof path === 'string' ? [path] : [...path]
    const uploadTrigger = this.page
      .locator(joinCssLocatorCandidates(SELECTORS.upload.trigger))
      .first()
    if ((await uploadTrigger.count()) === 0) {
      throw new ProviderAdapterError(
        'attachFile',
        'Doubao upload trigger was not found.',
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
    const input = this.page.locator(SELECTORS.upload.input[0]).last()
    await waitAsync(async () => (await input.count()) > 0, { timeoutMs: 5000 })
    await input.setInputFiles(paths)
  }

  public async stopGeneration(): Promise<void> {
    await this.clickUniqueVisible(
      this.page.locator(joinCssLocatorCandidates(SELECTORS.composer.stop))
    )
  }

  public async scrollHistoryToTop(): Promise<boolean> {
    return await this.page
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
  }

  public async listActionCapabilities(): Promise<DoubaoActionCapabilityInfo[]> {
    const order = await this.readActionCapabilityOrder()
    return order.map((name) => ({
      name,
      state: DISABLED_ACTION_CAPABILITIES.has(name) ? 'disabled' : 'available',
    }))
  }

  public async getActionCapabilityState(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    const order = await this.readActionCapabilityOrder()
    if (DISABLED_ACTION_CAPABILITIES.has(capability)) return 'disabled'
    if ((await this.getVisibleActionButton(capability, order)) !== null) {
      return 'available'
    }
    if ((await this.getOverflowActionButton(capability, order)) !== null) {
      return 'available'
    }
    return 'unavailable'
  }

  public async clearActionCapability(): Promise<void> {
    await this.cancelSelectedActionCapability()
  }

  public async selectActionCapability(
    capability: DoubaoActionCapability
  ): Promise<DoubaoActionCapabilityState> {
    const order = await this.readActionCapabilityOrder()
    if (DISABLED_ACTION_CAPABILITIES.has(capability)) return 'disabled'
    await this.cancelSelectedActionCapability()
    await this.openOverflowPopoverIfPresent()
    return (await this.clickActionCapabilityButton(capability, order))
      ? 'selected'
      : 'unavailable'
  }

  private desktopPromotionError(
    action: 'attachText' | 'submit',
    cause?: unknown
  ): ProviderAdapterError {
    return new ProviderAdapterError(
      action,
      'Doubao desktop promotion is visible but could not be dismissed.',
      {
        kind: 'ui',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'doubao_desktop_promotion_dismiss_failed',
        ...(cause === undefined ? {} : { cause }),
      }
    )
  }

  private getToolbar(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(SELECTORS.capability.toolbar))
      .first()
  }

  private getVisibleActionButtons(): Locator {
    return this.getToolbar().locator(SELECTORS.capability.visibleAction[0])
  }

  private getOverflowPopover(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(SELECTORS.capability.overflowPopover))
      .first()
  }

  private getOverflowTrigger(): Locator {
    return this.getToolbar()
      .locator(SELECTORS.capability.overflowTrigger[0])
      .first()
  }

  private async readActionCapabilityOrder(): Promise<DoubaoActionCapability[]> {
    let values: unknown
    try {
      values = await this.page.evaluate(ACTION_BAR_INPUT_ITEMS_SOURCE)
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
    if (!Array.isArray(values) || values.length === 0) {
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
    const order: DoubaoActionCapability[] = []
    for (const value of values) {
      const configKey = isRecord(value) ? value.configKey : null
      if (
        typeof configKey === 'string' &&
        configKey.trim() &&
        !order.includes(configKey.trim())
      ) {
        order.push(configKey.trim())
      }
    }
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

  private async getVisibleActionButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<Locator | null> {
    const index = order.indexOf(capability)
    const buttons = this.getVisibleActionButtons()
    return index < 0 || index >= (await buttons.count().catch(() => 0))
      ? null
      : buttons.nth(index)
  }

  private async getOverflowActionButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<Locator | null> {
    const index = order.indexOf(capability)
    if (index < 0 || !(await this.ensureOverflowPopoverOpen())) return null
    const visibleCount = await this.getVisibleActionButtons()
      .count()
      .catch(() => 0)
    const overflowIndex = index - visibleCount
    if (overflowIndex < 0) return null
    const buttons = this.getOverflowPopover().locator(
      SELECTORS.capability.overflowAction[0]
    )
    return overflowIndex >= (await buttons.count().catch(() => 0))
      ? null
      : buttons.nth(overflowIndex)
  }

  private async ensureOverflowPopoverOpen(): Promise<boolean> {
    const popover = this.getOverflowPopover()
    if (await popover.isVisible().catch(() => false)) return true
    const trigger = this.getOverflowTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) return false
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
    )
      return
    const trigger = this.getOverflowTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) return
    await trigger.click()
    await waitAsync(
      async () =>
        await this.getOverflowPopover()
          .isVisible()
          .catch(() => false),
      { timeoutMs: 5000 }
    )
  }

  private async cancelSelectedActionCapability(): Promise<void> {
    const selected = this.page
      .locator(joinCssLocatorCandidates(SELECTORS.capability.selected))
      .first()
    if ((await selected.count().catch(() => 0)) === 0) return
    await selected
      .locator(SELECTORS.capability.selectedClose[0])
      .locator('..')
      .click()
  }

  private async clickActionCapabilityButton(
    capability: DoubaoActionCapability,
    order: readonly DoubaoActionCapability[]
  ): Promise<boolean> {
    const visible = await this.getVisibleActionButton(capability, order)
    if (visible !== null) {
      await visible.click()
      return true
    }
    const overflow = await this.getOverflowActionButton(capability, order)
    if (overflow === null) return false
    await overflow.click()
    return true
  }

  private async clickUniqueVisible(locator: Locator): Promise<boolean> {
    if ((await locator.count().catch(() => 0)) !== 1) return false
    const target = locator.first()
    if (!(await target.isVisible().catch(() => false))) return false
    return await target.click().then(
      () => true,
      () => false
    )
  }
}
