import type { Locator, Page } from 'playwright'

import { waitAsync } from '../../../shared/wait.ts'
import {
  delayAsync,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import {
  defineProviderUiCapabilityMap,
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  resolveUniqueVisibleLocator,
} from '../provider-ui.ts'

const modelPositions = defineProviderUiModelPositions('glm', {
  'glm-5.2': 1,
  'glm-5.1': 2,
  'glm-5-turbo': 3,
  'glm-5v-turbo': 4,
  'glm-4.7': 5,
})
const GLM_UI_SELECTORS = defineProviderUiSelectors({
  auth: {
    signedOutAvatar: [
      'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox^="0 0 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]',
    ],
  },
  composer: {
    input: ['#chat-input'],
    send: ['#send-message-button'],
    stop: ['.messageInputContainer button.bg-black.rounded-full'],
  },
  upload: {
    button: ['#upload-file-button'],
  },
  model: {
    trigger: ['button[id^="model-selector-"]'],
    menu: ['[data-dropdown-menu-content]'],
    item: ['button[data-value]'],
  },
  capability: {
    advancedSearchSwitch: [
      '[data-tooltip-content] button[role="switch"][data-switch-root]',
    ],
    thinking: ['button[data-autothink]'],
    search: ['button[data-active]:has(svg[viewBox^="0 0 15"])'],
  },
  overlay: {
    blockingDialog: ['[data-dialog-overlay][data-state="open"]'],
  },
} as const)

const GLM_CAPABILITY_UI = defineProviderUiCapabilityMap('glm', {
  thinking: {
    selector: GLM_UI_SELECTORS.capability.thinking,
    stateAttribute: 'data-autothink',
  },
  search: {
    selector: GLM_UI_SELECTORS.capability.search,
    stateAttribute: 'data-active',
  },
  advanced_search: {
    selector: GLM_UI_SELECTORS.capability.advancedSearchSwitch,
    stateAttribute: 'data-state',
  },
} as const)

export type GlmToggleCapability = keyof typeof GLM_CAPABILITY_UI
export type GlmToggleState = 'on' | 'off'
type GlmRestorePageState = 'signed_out' | 'ready'
type GlmSignedOutIndicatorState = 'absent' | 'ambiguous' | 'visible'

export interface GlmRetryLocators {
  readonly composer: Locator
  readonly send: Locator
  readonly stop: Locator
}

interface GlmAdvancedSearchSnapshot {
  readonly enabled: boolean
  readonly state: GlmToggleState
}

export class GlmUi {
  public constructor(private readonly page: Page) {}

  public async hasToggleCapability(
    capability: GlmToggleCapability
  ): Promise<boolean> {
    if (capability === 'advanced_search') {
      try {
        const snapshot = await this.getAdvancedSearchSnapshot()
        return snapshot !== null && snapshot.enabled
      } finally {
        await this.closeAdvancedSearchTooltip()
      }
    }
    const button = await resolveUniqueVisibleLocator(
      this.page,
      GLM_CAPABILITY_UI[capability].selector
    )
    return button !== null
  }

  public async getToggleState(
    capability: GlmToggleCapability
  ): Promise<GlmToggleState> {
    if (capability === 'advanced_search') {
      try {
        const snapshot = await this.getAdvancedSearchSnapshot()
        if (snapshot === null || !snapshot.enabled) {
          throw new ProviderAdapterUnsupportedError(
            `${capability}Status`,
            'GLM advanced_search capability is not available on this page.'
          )
        }
        return snapshot.state
      } finally {
        await this.closeAdvancedSearchTooltip()
      }
    }
    const button = await resolveUniqueVisibleLocator(
      this.page,
      GLM_CAPABILITY_UI[capability].selector
    )
    if (button === null) {
      throw new ProviderAdapterUnsupportedError(
        `${capability}Status`,
        `GLM ${capability} capability is not available on this page.`
      )
    }
    const attribute = GLM_CAPABILITY_UI[capability].stateAttribute
    return (await button.getAttribute(attribute)) === 'true' ? 'on' : 'off'
  }

  public async setToggleState(
    capability: GlmToggleCapability,
    targetState: GlmToggleState
  ): Promise<GlmToggleState> {
    if (capability === 'advanced_search') {
      try {
        if (targetState === 'on') {
          await this.setToggleState('thinking', 'on')
          await this.setToggleState('search', 'on')
        }
        if ((await this.applyAdvancedSearchState(targetState)) !== true) {
          throw new ProviderAdapterUnsupportedError(
            `${capability}Set`,
            'GLM advanced_search capability is not available on this page.'
          )
        }
        await waitAsync(
          async () =>
            (await this.getAdvancedSearchSnapshot())?.state === targetState,
          { timeoutMs: 5000 }
        )
        return targetState
      } finally {
        await this.closeAdvancedSearchTooltip()
      }
    }
    const button = await resolveUniqueVisibleLocator(
      this.page,
      GLM_CAPABILITY_UI[capability].selector
    )
    if (button === null) {
      throw new ProviderAdapterUnsupportedError(
        `${capability}Set`,
        `GLM ${capability} capability is not available on this page.`
      )
    }
    const currentState = await this.getToggleState(capability)
    if (currentState !== targetState) await button.click()
    return await this.getToggleState(capability)
  }

  public async waitForReady(
    action: 'restore' | 'submit',
    timeoutMs: number | null,
    signal?: AbortSignal
  ): Promise<void> {
    await waitAsync(async () => await this.isReadyButtonVisible(), {
      timeoutMs,
      signal,
      onTimeout: async () => {
        throw new ProviderAdapterError(
          action,
          action === 'restore'
            ? 'GLM did not become ready after loading.'
            : 'GLM finished responding, but the send button did not become visible again.',
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'glm_ready_button_missing',
          }
        )
      },
    })
  }

  public async waitForRestorePageState(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<GlmRestorePageState> {
    let signedOut = false
    await waitAsync(
      async () => {
        const signedOutIndicator = await this.getSignedOutIndicatorState()
        if (signedOutIndicator === 'visible') {
          signedOut = true
          return true
        }
        if (signedOutIndicator === 'ambiguous') return false
        return await this.isReadyButtonVisible()
      },
      {
        timeoutMs,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            'restore',
            'GLM did not become ready after loading.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'glm_ready_button_missing',
            }
          )
        },
      }
    )
    return signedOut ? 'signed_out' : 'ready'
  }

  public async isLoggedIn(): Promise<boolean> {
    return (await this.getSignedOutIndicatorState()) === 'absent'
  }

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined || model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `GLM does not support model "${model.key}".`
      )
    }
    const modelIndex = position - 1
    await this.dismissBlockingDialog('changeModel')
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      GLM_UI_SELECTORS.model.trigger
    )
    if (trigger === null) {
      throw new ProviderAdapterError(
        'changeModel',
        'GLM model selector was missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'glm_model_trigger_invalid',
        }
      )
    }
    await trigger.click()
    const menus = this.page.locator(
      joinCssLocatorCandidates(GLM_UI_SELECTORS.model.menu, ':visible')
    )
    const scopedItems = menus.locator(
      joinCssLocatorCandidates(GLM_UI_SELECTORS.model.item)
    )
    const globalItems = this.page.locator(
      joinCssLocatorCandidates(GLM_UI_SELECTORS.model.item, ':visible')
    )
    await waitAsync(
      async () =>
        (await scopedItems.count().catch(() => 0)) > 0 ||
        (await globalItems.count().catch(() => 0)) > 0,
      { timeoutMs: 5000 }
    )
    if ((await menus.count()) > 1) {
      throw new ProviderAdapterError(
        'changeModel',
        'GLM model menu was ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'glm_model_menu_ambiguous',
        }
      )
    }
    const useScopedItems = (await scopedItems.count()) > 0
    const items = useScopedItems ? scopedItems : globalItems
    if (
      !useScopedItems &&
      !(await items.evaluateAll(
        (candidates) =>
          new Set(candidates.map((candidate) => candidate.parentElement))
            .size === 1
      ))
    ) {
      throw new ProviderAdapterError(
        'changeModel',
        'GLM model options were ambiguous.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'glm_model_options_ambiguous',
        }
      )
    }
    if ((await items.count()) <= modelIndex) {
      await this.page.keyboard.press('Escape').catch(() => {})
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `GLM does not have model "${model.key}".`
      )
    }
    await items.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    await this.dismissBlockingDialog('attachText')
    const composer = this.page
      .locator(joinCssLocatorCandidates(GLM_UI_SELECTORS.composer.input))
      .first()
    try {
      await composer.click({ timeout: 2000 })
    } catch {
      await this.dismissBlockingDialog('attachText')
      await composer.click()
    }
    await this.page.keyboard.insertText(text)
  }

  public getRetryLocators(): GlmRetryLocators {
    return {
      composer: this.page.locator(
        joinCssLocatorCandidates(GLM_UI_SELECTORS.composer.input)
      ),
      send: this.page.locator(
        joinCssLocatorCandidates(GLM_UI_SELECTORS.composer.send)
      ),
      stop: this.page.locator(
        joinCssLocatorCandidates(GLM_UI_SELECTORS.composer.stop)
      ),
    }
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    await this.dismissBlockingDialog('attachFile')
    const uploadButton = await resolveUniqueVisibleLocator(
      this.page,
      GLM_UI_SELECTORS.upload.button
    )
    if (uploadButton === null) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'GLM file upload is not available in the current conversation.'
      )
    }
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      uploadButton.click(),
    ])
    await fileChooser.setFiles(path)
  }

  public async stopGeneration(): Promise<void> {
    const stop = await resolveUniqueVisibleLocator(
      this.page,
      GLM_UI_SELECTORS.composer.stop
    )
    if (stop !== null) await stop.click().catch(() => {})
  }

  public async isSendReady(): Promise<boolean> {
    const send = await resolveUniqueVisibleLocator(
      this.page,
      GLM_UI_SELECTORS.composer.send
    )
    return send !== null && (await send.isEnabled().catch(() => false))
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
    const send = await resolveUniqueVisibleLocator(
      this.page,
      GLM_UI_SELECTORS.composer.send
    )
    if (send === null) {
      throw new ProviderAdapterError(
        'submit',
        'GLM send button was not ready.',
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: 'glm_send_button_not_ready',
        }
      )
    }
    await send.click()
  }

  public async dismissBlockingDialog(
    action: string,
    signal?: AbortSignal
  ): Promise<void> {
    const overlay = this.page
      .locator(
        joinCssLocatorCandidates(GLM_UI_SELECTORS.overlay.blockingDialog)
      )
      .first()
    if (!(await overlay.isVisible().catch(() => false))) return
    if (signal?.aborted) throw signal.reason
    await this.page.keyboard.press('Escape')
    await waitAsync(
      async () => !(await overlay.isVisible().catch(() => false)),
      {
        timeoutMs: 5000,
        signal,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            'GLM has a blocking dialog that could not be dismissed.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              maxAttempts: 1,
              detailCode: 'glm_blocking_dialog',
            }
          )
        },
      }
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
          element.scrollTo({ top: 0, behavior: 'auto' })
          element.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
        return foundScrollable
      })
      .catch(() => false)
  }

  private async isReadyButtonVisible(): Promise<boolean> {
    return (
      (await resolveUniqueVisibleLocator(
        this.page,
        GLM_UI_SELECTORS.composer.send
      )) !== null
    )
  }

  private async getSignedOutIndicatorState(): Promise<GlmSignedOutIndicatorState> {
    const indicators = this.page.locator(
      joinCssLocatorCandidates(GLM_UI_SELECTORS.auth.signedOutAvatar)
    )
    const count = await indicators.count().catch(() => 0)
    if (count === 0) return 'absent'
    if (count !== 1) return 'ambiguous'
    return (await indicators
      .first()
      .isVisible()
      .catch(() => false))
      ? 'visible'
      : 'absent'
  }

  private async findAdvancedSearchSwitch(): Promise<Locator | null> {
    try {
      await this.page.bringToFront()
      await this.page.keyboard.press('Escape').catch(() => {})
      const search = await resolveUniqueVisibleLocator(
        this.page,
        GLM_UI_SELECTORS.capability.search
      )
      if (search === null) return null
      await search.locator('..').hover({ timeout: 5000 })
      return await resolveUniqueVisibleLocator(
        this.page,
        GLM_CAPABILITY_UI.advanced_search.selector
      )
    } catch {
      return null
    }
  }

  private async getAdvancedSearchSnapshot(): Promise<GlmAdvancedSearchSnapshot | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const button = await this.findAdvancedSearchSwitch()
      if (button !== null) {
        const snapshot = await button
          .evaluate((element) => {
            if (!(element instanceof HTMLButtonElement)) return null
            return {
              enabled: !element.disabled,
              state:
                element.getAttribute('aria-checked') === 'true' ? 'on' : 'off',
            } as const
          })
          .catch(() => null)
        if (snapshot !== null) return snapshot
      }
      await delayAsync(100)
    }
    return null
  }

  private async applyAdvancedSearchState(
    targetState: GlmToggleState
  ): Promise<boolean | null> {
    const button = await this.findAdvancedSearchSwitch()
    if (button === null) return null
    return await button
      .evaluate((element, target) => {
        if (!(element instanceof HTMLButtonElement) || element.disabled) {
          return false
        }
        const current =
          element.getAttribute('aria-checked') === 'true' ? 'on' : 'off'
        if (current !== target) element.click()
        return true
      }, targetState)
      .catch(() => null)
  }

  private async closeAdvancedSearchTooltip(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {})
  }
}
