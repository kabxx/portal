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
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
} from '../provider-ui.ts'

const CHATGPT_DEFINITION = getProviderDefinition('chatgpt')
const modelPositions = defineProviderUiModelPositions('chatgpt', {
  chatgpt: 1,
})
const capabilityIdentityTokens: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    image_create: ['image', 'image-generation', 'image_create'],
    web_search: ['search', 'web-search', 'web_search'],
    deep_research: ['research', 'deep-research', 'deep_research'],
    thinking: ['thinking', 'reasoning'],
  })

const selectors = defineProviderUiSelectors({
  auth: {
    loginButton: ['[data-testid="login-button"]'],
    noAuthModal: ['#modal-no-auth-login'],
    expiredSessionModal: ['#modal-expired-session'],
    loginForm: ['form[action*="/auth/login"]', 'input[type="email"]'],
    challenge: [
      '#challenge-running',
      '#cf-chl-widget',
      'iframe[src*="challenges.cloudflare.com"]',
    ],
    restricted: [
      '#account-deactivated',
      '[data-testid="account-restricted"]',
      '[data-testid="unsupported-country"]',
    ],
    authenticated: [
      '#prompt-textarea',
      'button[style*="--vt-composer-speech-button"]',
      'button[data-testid="send-button"]',
      'button[data-testid="model-switcher-dropdown-button"]',
    ],
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
  'available' | 'selected' | 'disabled' | 'unavailable'

export interface ChatGPTActionCapabilityInfo {
  name: string
  state: ChatGPTActionCapabilityState
}

export type ChatGPTAccessState =
  'authenticated' | 'signed_out' | 'challenge' | 'restricted' | 'unknown'

export class ChatGPTUi {
  public constructor(private readonly page: Page) {}

  public async getAccessState(): Promise<ChatGPTAccessState> {
    let url: URL
    try {
      url = new URL(this.page.url())
    } catch {
      return 'unknown'
    }
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'chatgpt.com' && url.hostname !== 'chat.openai.com')
    ) {
      return 'unknown'
    }
    if (url.pathname.startsWith('/auth/')) return 'signed_out'

    const visible = async (candidate: string): Promise<boolean> => {
      try {
        return await this.page.locator(candidate).isVisible()
      } catch {
        return false
      }
    }
    for (const candidate of selectors.auth.challenge) {
      if (await visible(candidate)) return 'challenge'
    }
    for (const candidate of selectors.auth.restricted) {
      if (await visible(candidate)) return 'restricted'
    }
    for (const candidate of [
      ...selectors.auth.loginButton,
      ...selectors.auth.noAuthModal,
      ...selectors.auth.expiredSessionModal,
      ...selectors.auth.loginForm,
    ]) {
      if (await visible(candidate)) return 'signed_out'
    }
    for (const candidate of selectors.auth.authenticated) {
      if (await visible(candidate)) return 'authenticated'
    }
    return 'unknown'
  }

  public async isLoggedIn(): Promise<boolean> {
    return (await this.getAccessState()) === 'authenticated'
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
    try {
      const items = await this.discoverActionItems()
      return CHATGPT_DEFINITION.capabilities.flatMap((capability) => {
        const item = items.find(({ name }) => name === capability.key)
        return item === undefined
          ? []
          : [{ name: item.name, state: item.state }]
      })
    } finally {
      await this.closeCapabilityMenu()
    }
  }

  public async selectActionCapability(
    capability: string
  ): Promise<ChatGPTActionCapabilityState> {
    if (!(capability in capabilityIdentityTokens)) {
      return 'unavailable'
    }
    await this.openCapabilityMenu()
    try {
      const before = await this.discoverActionItems()
      const item = before.find(({ name }) => name === capability)
      if (item === undefined || item.state === 'disabled') {
        return item?.state ?? 'unavailable'
      }
      await item.locator.click()
    } finally {
      await this.closeCapabilityMenu()
    }
    await this.openCapabilityMenu()
    try {
      const after = await this.discoverActionItems()
      return after.find(({ name }) => name === capability)?.state === 'selected'
        ? 'selected'
        : 'unavailable'
    } finally {
      await this.closeCapabilityMenu()
    }
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
    if (await this.isCapabilityMenuOpen()) {
      return
    }
    await this.page
      .locator(joinCssLocatorCandidates(selectors.capability.trigger))
      .click()
    await waitAsync(async () => await this.isCapabilityMenuOpen(), {
      timeoutMs: 1000,
    }).catch(() => {})
  }

  private async closeCapabilityMenu(): Promise<void> {
    if (!(await this.isCapabilityMenuOpen())) return
    const trigger = this.page.locator(
      joinCssLocatorCandidates(selectors.capability.trigger)
    )
    if (
      (await trigger.count().catch(() => 0)) === 1 &&
      (await trigger.isVisible().catch(() => false))
    ) {
      await trigger.click()
    }
    await waitAsync(async () => !(await this.isCapabilityMenuOpen()), {
      timeoutMs: 1000,
      onTimeout: async () => {
        throw new ProviderAdapterError(
          'capabilities',
          'ChatGPT capability menu did not close after selection.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'chatgpt_capability_menu_close_failed',
          }
        )
      },
    })
  }

  private async isCapabilityMenuOpen(): Promise<boolean> {
    const groups = this.page.locator(
      joinCssLocatorCandidates(selectors.capability.group)
    )
    const groupCount = await groups.count().catch(() => 0)
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      if (
        await groups
          .nth(groupIndex)
          .isVisible()
          .catch(() => false)
      ) {
        return true
      }
    }
    return false
  }

  private async discoverActionItems(): Promise<
    Array<{
      name: string
      state: ChatGPTActionCapabilityState
      locator: Locator
    }>
  > {
    const groups = this.page.locator(
      joinCssLocatorCandidates(selectors.capability.group)
    )
    const result: Array<{
      name: string
      state: ChatGPTActionCapabilityState
      locator: Locator
    }> = []
    const groupCount = await groups.count().catch(() => 0)
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const group = groups.nth(groupIndex)
      if (!(await group.isVisible().catch(() => false))) continue
      const items = group.locator('xpath=./div')
      const itemCount = await items.count().catch(() => 0)
      for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
        const locator = items.nth(itemIndex)
        if (!(await locator.isVisible().catch(() => false))) continue
        const identity = await this.readStableIdentity(locator)
        const name = Object.entries(capabilityIdentityTokens)
          .filter(([, tokens]) =>
            tokens.some((token) => identity.includes(token))
          )
          .sort(
            (left, right) =>
              Math.max(...right[1].map((token) => token.length)) -
              Math.max(...left[1].map((token) => token.length))
          )[0]?.[0]
        if (name === undefined) continue
        if (result.some((entry) => entry.name === name)) {
          throw new ProviderAdapterError(
            'capabilities',
            `ChatGPT capability "${name}" was discovered more than once.`,
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'chatgpt_capability_identity_ambiguous',
            }
          )
        }
        const disabled =
          (await locator.getAttribute('aria-disabled').catch(() => null)) ===
            'true' ||
          (await locator.getAttribute('data-disabled').catch(() => null)) ===
            'true'
        const selected =
          (await locator.getAttribute('aria-checked').catch(() => null)) ===
            'true' ||
          (await locator.getAttribute('data-state').catch(() => null)) ===
            'selected'
        result.push({
          name,
          state: disabled ? 'disabled' : selected ? 'selected' : 'available',
          locator,
        })
      }
    }
    return result
  }

  private async readStableIdentity(locator: Locator): Promise<string> {
    const attributes = [
      'data-testid',
      'data-action',
      'data-capability',
      'data-tool',
      'data-mode',
      'id',
    ]
    for (const attribute of attributes) {
      const value = await locator.getAttribute(attribute).catch(() => null)
      if (value !== null && value.trim() !== '') return value.toLowerCase()
    }
    for (const selector of attributes.map((attribute) => `[${attribute}]`)) {
      const nested = locator.locator(selector)
      const count = await nested.count().catch(() => 0)
      for (let index = 0; index < count; index += 1) {
        const target = nested.nth(index)
        for (const attribute of attributes) {
          const value = await target.getAttribute(attribute).catch(() => null)
          if (value !== null && value.trim() !== '') return value.toLowerCase()
        }
      }
    }
    return ''
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
