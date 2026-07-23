import type { Locator, Page } from 'playwright'

import { waitAsync } from '../../../shared/wait.ts'
import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import {
  defineProviderUiCapabilityMap,
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
} from '../provider-ui.ts'

const modelPositions = defineProviderUiModelPositions('deepseek', {
  quick: 1,
  expert: 2,
  vision: 3,
})
const capabilityPositions = defineProviderUiCapabilityMap('deepseek', {
  thinking: 1,
  search: 2,
} as const)
const DEEPSEEK_STOP_ICON_PATH_PREFIX =
  'M2 4.88C2 3.68009 2 3.08013 2.30557 2.65954C2.40426 2.52371 2.52371 2.40426 2.65954'

const selectors = defineProviderUiSelectors({
  readyButton: ['div[role="button"][class*="bd74640a"]'],
  capabilityToggle: ['div.f79352dc'],
  uploadButton: ['div[role="button"].f02f0e25'],
  sendButton: ['div._52c986b'],
  modelItem: ['div.b0db7355 div[role="radio"][data-model-type]'],
  composer: ['textarea'],
  stopButton: [
    `div[role="button"]:has(svg[viewBox^="0 0 16"] path[d^="${DEEPSEEK_STOP_ICON_PATH_PREFIX}"])`,
  ],
})

const DEEPSEEK_SEND_BUTTON_DISABLED_CLASS = 'ds-button--disabled'

export type DeepSeekToggleCapability = keyof typeof capabilityPositions
export type DeepSeekToggleState = 'on' | 'off'

export interface DeepSeekRetryLocators {
  readonly composer: Locator
  readonly send: Locator
  readonly stop: Locator
}

export class DeepSeekUi {
  public constructor(private readonly page: Page) {}

  public async isLoggedIn(): Promise<boolean> {
    return (
      this.page.url().startsWith('https://chat.deepseek.com') &&
      !this.page.url().includes('/sign_in')
    )
  }

  public async hasToggleCapability(
    capability: DeepSeekToggleCapability
  ): Promise<boolean> {
    const requiredCount = capabilityPositions[capability]
    return (await this.getToggleButtons().count()) >= requiredCount
  }

  public async getToggleState(
    capability: DeepSeekToggleCapability
  ): Promise<DeepSeekToggleState> {
    if (!(await this.hasToggleCapability(capability))) {
      throw new ProviderAdapterUnsupportedError(
        `${capability}Status`,
        `DeepSeek ${capability} capability is not available on this page.`
      )
    }
    const value =
      await this.getToggleButton(capability).getAttribute('aria-pressed')
    return value === 'true' ? 'on' : 'off'
  }

  public async setToggleState(
    capability: DeepSeekToggleCapability,
    targetState: DeepSeekToggleState
  ): Promise<DeepSeekToggleState> {
    const button = this.getToggleButton(capability)
    const currentState = await this.getToggleState(capability)
    if (currentState !== targetState) {
      await button.click()
    }
    return await this.getToggleState(capability)
  }

  public async waitForReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(async () => await this.isReady(), {
      timeoutMs,
      signal,
      onTimeout: async () => {
        throw new ProviderAdapterError(
          action,
          action === 'restore'
            ? 'DeepSeek did not become ready after loading.'
            : 'DeepSeek finished responding, but the page did not become ready for the next message.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'deepseek_ready_button_missing',
          }
        )
      },
    })
  }

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    if (model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `DeepSeek model "${model.key}" does not support option "${model.option}".`
      )
    }
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `DeepSeek does not support model "${model.key}".`
      )
    }
    const modelIndex = position - 1
    const modelButtons = this.page.locator(
      joinCssLocatorCandidates(selectors.modelItem)
    )
    if ((await modelButtons.count()) <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `DeepSeek does not have model "${model.key}".`
      )
    }
    await modelButtons.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    await this.page
      .locator(joinCssLocatorCandidates(selectors.composer))
      .click()
    await this.page.keyboard.insertText(text)
  }

  public getRetryLocators(): DeepSeekRetryLocators {
    return {
      composer: this.page.locator(joinCssLocatorCandidates(selectors.composer)),
      send: this.page.locator(joinCssLocatorCandidates(selectors.sendButton)),
      stop: this.page.locator(joinCssLocatorCandidates(selectors.stopButton)),
    }
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const uploadButtons = this.page.locator(
      joinCssLocatorCandidates(selectors.uploadButton)
    )
    if ((await uploadButtons.count()) === 0) {
      throw this.createUploadUnsupportedError()
    }
    const uploadButton = uploadButtons.first()
    const isAvailable =
      (await uploadButton.isVisible().catch(() => false)) &&
      (await uploadButton.isEnabled().catch(() => false))
    if (!isAvailable) {
      throw this.createUploadUnsupportedError()
    }
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      uploadButton.click(),
    ])
    await fileChooser.setFiles(path)
  }

  public async stopGeneration(): Promise<void> {
    const stopButtons = this.page.locator(
      joinCssLocatorCandidates(selectors.stopButton)
    )
    if ((await stopButtons.count().catch(() => 0)) !== 1) {
      return
    }
    const stopButton = stopButtons.first()
    if (!(await stopButton.isVisible().catch(() => false))) {
      return
    }
    await stopButton.click().catch(() => {})
  }

  public async waitForSendReady(
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(async () => await this.isSendReady(), {
      timeoutMs,
      signal,
    })
  }

  public async clickSend(): Promise<void> {
    await this.page
      .locator(joinCssLocatorCandidates(selectors.sendButton))
      .first()
      .click()
  }

  private getToggleButtons(): Locator {
    return this.page.locator(
      joinCssLocatorCandidates(selectors.capabilityToggle)
    )
  }

  private getToggleButton(capability: DeepSeekToggleCapability): Locator {
    return this.getToggleButtons().nth(capabilityPositions[capability] - 1)
  }

  private async isReady(): Promise<boolean> {
    const readyButtons = this.page.locator(
      joinCssLocatorCandidates(selectors.readyButton)
    )
    if ((await readyButtons.count().catch(() => 0)) !== 1) return false
    return await readyButtons
      .first()
      .isVisible()
      .catch(() => false)
  }

  private async isSendReady(): Promise<boolean> {
    const sendButton = this.page
      .locator(joinCssLocatorCandidates(selectors.sendButton))
      .first()
    const className = await sendButton.getAttribute('class').catch(() => null)
    return (
      (await sendButton.isEnabled().catch(() => false)) &&
      (await sendButton.isVisible().catch(() => false)) &&
      !className?.split(/\s+/).includes(DEEPSEEK_SEND_BUTTON_DISABLED_CLASS)
    )
  }

  private createUploadUnsupportedError(): ProviderAdapterUnsupportedError {
    return new ProviderAdapterUnsupportedError(
      'attachFile',
      'DeepSeek file upload is not available in the current conversation.'
    )
  }
}
