import type { Locator, Page } from 'playwright'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import {
  isResolvedProviderModelSupported,
  type ResolvedProviderModel,
} from '../../provider-model-catalog.ts'
import { waitAsync } from '../../../shared/wait.ts'
import {
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
} from '../provider-ui.ts'

const GEMINI_CHAT_URL = 'https://gemini.google.com/app'
const modelPositions = defineProviderUiModelPositions('gemini', {
  '3.5-flash-lite': 1,
  '3.6-flash': 2,
  '3.1-pro': 3,
})

const selectors = defineProviderUiSelectors({
  auth: {
    signedOut: ['[data-test-id="conversations-list-signed-out"]'],
  },
  model: {
    trigger: ['[data-test-id="bard-mode-menu-button"]'],
    menu: ['gem-menu[data-test-id="gem-mode-menu"]'],
    item: ['gem-menu-item'],
  },
  composer: {
    editor: [
      '[data-test-id="textarea-wrapper"] rich-textarea [contenteditable="true"]',
      '[data-test-id="textarea-inner"][contenteditable="true"]',
      '[data-test-id="textarea-inner"] [contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
    ],
    inner: ['[data-test-id="textarea-inner"]'],
    textarea: ['rich-textarea'],
    sendButton: ['[data-test-id="send-button-container"] button'],
    sendButtonContainer: ['[data-test-id="send-button-container"]'],
    microphoneButton: [
      'button.speech_dictation_mic_button',
      '[data-node-type="speech_dictation_mic_button"] .speech_dictation_mic_button',
      'speech-dictation-mic-button .speech_dictation_mic_button',
    ],
  },
  capability: {
    menuTrigger: ['div.has-model-picker button'],
    item: ['button[role="menuitemcheckbox"]'],
    icon: ['[data-mat-icon-name]'],
    moreToolsTrigger: ['button[data-test-id="more-tools-button"]'],
    selected: [
      'gem-button[data-test-id="deselect-drawer-item-gem-button"] > button',
    ],
    uploadAction: ['images-files-uploader button'],
  },
  history: {
    scroller: ['infinite-scroller.chat-history'],
  },
})

export type GeminiActionCapabilityState =
  | 'available'
  | 'selected'
  | 'disabled'
  | 'unavailable'

export interface GeminiActionCapabilityInfo {
  name: string
  state: GeminiActionCapabilityState
}

export class GeminiUi {
  public constructor(private readonly page: Page) {}

  public async isLoggedIn(): Promise<boolean> {
    if (!this.page.url().startsWith(GEMINI_CHAT_URL)) {
      return false
    }
    return !(await this.page
      .locator(joinCssLocatorCandidates(selectors.auth.signedOut))
      .isVisible()
      .catch(() => false))
  }

  public async scrollHistoryToTop(): Promise<boolean> {
    return await this.page
      .evaluate((historySelector) => {
        const candidates = [
          document.querySelector(historySelector),
          document.scrollingElement,
        ]
        let foundScrollable = false
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) continue
          if (candidate.scrollHeight <= candidate.clientHeight + 40) continue
          foundScrollable = true
          candidate.scrollTo({ top: 0, behavior: 'auto' })
          candidate.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
        return foundScrollable
      }, selectors.history.scroller[0])
      .catch(() => false)
  }

  public async changeModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (
      position === undefined ||
      !isResolvedProviderModelSupported('gemini', model)
    ) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Gemini does not support model "${model.key}"${
          model.option === null ? '' : ` with option "${model.option}"`
        }.`
      )
    }

    const modelIndex = position - 1
    const modelMenu = await this.openModelMenu()
    const menuItems = modelMenu.locator(
      joinCssLocatorCandidates(selectors.model.item)
    )
    const itemCount = await menuItems.count()
    if (itemCount - 1 <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Gemini does not have model ${position}.`
      )
    }
    await menuItems.nth(modelIndex).click()
    await this.waitForModelMenuClosed()

    if (model.option === null) {
      return
    }

    const extensionMenu = await this.openModelMenu()
    const extensionItem = await this.getModelExtensionItem(
      extensionMenu,
      modelIndex
    )
    if (!(await this.isModelExtensionItemSelected(extensionItem))) {
      await extensionItem.click()
    } else {
      await this.closeModelMenu()
    }
  }

  public async attachText(text: string): Promise<void> {
    const editor = this.page.locator(selectors.composer.editor[0]).first()
    const inner = this.page
      .locator(joinCssLocatorCandidates(selectors.composer.inner))
      .first()
    const textarea = this.page
      .locator(joinCssLocatorCandidates(selectors.composer.textarea))
      .first()
    if (await editor.isVisible().catch(() => false)) {
      await editor.click()
    } else if (await inner.isVisible().catch(() => false)) {
      await inner.click()
    } else {
      await textarea.click()
    }
    await this.page.keyboard.insertText(text)
  }

  public getRetryComposer(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.composer.editor)
    )
  }

  public getRetryStopButton(): Locator {
    return this.getStopButton()
  }

  public getRetrySendButton(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.composer.sendButton)
    )
  }

  public getSendButton(): Locator {
    return this.getRetrySendButton().first()
  }

  public async listActionCapabilities(): Promise<GeminiActionCapabilityInfo[]> {
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
        if (name === null || seen.has(name)) continue
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

  public async clearActionCapability(): Promise<void> {
    const selectedButton = this.getSelectedActionCapabilityButton()
    if ((await selectedButton.count().catch(() => 0)) === 0) return
    if (!(await selectedButton.isVisible().catch(() => false))) return
    await selectedButton.click()
  }

  public async selectActionCapability(
    capability: string
  ): Promise<GeminiActionCapabilityState> {
    await this.clearActionCapability()
    await this.openActionCapabilityMenu('selectCapability')
    await this.expandMoreActionCapabilities()

    const buttons = this.getActionCapabilityButtons()
    const count = await buttons.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index)
      if ((await this.readActionCapabilityName(button)) !== capability) continue
      if (
        (await button.getAttribute('aria-disabled').catch(() => null)) ===
        'true'
      ) {
        return 'disabled'
      }
      await button.click()
      return 'selected'
    }
    return 'unavailable'
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const paths = typeof path === 'string' ? [path] : [...path]
    const uploadTrigger = this.getUploadTrigger()
    const uploadAction = this.page
      .locator(joinCssLocatorCandidates(selectors.capability.uploadAction))
      .first()

    if ((await uploadTrigger.count()) === 0) {
      throw new ProviderAdapterError(
        'attachFile',
        'Gemini upload trigger was not found.',
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
        'Gemini upload action was not found.',
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
  }

  public async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(this.getStopButton())
  }

  public async waitForComposerReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () => {
        const microphoneButtons = this.page.locator(
          joinCssLocatorCandidates(selectors.composer.microphoneButton)
        )
        if ((await microphoneButtons.count().catch(() => 0)) !== 1) {
          return false
        }
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

  private async openModelMenu(): Promise<Locator> {
    const modelMenu = this.page
      .locator(joinCssLocatorCandidates(selectors.model.menu))
      .last()
    if (!(await modelMenu.isVisible().catch(() => false))) {
      await this.page
        .locator(joinCssLocatorCandidates(selectors.model.trigger))
        .click()
      await waitAsync(
        async () => await modelMenu.isVisible().catch(() => false),
        { timeoutMs: 5000 }
      )
    }
    return modelMenu
  }

  private async closeModelMenu(): Promise<void> {
    const modelMenu = this.page
      .locator(joinCssLocatorCandidates(selectors.model.menu))
      .last()
    if (await modelMenu.isVisible().catch(() => false)) {
      await this.page
        .locator(joinCssLocatorCandidates(selectors.model.trigger))
        .click()
      await this.waitForModelMenuClosed()
    }
  }

  private async waitForModelMenuClosed(): Promise<void> {
    const modelMenu = this.page
      .locator(joinCssLocatorCandidates(selectors.model.menu))
      .last()
    await waitAsync(
      async () => !(await modelMenu.isVisible().catch(() => false)),
      { timeoutMs: 5000 }
    )
  }

  private async getModelExtensionItem(
    modelMenu: Locator,
    modelIndex: number
  ): Promise<Locator> {
    const extensionItems = modelMenu.locator(
      joinCssLocatorCandidates(selectors.model.item)
    )
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
    if (ariaChecked !== null) return ariaChecked === 'true'
    const ariaSelected = await item
      .getAttribute('aria-selected')
      .catch(() => null)
    if (ariaSelected !== null) return ariaSelected === 'true'
    const className = await item.getAttribute('class').catch(() => null)
    return className === null ? false : /\b(selected|checked)\b/.test(className)
  }

  private getUploadTrigger(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(selectors.capability.menuTrigger))
      .first()
  }

  private getActionCapabilityButtons(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.capability.item)
    )
  }

  private getMoreToolsButton(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(selectors.capability.moreToolsTrigger))
      .first()
  }

  private getSelectedActionCapabilityButton(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(selectors.capability.selected))
      .first()
  }

  private async openActionCapabilityMenu(action: string): Promise<void> {
    const buttons = this.getActionCapabilityButtons()
    if ((await buttons.count().catch(() => 0)) > 0) return
    const trigger = this.getUploadTrigger()
    if ((await trigger.count().catch(() => 0)) === 0) {
      throw new ProviderAdapterError(
        action,
        'Gemini capability trigger was not found.',
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
    if ((await moreToolsButton.count().catch(() => 0)) === 0) return
    if (!(await moreToolsButton.isVisible().catch(() => false))) return
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
      { timeoutMs: 5000 }
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
  ): Promise<string | null> {
    const icon = button
      .locator(joinCssLocatorCandidates(selectors.capability.icon))
      .first()
    const name = await icon.getAttribute('data-mat-icon-name').catch(() => null)
    return typeof name === 'string' && name.trim() ? name.trim() : null
  }

  private getStopButton(): Locator {
    return this.page
      .locator(joinCssLocatorCandidates(selectors.composer.sendButtonContainer))
      .locator(
        'xpath=./gem-icon-button[contains(concat(" ", normalize-space(@class), " "), " send-button ") and contains(concat(" ", normalize-space(@class), " "), " stop ")]'
      )
      .locator('xpath=./button')
  }

  private async clickLocatorIfReady(locator: Locator): Promise<void> {
    if ((await locator.count().catch(() => 0)) === 0) return
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
