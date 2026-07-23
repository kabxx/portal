import type { Locator, Page } from 'playwright'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import {
  isResolvedProviderModelSupported,
  type ResolvedProviderModel,
} from '../../provider-model-catalog.ts'
import { getProviderDefinition } from '../../provider-definition-pack.ts'
import { waitAsync } from '../../../shared/wait.ts'
import {
  defineProviderUiSelectors,
  defineProviderUiCapabilityMap,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
} from '../provider-ui.ts'

const CHATGPT_CHAT_URL = 'https://chatgpt.com'
const CHATGPT_DEFINITION = getProviderDefinition('chatgpt')
const modelPositions = defineProviderUiModelPositions('chatgpt', {
  chatgpt: 1,
})
const capabilityPositions = defineProviderUiCapabilityMap('chatgpt', {
  image_create: 1,
  web_search: 2,
  deep_research: 3,
  openai_platform: 4,
})

const selectors = defineProviderUiSelectors({
  auth: {
    loginButton: ['[data-testid="login-button"]'],
    noAuthModal: ['#modal-no-auth-login'],
    expiredSessionModal: ['#modal-expired-session'],
  },
  model: {
    trigger: [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button.__composer-pill',
    ],
    directMenu: ['[role="menu"]'],
    picker: ['div[data-testid="composer-intelligence-picker-content"]'],
    directItem: ['[role="menuitemradio"]'],
    menuItem: ['div[role="menuitem"]'],
    item: ['div[role="menuitemradio"]'],
  },
  composer: {
    editor: ['#prompt-textarea'],
    sendButton: ['#composer-submit-button'],
    readyButton: [
      'button[style*="--vt-composer-speech-button"]',
      'button[data-testid="send-button"]',
    ],
    stopButton: ['button[data-testid="stop-button"]'],
  },
  capability: {
    trigger: ['[data-testid="composer-plus-btn"]'],
    group: ['div[role="group"][class*="empty:hidden"]'],
  },
})

export type ChatGPTActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

export interface ChatGPTActionCapabilityInfo {
  name: string
  state: ChatGPTActionCapabilityState
}

export class ChatGPTUi {
  public constructor(private readonly page: Page) {}

  public async isLoggedIn(): Promise<boolean> {
    if (!this.page.url().startsWith(CHATGPT_CHAT_URL)) {
      return false
    }

    const signedOutIndicators = [
      this.page.locator(joinCssLocatorCandidates(selectors.auth.loginButton)),
      this.page.locator(joinCssLocatorCandidates(selectors.auth.noAuthModal)),
      this.page.locator(
        joinCssLocatorCandidates(selectors.auth.expiredSessionModal)
      ),
    ]
    for (const indicator of signedOutIndicators) {
      if (await indicator.isVisible().catch(() => false)) {
        return false
      }
    }
    return true
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (
      position === undefined ||
      !isResolvedProviderModelSupported('chatgpt', model)
    ) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `ChatGPT does not support model "${model.key}"${
          model.option === null ? '' : ` with option "${model.option}"`
        }.`
      )
    }

    const modelIndex = position - 1
    const directMenus = this.page.locator(
      joinCssLocatorCandidates(selectors.model.directMenu, ':visible')
    )
    const picker = await this.openModelPicker(directMenus)
    if (!(await picker.isVisible().catch(() => false))) {
      const directModelItems = directMenus
        .first()
        .locator(joinCssLocatorCandidates(selectors.model.directItem))
      if ((await directModelItems.count()) <= modelIndex) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `ChatGPT does not have model ${position}.`
        )
      }
      await directModelItems.nth(modelIndex).click()
      return
    }

    const modelMenuItems = picker.locator(
      joinCssLocatorCandidates(selectors.model.menuItem)
    )
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
      mapCssLocatorCandidates(
        selectors.model.item,
        (candidate) => `[id=${JSON.stringify(modelMenuId)}] ${candidate}`
      )
    )
    await waitAsync(async () => (await modelItems.count().catch(() => 0)) > 0, {
      timeoutMs: 5000,
      onTimeout: async () => {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `ChatGPT does not have model ${position}.`
        )
      },
    })
    if ((await modelItems.count()) <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `ChatGPT does not have model ${position}.`
      )
    }
    await modelItems.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    await this.getRetryComposer().click()
    await this.page.keyboard.insertText(text)
  }

  public getRetryComposer(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.composer.editor)
    )
  }

  public getRetryStopButton(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.composer.stopButton)
    )
  }

  public getRetrySendButton(): Locator {
    return this.getSendButton()
  }

  public getSendButton(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.composer.sendButton)
    )
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    await this.page
      .locator(joinCssLocatorCandidates(selectors.capability.trigger))
      .click()
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      this.getCapabilityGroup(0).locator('xpath=./div').nth(0).click(),
    ])
    await fileChooser.setFiles(path)
  }

  public async listActionCapabilities(): Promise<
    ChatGPTActionCapabilityInfo[]
  > {
    await this.openCapabilityMenu()
    const capabilityGroup = this.getCapabilityGroup(1)
    if ((await capabilityGroup.count().catch(() => 0)) === 0) {
      return []
    }
    return CHATGPT_DEFINITION.capabilities.map((capability) => ({
      name: capability.key,
      state: 'available',
    }))
  }

  public async selectActionCapability(
    capability: string
  ): Promise<ChatGPTActionCapabilityState> {
    const position = Object.entries(capabilityPositions).find(
      ([key]) => key === capability
    )?.[1]
    if (position === undefined) {
      return 'unavailable'
    }
    await this.openCapabilityMenu()
    const capabilityGroup = this.getCapabilityGroup(1)
    if ((await capabilityGroup.count().catch(() => 0)) === 0) {
      return 'unavailable'
    }
    await capabilityGroup
      .locator('xpath=./div')
      .nth(position - 1)
      .click()
    return 'selected'
  }

  public async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(this.getRetryStopButton())
  }

  public async waitForComposerReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    const readyButtons = selectors.composer.readyButton.map((candidate) =>
      this.page.locator(candidate)
    )
    await waitAsync(
      async () => {
        for (const button of readyButtons) {
          if (await this.isLocatorReady(button)) {
            return true
          }
        }
        return false
      },
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

  private async openModelPicker(directMenus: Locator): Promise<Locator> {
    const triggers = this.page.locator(
      joinCssLocatorCandidates(selectors.model.trigger, ':visible')
    )
    if ((await triggers.count()) !== 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'ChatGPT model selector was missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'chatgpt_model_trigger_invalid',
        }
      )
    }
    await triggers.first().click()
    const picker = this.page.locator(
      joinCssLocatorCandidates(selectors.model.picker, ':visible')
    )
    await waitAsync(
      async () =>
        (await picker.count().catch(() => 0)) > 0 ||
        (await directMenus.count().catch(() => 0)) > 0,
      { timeoutMs: 5000 }
    )
    if ((await picker.count()) > 1 || (await directMenus.count()) > 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'ChatGPT model menu was ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'chatgpt_model_menu_ambiguous',
        }
      )
    }
    return picker.first()
  }

  private getCapabilityGroup(index: number): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(selectors.capability.group))
      .nth(index)
  }

  private async openCapabilityMenu(): Promise<void> {
    const capabilityGroup = this.getCapabilityGroup(1)
    if ((await capabilityGroup.count().catch(() => 0)) > 0) {
      return
    }
    await this.page
      .locator(joinCssLocatorCandidates(selectors.capability.trigger))
      .click()
    await waitAsync(
      async () => (await capabilityGroup.count().catch(() => 0)) > 0,
      { timeoutMs: 1000 }
    ).catch(() => {})
  }

  private async isLocatorReady(locator: Locator): Promise<boolean> {
    if ((await locator.count().catch(() => 0)) !== 1) {
      return false
    }
    const target = locator.first()
    return (
      (await target.isVisible().catch(() => false)) &&
      (await target.isEnabled().catch(() => false))
    )
  }

  private async clickLocatorIfReady(locator: Locator): Promise<void> {
    if ((await locator.count().catch(() => 0)) === 0) {
      return
    }
    const target = locator.first()
    if (
      !(await target.isVisible().catch(() => false)) ||
      !(await target.isEnabled().catch(() => false))
    ) {
      return
    }
    await target.click()
  }
}
