import type { Locator, Page } from 'playwright'

import { waitAsync } from '../../../shared/wait.ts'
import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import {
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  resolveUniqueVisibleLocator,
} from '../provider-ui.ts'

const GROK_SUBSCRIBE_URL = 'https://grok.com/#subscribe'
const modelPositions = defineProviderUiModelPositions('grok', {
  fast: 1,
  auto: 2,
  expert: 3,
  heavy: 4,
})
const GROK_STOP_ICON_PATH_PREFIX = 'M4 9.2v5.6c0 1.116 0 1.673.11 2.134'

const GROK_UI_SELECTORS = defineProviderUiSelectors({
  auth: {
    signedOutActions: [
      '[data-testid="drop-ui"] main > div:first-child button[aria-haspopup="menu"] + button[data-slot="button"] + button[data-slot="button"]',
    ],
  },
  composer: {
    input: [
      '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]',
    ],
    submit: ['[data-testid="chat-submit"]'],
    stop: [
      `button:has(svg[viewBox^="0 0 24"] path[d^="${GROK_STOP_ICON_PATH_PREFIX}"])`,
    ],
    voiceModeReady: [
      'form:has([data-testid="chat-input"]) div:has(> [data-query-bar-mode-select]) button[type="button"]:has(> div > div:nth-child(6):last-child)',
    ],
  },
  upload: {
    input: ['input[type="file"][name="files"]'],
  },
  model: {
    trigger: [
      '#model-select-trigger',
      'button[data-testid="model-select-button"]',
    ],
    menu: [
      '[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]',
      'div[role="menu"]',
    ],
    item: ['div[role="menuitem"][class~="ps-2.5"][class~="flex-row"]'],
  },
} as const)

export interface GrokRetryLocators {
  readonly composer: Locator
  readonly send: Locator
  readonly stop: Locator
}

export class GrokUi {
  public constructor(private readonly page: Page) {}

  public async isSignedOutVisible(): Promise<boolean> {
    return (
      (await resolveUniqueVisibleLocator(
        this.page,
        GROK_UI_SELECTORS.auth.signedOutActions
      )) !== null
    )
  }

  public async waitForVoiceModeReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(
      async () =>
        (await resolveUniqueVisibleLocator(
          this.page,
          GROK_UI_SELECTORS.composer.voiceModeReady
        )) !== null,
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            action === 'restore'
              ? 'Grok voice mode control did not become ready after loading.'
              : 'Grok finished responding, but its voice mode control did not become ready for the next message.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'grok_voice_mode_ready_missing',
            }
          )
        },
      }
    )
  }

  public async isSubmitReady(): Promise<boolean> {
    const submit = await resolveUniqueVisibleLocator(
      this.page,
      GROK_UI_SELECTORS.composer.submit
    )
    return submit !== null && (await submit.isEnabled().catch(() => false))
  }

  public async isComposerIdle(): Promise<boolean> {
    const input = await resolveUniqueVisibleLocator(
      this.page,
      GROK_UI_SELECTORS.composer.input
    )
    if (
      input === null ||
      (await input.getAttribute('aria-disabled').catch(() => null)) === 'true'
    ) {
      return false
    }

    const submitButtons = this.page.locator(
      joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.submit)
    )
    if ((await submitButtons.count().catch(() => 0)) === 0) {
      return true
    }
    const submit = submitButtons.first()
    return (
      !(await submit.isVisible().catch(() => false)) ||
      !(await submit.isEnabled().catch(() => true))
    )
  }

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined || model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok does not support model "${model.key}"${
          model.option === null ? '' : ` with option "${model.option}"`
        }.`
      )
    }

    const modelIndex = position - 1
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      GROK_UI_SELECTORS.model.trigger
    )
    if (trigger === null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'Grok model selection is not available in the current conversation.'
      )
    }
    await trigger.click()

    const menus = this.page.locator(
      joinCssLocatorCandidates(GROK_UI_SELECTORS.model.menu)
    )
    await waitAsync(
      async () =>
        await menus
          .last()
          .isVisible()
          .catch(() => false),
      { timeoutMs: 5000 }
    )
    const modelItems = menus
      .last()
      .locator(joinCssLocatorCandidates(GROK_UI_SELECTORS.model.item))
    if ((await modelItems.count()) <= modelIndex) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok does not have model "${model.key}".`
      )
    }
    await modelItems.nth(modelIndex).click()
    if (this.page.url() === GROK_SUBSCRIBE_URL) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Grok model "${model.key}" requires a subscription.`
      )
    }
  }

  public async attachText(text: string): Promise<void> {
    const input = this.page
      .locator(joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.input))
      .first()
    await input.click()
    await this.page.keyboard.insertText(text)
  }

  public getRetryLocators(): GrokRetryLocators {
    return {
      composer: this.page.locator(
        joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.input)
      ),
      send: this.page.locator(
        joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.submit)
      ),
      stop: this.page.locator(
        joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.stop)
      ),
    }
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const input = this.page
      .locator(joinCssLocatorCandidates(GROK_UI_SELECTORS.upload.input))
      .first()
    if ((await input.count().catch(() => 0)) === 0) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'Grok file upload is not available in the current conversation.'
      )
    }
    await input.setInputFiles(typeof path === 'string' ? [path] : [...path])
  }

  public async stopGeneration(): Promise<void> {
    const buttons = this.page.locator(
      joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.stop)
    )
    if ((await buttons.count().catch(() => 0)) !== 1) return
    const button = buttons.first()
    if (!(await button.isVisible().catch(() => false))) return
    await button.click().catch(() => {})
  }

  public async clickSubmit(): Promise<void> {
    await this.page
      .locator(joinCssLocatorCandidates(GROK_UI_SELECTORS.composer.submit))
      .first()
      .click()
  }
}
