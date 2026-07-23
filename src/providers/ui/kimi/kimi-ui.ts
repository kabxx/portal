import type { Locator, Page } from 'playwright'

import {
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
} from '../../adapters/adapter-base.ts'
import { type ResolvedProviderModel } from '../../provider-model-catalog.ts'
import { waitAsync } from '../../../shared/wait.ts'
import {
  defineProviderUiCapabilityMap,
  defineProviderUiSelectors,
  defineProviderUiModelPositions,
  joinCssLocatorCandidates,
  resolveUniqueVisibleLocator,
} from '../provider-ui.ts'

const KIMI_UI_SELECTORS = defineProviderUiSelectors({
  auth: {
    signedOut: ['button.next-sidebar-history-list__login'],
  },
  composer: {
    input: ['.chat-editor .chat-input-editor[contenteditable="true"]'],
    send: ['.chat-editor .send-button-container'],
    stop: ['.chat-editor .send-button-container.stop'],
  },
  model: {
    trigger: ['.chat-editor .current-model'],
    menu: ['.models-popover'],
    item: ['.models-popover .model-item'],
  },
  toolkit: {
    trigger: ['.chat-editor .toolkit-trigger-btn'],
    popover: ['.toolkit-popover'],
    searchItem: ['.toolkit-item:has(svg[name="InternetOn"])'],
    searchPopover: ['.connect-popover'],
    searchOption: ['.connect-item'],
    selectedOptionIcon: ['svg[name="Check"]'],
  },
  upload: {
    input: ['.toolkit-popover input[type="file"]'],
    card: ['.chat-editor .file-card-container'],
  },
} as const)

const modelPositions = defineProviderUiModelPositions('kimi', {
  'k2.6': 1,
  k3: 2,
  'k3-cluster': 3,
})
const KIMI_CAPABILITY_UI = defineProviderUiCapabilityMap('kimi', {
  search: { storageKey: 'selectSearch' },
} as const)
const KIMI_SEARCH_STORAGE_KEY = KIMI_CAPABILITY_UI.search.storageKey
const KIMI_FILE_UPLOAD_TIMEOUT_MS = 30_000
const KIMI_DEFAULT_UI_TIMEOUT_MS = 5_000

export type KimiToggleState = 'on' | 'off'
export type KimiToggleCapability = keyof typeof KIMI_CAPABILITY_UI

export interface KimiRetryLocators {
  readonly composer: Locator
  readonly send: Locator
  readonly stop: Locator
}

interface KimiSearchToggleSnapshot {
  readonly selectedOptionIndex: number
  readonly state: KimiToggleState
}

export class KimiUi {
  public constructor(
    private readonly page: Page,
    private readonly getCapabilityTimeoutMs: () => number = () =>
      KIMI_DEFAULT_UI_TIMEOUT_MS
  ) {}

  public async isSignedOutVisible(): Promise<boolean> {
    const target = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.auth.signedOut
    )
    return target !== null
  }

  public async isReady(): Promise<boolean> {
    for (const candidates of [
      KIMI_UI_SELECTORS.composer.input,
      KIMI_UI_SELECTORS.composer.send,
      KIMI_UI_SELECTORS.model.trigger,
    ]) {
      if ((await resolveUniqueVisibleLocator(this.page, candidates)) === null) {
        return false
      }
    }
    return true
  }

  public async selectModel(model: ResolvedProviderModel): Promise<void> {
    const position = Object.entries(modelPositions).find(
      ([key]) => key === model.key
    )?.[1]
    if (position === undefined || model.option !== null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `Kimi does not support model "${model.key}"${
          model.option === null ? '' : ` with option "${model.option}"`
        }.`
      )
    }

    const modelIndex = position - 1
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.model.trigger
    )
    if (trigger === null) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        'Kimi model selection is not available in the current conversation.'
      )
    }

    const menu = this.page.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.model.menu)
    )
    const items = this.page.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.model.item)
    )
    try {
      await trigger.click()
      await this.waitForUniqueVisible(menu)
      if ((await items.count()) <= modelIndex) {
        throw new ProviderAdapterUnsupportedError(
          'changeModel',
          `Kimi does not have model "${model.key}".`
        )
      }
      await items.nth(modelIndex).click()
      await this.page.keyboard.press('Escape').catch(() => {})
      await trigger.click()
      await this.waitForUniqueVisible(menu)
      const selectedClass =
        (await items.nth(modelIndex).getAttribute('class')) ?? ''
      if (!selectedClass.split(/\s+/).includes('checked')) {
        throw new ProviderAdapterError(
          'changeModel',
          `Kimi did not verify model "${model.key}" as selected.`,
          {
            kind: 'ui',
            recovery: 'none',
            retryable: false,
            detailCode: 'kimi_model_selection_unverified',
          }
        )
      }
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {})
    }
  }

  public async hasSearchCapability(): Promise<boolean> {
    try {
      const options = await this.openSearchOptions('searchAvailable')
      return (
        options !== null && (await this.readSearchSnapshot(options)) !== null
      )
    } finally {
      await this.closeToolkitMenu()
    }
  }

  public async getSearchState(): Promise<KimiToggleState> {
    try {
      const options = await this.openSearchOptions('searchStatus')
      if (options === null) {
        throw new ProviderAdapterUnsupportedError(
          'searchStatus',
          'Kimi search capability is not available on this page.'
        )
      }
      const snapshot = await this.readSearchSnapshot(options)
      if (snapshot === null) {
        throw this.createSearchStateMissingError('searchStatus')
      }
      return snapshot.state
    } finally {
      await this.closeToolkitMenu()
    }
  }

  public async setSearchState(
    targetState: KimiToggleState
  ): Promise<KimiToggleState> {
    try {
      const options = await this.openSearchOptions('searchSet')
      if (options === null) {
        throw new ProviderAdapterUnsupportedError(
          'searchSet',
          'Kimi search capability is not available on this page.'
        )
      }
      const currentSnapshot = await this.readSearchSnapshot(options)
      if (currentSnapshot === null) {
        throw this.createSearchStateMissingError('searchSet')
      }
      if (currentSnapshot.state === targetState) return currentSnapshot.state

      const targetOptionIndex =
        currentSnapshot.selectedOptionIndex === 0 ? 1 : 0
      await options.nth(targetOptionIndex).click()
      await waitAsync(
        async () => {
          const snapshot = await this.readSearchSnapshot(options)
          return (
            snapshot?.state === targetState &&
            snapshot.selectedOptionIndex === targetOptionIndex
          )
        },
        {
          timeoutMs: this.getCapabilityTimeoutMs(),
          onTimeout: async () => {
            throw new ProviderAdapterError(
              'searchSet',
              `Kimi did not verify search as ${targetState}.`,
              {
                kind: 'ui',
                recovery: 'none',
                retryable: false,
                detailCode: 'kimi_search_state_unverified',
              }
            )
          },
        }
      )
      return targetState
    } finally {
      await this.closeToolkitMenu()
    }
  }

  public async insertText(text: string): Promise<void> {
    const input = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.composer.input
    )
    if (input === null) {
      throw new ProviderAdapterError(
        'attachText',
        'Kimi Composer is missing or ambiguous.',
        {
          kind: 'ui',
          recovery: 'restore',
          retryable: false,
          detailCode: 'kimi_composer_missing',
        }
      )
    }
    await input.click()
    await this.page.keyboard.insertText(text)
  }

  public getRetryLocators(): KimiRetryLocators {
    return {
      composer: this.page.locator(
        joinCssLocatorCandidates(KIMI_UI_SELECTORS.composer.input)
      ),
      send: this.page.locator(
        joinCssLocatorCandidates(
          KIMI_UI_SELECTORS.composer.send,
          ':not(.disabled):not(.stop)'
        )
      ),
      stop: this.page.locator(
        joinCssLocatorCandidates(KIMI_UI_SELECTORS.composer.stop)
      ),
    }
  }

  public async uploadFiles(paths: readonly string[]): Promise<void> {
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.toolkit.trigger
    )
    if (trigger === null) {
      throw new ProviderAdapterUnsupportedError(
        'attachFile',
        'Kimi file upload is not available in the current conversation.'
      )
    }
    await trigger.click()
    const input = this.page.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.upload.input)
    )
    await waitAsync(async () => (await input.count().catch(() => 0)) === 1, {
      timeoutMs: KIMI_DEFAULT_UI_TIMEOUT_MS,
    })
    const cards = this.page.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.upload.card)
    )
    const cardCountBeforeUpload = await cards.count()
    await input.first().setInputFiles(paths)
    await waitAsync(
      async () => {
        if (
          (await cards.count().catch(() => 0)) <
          cardCountBeforeUpload + paths.length
        ) {
          return false
        }
        for (let index = 0; index < paths.length; index += 1) {
          const className =
            (await cards
              .nth(cardCountBeforeUpload + index)
              .getAttribute('class')
              .catch(() => null)) ?? ''
          const classNames = className.split(/\s+/)
          if (
            classNames.some((value) =>
              ['error', 'failed', 'failure'].includes(value)
            )
          ) {
            throw new ProviderAdapterError(
              'attachFile',
              'Kimi file upload failed before submission.',
              {
                kind: 'ui',
                recovery: 'none',
                retryable: false,
                detailCode: 'kimi_file_upload_failed',
              }
            )
          }
          if (!classNames.includes('success')) return false
        }
        return true
      },
      {
        timeoutMs: KIMI_FILE_UPLOAD_TIMEOUT_MS,
        onTimeout: async () => {
          throw new ProviderAdapterError(
            'attachFile',
            'Kimi file upload did not finish before submission.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              detailCode: 'kimi_file_upload_incomplete',
            }
          )
        },
      }
    )
  }

  public async stopGeneration(): Promise<void> {
    const stop = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.composer.stop
    )
    await stop?.click().catch(() => {})
  }

  public async dispatchSubmit(): Promise<void> {
    const sendSelector = KIMI_UI_SELECTORS.composer.send
      .map((candidate) => `${candidate}:not(.disabled):not(.stop)`)
      .join(', ')
    const send = await resolveUniqueVisibleLocator(this.page, [sendSelector])
    if (
      send === null ||
      !(await send.isEnabled().catch(() => false)) ||
      ((await send.getAttribute('class').catch(() => '')) ?? '')
        .split(/\s+/)
        .some((className) => className === 'disabled' || className === 'stop')
    ) {
      throw new ProviderAdapterError(
        'submit',
        'Kimi send control is missing, disabled, or ambiguous.',
        {
          kind: 'ui',
          recovery: 'restore',
          retryable: false,
          detailCode: 'kimi_send_control_unavailable',
        }
      )
    }
    await send.click()
  }

  public async isGenerationSettled(): Promise<boolean> {
    const stopCount = await this.page
      .locator(joinCssLocatorCandidates(KIMI_UI_SELECTORS.composer.stop))
      .count()
      .catch(() => 0)
    return stopCount === 0 && (await this.isReady())
  }

  private async waitForUniqueVisible(locator: Locator): Promise<void> {
    await waitAsync(
      async () => {
        if ((await locator.count().catch(() => 0)) !== 1) return false
        return await locator
          .first()
          .isVisible()
          .catch(() => false)
      },
      { timeoutMs: KIMI_DEFAULT_UI_TIMEOUT_MS }
    )
  }

  private async closeToolkitMenu(): Promise<void> {
    const isClosed = async () => {
      for (const candidates of [
        KIMI_UI_SELECTORS.toolkit.popover,
        KIMI_UI_SELECTORS.toolkit.searchPopover,
      ]) {
        const popovers = this.page.locator(joinCssLocatorCandidates(candidates))
        const count = await popovers.count().catch(() => 0)
        for (let index = 0; index < count; index += 1) {
          if (
            await popovers
              .nth(index)
              .isVisible()
              .catch(() => false)
          ) {
            return false
          }
        }
      }
      return true
    }
    if (await isClosed()) return
    await this.page.keyboard.press('Escape').catch(() => {})
    if (await isClosed()) return
    const composer = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.composer.input
    )
    await composer?.click()
    await waitAsync(isClosed, { timeoutMs: this.getCapabilityTimeoutMs() })
  }

  private async openSearchOptions(
    action: 'searchAvailable' | 'searchStatus' | 'searchSet'
  ): Promise<Locator | null> {
    await this.closeToolkitMenu()
    const trigger = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.toolkit.trigger
    )
    if (trigger === null || !(await trigger.isEnabled().catch(() => false))) {
      return null
    }
    await trigger.click()

    let toolkitPopover: Locator | null = null
    await waitAsync(
      async () => {
        toolkitPopover = await resolveUniqueVisibleLocator(
          this.page,
          KIMI_UI_SELECTORS.toolkit.popover
        )
        return toolkitPopover !== null
      },
      {
        timeoutMs: this.getCapabilityTimeoutMs(),
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            'Kimi toolkit did not open before the capability timeout.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              detailCode: 'kimi_toolkit_open_timeout',
            }
          )
        },
      }
    )
    const resolvedToolkitPopover = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.toolkit.popover
    )
    if (resolvedToolkitPopover === null) return null
    const searchItems = resolvedToolkitPopover.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.toolkit.searchItem)
    )
    if ((await searchItems.count().catch(() => 0)) !== 1) return null
    const searchItem = searchItems.first()
    if (
      !(await searchItem.isVisible().catch(() => false)) ||
      !(await searchItem.isEnabled().catch(() => false))
    ) {
      return null
    }
    await searchItem.click()

    let searchPopover: Locator | null = null
    await waitAsync(
      async () => {
        searchPopover = await resolveUniqueVisibleLocator(
          this.page,
          KIMI_UI_SELECTORS.toolkit.searchPopover
        )
        return searchPopover !== null
      },
      {
        timeoutMs: this.getCapabilityTimeoutMs(),
        onTimeout: async () => {
          throw new ProviderAdapterError(
            action,
            'Kimi search options did not open before the capability timeout.',
            {
              kind: 'ui',
              recovery: 'none',
              retryable: false,
              detailCode: 'kimi_search_options_open_timeout',
            }
          )
        },
      }
    )
    const resolvedSearchPopover = await resolveUniqueVisibleLocator(
      this.page,
      KIMI_UI_SELECTORS.toolkit.searchPopover
    )
    if (resolvedSearchPopover === null) return null
    const options = resolvedSearchPopover.locator(
      joinCssLocatorCandidates(KIMI_UI_SELECTORS.toolkit.searchOption)
    )
    if ((await options.count().catch(() => 0)) !== 2) return null
    for (let index = 0; index < 2; index += 1) {
      const option = options.nth(index)
      if (
        !(await option.isVisible().catch(() => false)) ||
        !(await option.isEnabled().catch(() => false))
      ) {
        return null
      }
    }
    return options
  }

  private async readSearchSnapshot(
    options: Locator
  ): Promise<KimiSearchToggleSnapshot | null> {
    const selectedOptionIndexes: number[] = []
    for (let index = 0; index < 2; index += 1) {
      const icons = options
        .nth(index)
        .locator(
          joinCssLocatorCandidates(KIMI_UI_SELECTORS.toolkit.selectedOptionIcon)
        )
      const iconCount = await icons.count().catch(() => 0)
      if (iconCount > 1) return null
      if (
        iconCount === 1 &&
        (await icons
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        selectedOptionIndexes.push(index)
      }
    }
    if (selectedOptionIndexes.length !== 1) return null

    const storedState = await this.page
      .evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        KIMI_SEARCH_STORAGE_KEY
      )
      .catch(() => null)
    if (storedState !== 'true' && storedState !== 'false') return null
    return {
      state: storedState === 'true' ? 'on' : 'off',
      selectedOptionIndex: selectedOptionIndexes[0]!,
    }
  }

  private createSearchStateMissingError(
    action: 'searchStatus' | 'searchSet'
  ): ProviderAdapterError {
    return new ProviderAdapterError(
      action,
      'Kimi search did not expose one verifiable selected state.',
      {
        kind: 'ui',
        recovery: 'none',
        retryable: false,
        detailCode: 'kimi_search_state_missing',
      }
    )
  }
}
