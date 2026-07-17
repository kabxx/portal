import { createRequire } from 'node:module'
import type { Page } from 'playwright'

import {
  ProviderAdapter,
  type AbortOptions,
  type CapturedFetchEntry,
  buildSubmitBlockedWarningMessage,
  delayAsync,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  type ProviderPage,
} from './adapter-base.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { waitAsync } from '../../shared/wait.ts'
import {
  type ConversationHistoryMessage,
  type ConversationHistoryResult,
  emptyHistoryResult,
} from '../conversation-history.ts'
import {
  ClaudeCompletionStream,
  ClaudeSseProtocolError,
} from '../claude-sse.ts'

const CLAUDE_CHAT_URL = 'https://claude.ai/new'
const CLAUDE_ORIGIN = 'https://claude.ai'
const CLAUDE_INPUT_SELECTOR = '[data-testid="chat-input"]'
const CLAUDE_FILE_INPUT_SELECTOR = 'input[data-testid="file-upload"]'
const CLAUDE_MODEL_TRIGGER_SELECTOR =
  'button[data-testid="model-selector-dropdown"]'
const CLAUDE_TOOLS_TRIGGER_SELECTOR =
  'button[aria-label="Add files, connectors, and more"]'
const CLAUDE_EFFORT_TRIGGER_SELECTOR = '[data-testid="effort-menu-trigger"]'
const CLAUDE_SELECTABLE_RADIO_SELECTOR =
  '[role="menuitemradio"][data-trigger-disabled]:visible'
const CLAUDE_EFFORT_RADIO_SELECTOR =
  '[role="menuitemradio"][data-testid^="effort-option-"]:visible'
const CLAUDE_ANY_RADIO_SELECTOR = `${CLAUDE_SELECTABLE_RADIO_SELECTOR}, ${CLAUDE_EFFORT_RADIO_SELECTOR}`
const CLAUDE_VOICE_MODE_BUTTON_SELECTOR = 'button:has(svg[viewBox^="0 0 21.2"])'
const CLAUDE_AUTH_PATH_PATTERN = /^\/(?:login|signup|logout)(?:\/|$)/
const CLAUDE_RESTRICTED_PATH_PATTERN = /^\/restricted(?:\/|$)/
const CLAUDE_HISTORY_POLL_MS = 100
const CLAUDE_HISTORY_TERMINAL_QUIET_MS = 1_000
const CLAUDE_SUBMIT_POLL_MS = 50
const CLAUDE_MENU_CLOSE_ATTEMPTS = 4
const CLAUDE_WEB_SEARCH_ACCESSIBLE_NAME = 'Web search'
const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'refusal',
])

interface ClaudeCompletionCapture {
  entryId: number
  chunkIndex: number
  stream: ClaudeCompletionStream
  finished: boolean
}

type ClaudePageState = 'login' | 'ready' | 'pending'

export type ClaudeToggleState = 'on' | 'off'

export interface ClaudeHistoryArticleSnapshot {
  role: 'user' | 'assistant' | 'unknown'
  text: string
  html: string | null
}

export interface ClaudeHistoryCellSnapshot {
  index: number
  articles: ClaudeHistoryArticleSnapshot[]
}

interface ClaudeHistoryViewportSnapshot {
  cells: ClaudeHistoryCellSnapshot[]
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
}

export interface ClaudeLocator {
  count(): Promise<number>
  first(): ClaudeLocator
  last(): ClaudeLocator
  nth(index: number): ClaudeLocator
  filter(options: object): ClaudeLocator
  locator(selector: string): ClaudeLocator
  isVisible(): Promise<boolean>
  isEnabled(): Promise<boolean>
  click(): Promise<void>
  fill(text: string): Promise<void>
  focus(): Promise<void>
  press(key: string): Promise<void>
  getAttribute(name: string): Promise<string | null>
  innerText(): Promise<string>
  setInputFiles(paths: string[]): Promise<void>
}

export interface ClaudePage extends ProviderPage {
  keyboard: {
    press(key: string): Promise<void>
  }
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number }
  ): Promise<unknown>
  url(): string
  locator(selector: string): ClaudeLocator
  getByRole(
    role: string,
    options: { name: string; exact: boolean }
  ): ClaudeLocator
  evaluate(pageFunction: unknown, argument?: unknown): Promise<unknown>
}

interface TurndownServiceInstance {
  addRule(
    key: string,
    rule: {
      filter: (node: HTMLElement) => boolean
      replacement: () => string
    }
  ): TurndownServiceInstance
  turndown(html: string): string
}

type TurndownServiceConstructor = new (options?: {
  codeBlockStyle?: 'indented' | 'fenced'
  headingStyle?: 'setext' | 'atx'
}) => TurndownServiceInstance

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTurndownServiceConstructor(
  value: unknown
): value is TurndownServiceConstructor {
  if (typeof value !== 'function') {
    return false
  }
  const prototype: unknown = Reflect.get(value, 'prototype')
  return (
    isRecord(prototype) &&
    typeof prototype.addRule === 'function' &&
    typeof prototype.turndown === 'function'
  )
}

const require = createRequire(import.meta.url)
const turndownModule: unknown = require('turndown')
if (!isTurndownServiceConstructor(turndownModule)) {
  throw new TypeError('The turndown module did not export a valid constructor.')
}
const TurndownService = turndownModule

export class ClaudeAdapterBase<
  TPage extends ClaudePage = Page,
> extends ProviderAdapter<TPage> {
  private conversationIdVal: string | null = null

  protected override async init(options: AbortOptions = {}): Promise<void> {
    await super.init(options)
    this.conversationIdVal = readClaudeConversationId(
      this.options.conversationUrl
    )
    await this.restore(options)
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const expectedConversationId = this.conversationIdVal
    try {
      throwIfAborted(signal)
      await this.page.goto(this.conversationUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.getRestoreTimeoutMs(),
      })
      await waitAsync(
        async () => {
          const state = await this.getClaudePageState()
          if (state === 'login') throw this.createAuthError('restore')
          return state === 'ready'
        },
        {
          timeoutMs: this.getRestoreTimeoutMs(),
          signal,
          onTimeout: async () => {
            throw new ProviderAdapterError(
              'restore',
              'Claude did not become ready after loading.',
              {
                kind: 'ui',
                recovery: 'reload',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'claude_page_not_ready',
              }
            )
          },
        }
      )
      const restoredId = readClaudeConversationId(this.page.url())
      if (
        expectedConversationId !== null &&
        restoredId !== expectedConversationId
      ) {
        throw new ProviderAdapterError(
          'restore',
          'Claude did not restore the requested conversation.',
          {
            kind: 'ui',
            recovery: 'reload',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'claude_conversation_mismatch',
          }
        )
      }
      if (restoredId !== null) this.conversationIdVal = restoredId
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderAdapterError) {
        throw error
      }
      throw new ProviderAdapterError(
        'restore',
        'Claude could not restore the conversation.',
        {
          kind: 'transient',
          recovery: 'reload',
          retryable: true,
          maxAttempts: 2,
          detailCode: 'claude_restore_failed',
          cause: error,
        }
      )
    }
  }

  public async isLoggedIn(): Promise<boolean> {
    return (await this.getClaudePageState()) === 'ready'
  }

  public async hasToggleCapability(capability: string): Promise<boolean> {
    if (capability !== 'web_search') return false
    return await this.wrapAdapterActionErrorAsync(
      'webSearchAvailable',
      async () => {
        try {
          if (!(await this.openComposerToolsMenu())) return false
          return (await this.readWebSearchSnapshot()) !== null
        } finally {
          await this.closeComposerToolsMenu()
        }
      }
    )
  }

  public async getToggleState(capability: string): Promise<ClaudeToggleState> {
    if (capability !== 'web_search') {
      throw new ProviderAdapterUnsupportedError(
        'webSearchStatus',
        `Claude does not support capability "${capability}".`
      )
    }
    return await this.wrapAdapterActionErrorAsync(
      'webSearchStatus',
      async () => {
        try {
          if (!(await this.openComposerToolsMenu())) {
            throw this.createWebSearchUnavailableError('webSearchStatus')
          }
          const snapshot = await this.readWebSearchSnapshot()
          if (snapshot === null) {
            throw this.createWebSearchUnavailableError('webSearchStatus')
          }
          return snapshot.state
        } finally {
          await this.closeComposerToolsMenu()
        }
      }
    )
  }

  public async setToggleState(
    capability: string,
    targetState: ClaudeToggleState
  ): Promise<ClaudeToggleState> {
    if (capability !== 'web_search') {
      throw new ProviderAdapterUnsupportedError(
        'webSearchSet',
        `Claude does not support capability "${capability}".`
      )
    }
    return await this.wrapAdapterActionErrorAsync('webSearchSet', async () => {
      try {
        if (!(await this.openComposerToolsMenu())) {
          throw this.createWebSearchUnavailableError('webSearchSet')
        }
        const snapshot = await this.readWebSearchSnapshot()
        if (snapshot === null) {
          throw this.createWebSearchUnavailableError('webSearchSet')
        }
        if (snapshot.state !== targetState) {
          await snapshot.item.click()
          await this.closeComposerToolsMenu()
          if (!(await this.openComposerToolsMenu())) {
            throw this.createWebSearchUnavailableError('webSearchSet')
          }
          const verification = await this.readWebSearchSnapshot()
          if (verification?.state !== targetState) {
            throw new ProviderAdapterError(
              'webSearchSet',
              `Claude web_search could not be switched ${targetState}.`,
              {
                kind: 'ui',
                detailCode: 'claude_web_search_state_mismatch',
              }
            )
          }
        }
        return targetState
      } finally {
        await this.closeComposerToolsMenu()
      }
    })
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return this.conversationIdVal === null
      ? CLAUDE_CHAT_URL
      : `${CLAUDE_ORIGIN}/chat/${encodeURIComponent(this.conversationIdVal)}`
  }

  public async changeModel(model: string): Promise<void> {
    const parsed = model.trim().match(/^([1-9]\d*)(?:\+([1-9]\d*))?$/)
    if (parsed === null) {
      throw new ProviderAdapterUnsupportedError(
        'change model',
        `Claude does not support model "${model}".`
      )
    }
    const modelIndex = Number(parsed[1]) - 1
    const effortIndex = parsed[2] === undefined ? null : Number(parsed[2]) - 1

    try {
      const trigger = this.page.locator(CLAUDE_MODEL_TRIGGER_SELECTOR).first()
      if (!(await trigger.isVisible().catch(() => false))) {
        throw new ProviderAdapterUnsupportedError(
          'change model',
          'Claude model selection is not available in the current conversation.'
        )
      }
      await trigger.click()
      const modelItems = await this.openModelRadios()
      if (modelIndex >= modelItems.length) {
        throw new ProviderAdapterUnsupportedError(
          'change model',
          `Claude does not have model ${modelIndex + 1}.`
        )
      }
      const modelItem = modelItems[modelIndex]!
      const expectedModel = normalizeMenuItemText(await modelItem.innerText())
      if ((await modelItem.getAttribute('aria-checked')) !== 'true') {
        await modelItem.click()
        await this.ensureConversationPageAfterModelSelection()
        await this.closeModelMenus()
        await this.waitForModelTriggerReady(trigger)
        await trigger.click()
        const verificationModelItems = await this.openModelRadios()
        await this.verifyRadioSelection(
          verificationModelItems,
          expectedModel,
          'model',
          modelIndex + 1
        )
      }
      await this.closeModelMenus()

      if (effortIndex !== null) {
        await trigger.click()
        const effortTrigger = this.page
          .locator(CLAUDE_EFFORT_TRIGGER_SELECTOR)
          .first()
        await this.waitForEffortTrigger(effortTrigger)
        await effortTrigger.click()
        const effortItems = await this.openEffortRadios()
        if (effortIndex >= effortItems.length) {
          throw new ProviderAdapterUnsupportedError(
            'change model',
            `Claude does not have effort ${effortIndex + 1}.`
          )
        }
        const effortItem = effortItems[effortIndex]!
        const expectedEffort = normalizeMenuItemText(
          await effortItem.innerText()
        )
        if ((await effortItem.getAttribute('aria-checked')) !== 'true') {
          await effortItem.click()
          await this.ensureConversationPageAfterModelSelection()
          await this.closeModelMenus()
          await this.waitForModelTriggerReady(trigger)
          await trigger.click()
          const verificationEffortTrigger = this.page
            .locator(CLAUDE_EFFORT_TRIGGER_SELECTOR)
            .first()
          await this.waitForEffortTrigger(verificationEffortTrigger)
          await verificationEffortTrigger.click()
          const verificationEffortItems = await this.openEffortRadios()
          await this.verifyRadioSelection(
            verificationEffortItems,
            expectedEffort,
            'effort',
            effortIndex + 1
          )
        }
      }
    } finally {
      await this.closeModelMenus()
    }
  }

  public async attachText(text: string): Promise<void> {
    await this.assertComposerActionReady('attach text')
    const input = this.getInput()
    try {
      await input.click()
      await input.fill(text)
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderAdapterError) {
        throw error
      }
      if (this.isRestrictedPage()) {
        throw this.createRestrictedError('attach text')
      }
      if (await this.isLoginPageVisible()) {
        throw this.createAuthError('attach text')
      }
      throw new ProviderAdapterError(
        'attach text',
        'Claude could not update the composer.',
        {
          kind: 'transient',
          recovery: 'restore',
          retryable: true,
          maxAttempts: 2,
          detailCode: 'claude_attach_text_failed',
          cause: error,
        }
      )
    }
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    const input = this.page.locator(CLAUDE_FILE_INPUT_SELECTOR)
    if ((await input.count()) === 0) {
      throw new ProviderAdapterUnsupportedError(
        'attach file',
        'Claude file upload is not available in the current conversation.'
      )
    }
    await input.first().setInputFiles(normalizeToPathArray(path))
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public async stopGeneration(): Promise<void> {
    const root = this.getComposerRoot()
    if ((await root.count().catch(() => 0)) === 0) return
    const candidates = root.locator(
      'button[data-cds="Button"][aria-label="Stop response"]'
    )
    const visible: ClaudeLocator[] = []
    for (let index = 0; index < (await candidates.count()); index += 1) {
      const candidate = candidates.nth(index)
      if (await candidate.isVisible().catch(() => false)) {
        visible.push(candidate)
      }
    }
    if (visible.length === 0) return
    if (visible.length !== 1) {
      throw new ProviderAdapterError(
        'stop generation',
        'Claude exposed multiple stop controls in the composer.',
        {
          kind: 'ui',
          detailCode: 'claude_stop_control_ambiguous',
        }
      )
    }
    await visible[0]!.click()
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    const { signal } = options
    const captureStart = await this.getCapturedFetchEntryCount()
    const captures = new Map<number, ClaudeCompletionCapture>()
    const startedAt = Date.now()
    let nextWarningAt = startedAt + this.getSubmitRequestStartGraceMs()
    let submitSent = false
    let lastText = ''
    let nonTerminalEntryId: number | null = null
    let nonTerminalObservedAt = 0

    try {
      throwIfAborted(signal)
      await this.assertComposerActionReady('submit')
      await this.getInput().press('Enter')
      while (true) {
        throwIfAborted(signal)
        const entries = (await this.getCapturedFetchEntries(captureStart))
          .filter((entry) => this.isTargetCompletionEntry(entry))
          .sort((left, right) => left.id - right.id)

        if (entries.length === 0) {
          if (!submitSent) {
            if (this.isRestrictedPage()) {
              throw this.createRestrictedError('submit')
            }
            if (await this.isLoginPageVisible()) {
              throw this.createAuthError('submit')
            }
          }
          if (Date.now() >= nextWarningAt) {
            await this.emitSubmitStatusSafely(
              buildSubmitBlockedWarningMessage('Claude')
            )
            nextWarningAt =
              Date.now() + this.getSubmitBlockedWarningIntervalMs()
          }
          await delayAsync(CLAUDE_SUBMIT_POLL_MS, signal)
          continue
        }

        for (const entry of entries) {
          const capture = this.getOrCreateCompletionCapture(entry, captures)
          if (!submitSent) {
            submitSent = true
            this.emitSubmitSent()
          }
          this.validateCompletionEntry(entry)
          while (capture.chunkIndex < entry.chunks.length) {
            const chunk = entry.chunks[capture.chunkIndex++]!
            try {
              capture.stream.push(chunk)
            } catch (error) {
              if (error instanceof ClaudeSseProtocolError) {
                throw this.createProtocolError(error.message)
              }
              throw error
            }
            this.emitSubmitActivity()
          }
          const snapshot = capture.stream.snapshot
          if (snapshot.errorMessage !== null) {
            throw new ProviderAdapterError('submit', snapshot.errorMessage, {
              kind: 'protocol',
              detailCode: 'claude_stream_error',
            })
          }
          if (entry.done && !capture.finished) {
            capture.finished = true
            try {
              capture.stream.finish()
            } catch (error) {
              if (error instanceof ClaudeSseProtocolError) {
                throw this.createProtocolError(error.message)
              }
              throw error
            }
            if (!capture.stream.snapshot.messageStopped) {
              throw this.createProtocolError(
                'Claude response ended without message_stop.'
              )
            }
          }
        }

        const orderedCaptures = [...captures.values()].sort(
          (left, right) => left.entryId - right.entryId
        )
        const currentText = orderedCaptures
          .map((capture) => capture.stream.snapshot.text)
          .join('')
        if (currentText && currentText !== lastText) {
          lastText = currentText
          await this.emitSubmitText(currentText)
        }

        const latestCapture = orderedCaptures.at(-1)
        const latestSnapshot = latestCapture?.stream.snapshot
        if (latestCapture?.finished && latestSnapshot?.messageStopped) {
          const composerReady = await this.isComposerReady()
          if (
            latestSnapshot.stopReason !== null &&
            TERMINAL_STOP_REASONS.has(latestSnapshot.stopReason) &&
            composerReady
          ) {
            const restoredId = readClaudeConversationId(this.page.url())
            if (restoredId !== null) this.conversationIdVal = restoredId
            if (!currentText.trim()) {
              throw this.createProtocolError(
                'Claude completed without a text response.'
              )
            }
            return currentText
          }
          if (
            latestSnapshot.stopReason !== null &&
            !TERMINAL_STOP_REASONS.has(latestSnapshot.stopReason) &&
            composerReady
          ) {
            if (nonTerminalEntryId !== latestCapture.entryId) {
              nonTerminalEntryId = latestCapture.entryId
              nonTerminalObservedAt = Date.now()
            } else if (
              Date.now() - nonTerminalObservedAt >=
              this.getSubmitResponseStallTimeoutMs()
            ) {
              throw this.createProtocolError(
                `Claude stopped with non-terminal reason ${latestSnapshot.stopReason}.`
              )
            }
          } else {
            nonTerminalEntryId = null
          }
        }

        await delayAsync(CLAUDE_SUBMIT_POLL_MS, signal)
      }
    } catch (error) {
      if (isAbortError(error) || error instanceof ProviderAdapterError) {
        throw error
      }
      throw new ProviderAdapterError('submit', 'Claude request failed.', {
        kind: 'transient',
        recovery: 'restore',
        retryable: true,
        maxAttempts: 2,
        detailCode: 'claude_submit_failed',
        cause: error,
      })
    }
  }

  public override async loadHistory(
    options: AbortOptions = {}
  ): Promise<ConversationHistoryResult> {
    const { signal } = options
    try {
      const deadline = Date.now() + this.getHistoryLoadTimeoutMs()
      let bottom = await this.readHistoryViewport('bottom')
      while (
        (!bottom.atBottom || bottom.cells.length === 0) &&
        Date.now() < deadline
      ) {
        await delayAsync(CLAUDE_HISTORY_POLL_MS, signal)
        bottom = await this.readHistoryViewport('bottom')
      }
      if (!bottom.atBottom || bottom.cells.length === 0) {
        return emptyHistoryResult(
          'Claude history completeness could not be verified at the conversation bottom.'
        )
      }
      let terminalIndex = Math.max(...bottom.cells.map((cell) => cell.index))
      let terminalQuietSince: number | null = Date.now()
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        await delayAsync(Math.min(CLAUDE_HISTORY_POLL_MS, remainingMs), signal)
        const snapshot = await this.readHistoryViewport('bottom')
        const observedAt = Date.now()
        if (!snapshot.atBottom || snapshot.cells.length === 0) {
          terminalQuietSince = null
          continue
        }
        bottom = snapshot
        const snapshotTerminalIndex = Math.max(
          ...snapshot.cells.map((cell) => cell.index)
        )
        if (snapshotTerminalIndex > terminalIndex) {
          terminalIndex = snapshotTerminalIndex
          terminalQuietSince = observedAt
          continue
        }
        if (snapshotTerminalIndex < terminalIndex) {
          terminalQuietSince = null
          continue
        }
        terminalQuietSince ??= observedAt
        if (
          observedAt - terminalQuietSince >=
          CLAUDE_HISTORY_TERMINAL_QUIET_MS
        ) {
          break
        }
      }

      const cells = new Map<number, ClaudeHistoryCellSnapshot>()
      let conflict = false
      let stalledAtTopSince: number | null = null
      let snapshot = await this.readHistoryViewport('current')
      while (Date.now() < deadline) {
        for (const cell of snapshot.cells) {
          const previous = cells.get(cell.index)
          if (
            previous !== undefined &&
            JSON.stringify(previous.articles) !== JSON.stringify(cell.articles)
          ) {
            conflict = true
          } else {
            cells.set(cell.index, cell)
          }
        }
        if (conflict || cells.has(0)) break
        const previousMinimum = Math.min(...cells.keys())
        const scrolled = await this.readHistoryViewport('previous')
        await delayAsync(CLAUDE_HISTORY_POLL_MS, signal)
        snapshot = await this.readHistoryViewport('current')
        const nextMinimum = Math.min(
          previousMinimum,
          ...snapshot.cells.map((cell) => cell.index)
        )
        if (nextMinimum < previousMinimum) {
          stalledAtTopSince = null
        } else if (scrolled.scrollTop <= 0 && snapshot.scrollTop <= 0) {
          stalledAtTopSince ??= Date.now()
          if (
            Date.now() - stalledAtTopSince >=
            this.getHistoryPageTimeoutMs()
          ) {
            break
          }
        } else {
          stalledAtTopSince = null
        }
      }

      return buildClaudeHistoryResult(
        [...cells.values()],
        terminalIndex,
        this.conversationIdVal,
        conflict
      )
    } finally {
      await this.finishHistoryCapture()
    }
  }

  private getInput(): ClaudeLocator {
    return this.page.locator(CLAUDE_INPUT_SELECTOR).first()
  }

  private getComposerRoot(): ClaudeLocator {
    return this.getInput().locator(
      'xpath=ancestor::div[.//input[@data-testid="file-upload"] and .//*[@data-testid="model-selector-dropdown"]][1]'
    )
  }

  private async isComposerReady(): Promise<boolean> {
    const input = this.getInput()
    return (
      (await input.isVisible().catch(() => false)) &&
      (await input.getAttribute('contenteditable').catch(() => null)) === 'true'
    )
  }

  private async getClaudePageState(): Promise<ClaudePageState> {
    if (this.isRestrictedPage()) throw this.createRestrictedError('restore')
    if (await this.isLoginPageVisible()) return 'login'
    if (await this.isVoiceModeReady()) return 'ready'
    return 'pending'
  }

  private async isVoiceModeReady(): Promise<boolean> {
    const buttons = this.getComposerRoot().locator(
      CLAUDE_VOICE_MODE_BUTTON_SELECTOR
    )
    if ((await buttons.count().catch(() => 0)) !== 1) return false
    const button = buttons.first()
    return (
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled().catch(() => false)) &&
      (await button.getAttribute('aria-disabled').catch(() => null)) !== 'true'
    )
  }

  private async isLoginPageVisible(): Promise<boolean> {
    if (CLAUDE_AUTH_PATH_PATTERN.test(new URL(this.page.url()).pathname)) {
      return true
    }
    return await this.page
      .locator('[data-testid="email"], [data-testid="continue"]')
      .first()
      .isVisible()
      .catch(() => false)
  }

  private isRestrictedPage(): boolean {
    return CLAUDE_RESTRICTED_PATH_PATTERN.test(
      new URL(this.page.url()).pathname
    )
  }

  private async assertComposerActionReady(action: string): Promise<void> {
    if (this.isRestrictedPage()) throw this.createRestrictedError(action)
    if (await this.isLoginPageVisible()) throw this.createAuthError(action)
    if (await this.isComposerReady()) return
    if (this.isRestrictedPage()) throw this.createRestrictedError(action)
    if (await this.isLoginPageVisible()) throw this.createAuthError(action)
    throw new ProviderAdapterError(
      action,
      'Claude composer is not available.',
      {
        kind: 'ui',
        detailCode: 'claude_composer_missing',
      }
    )
  }

  private createAuthError(action: string): ProviderAdapterError {
    return new ProviderAdapterError(action, 'Claude is not logged in.', {
      adapter: this,
      kind: 'auth',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
      detailCode: 'claude_signed_out',
    })
  }

  private createRestrictedError(action: string): ProviderAdapterError {
    return new ProviderAdapterError(
      action,
      'Claude account access is restricted.',
      {
        adapter: this,
        kind: 'auth',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'claude_account_restricted',
      }
    )
  }

  private getWebSearchItems(): ClaudeLocator {
    return this.page.getByRole('menuitemcheckbox', {
      name: CLAUDE_WEB_SEARCH_ACCESSIBLE_NAME,
      exact: true,
    })
  }

  private async openComposerToolsMenu(): Promise<boolean> {
    const triggers = this.getComposerRoot().locator(
      CLAUDE_TOOLS_TRIGGER_SELECTOR
    )
    if ((await triggers.count()) !== 1) return false
    const trigger = triggers.first()
    if (
      !(await trigger.isVisible().catch(() => false)) ||
      !(await trigger.isEnabled().catch(() => false))
    ) {
      return false
    }
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click()
    }
    try {
      await waitAsync(
        async () =>
          (await trigger.getAttribute('aria-expanded')) === 'true' &&
          (await this.page.locator('[role="menu"]:visible').count()) > 0,
        { timeoutMs: 2000 }
      )
      return true
    } catch {
      return false
    }
  }

  private async readWebSearchSnapshot(): Promise<{
    item: ClaudeLocator
    state: ClaudeToggleState
  } | null> {
    const items = this.getWebSearchItems()
    if ((await items.count()) !== 1) return null
    const item = items.first()
    if (
      !(await item.isVisible().catch(() => false)) ||
      !(await item.isEnabled().catch(() => false)) ||
      (await item.getAttribute('aria-disabled')) === 'true'
    ) {
      return null
    }
    const checked = await item.getAttribute('aria-checked')
    if (checked !== 'true' && checked !== 'false') {
      throw new ProviderAdapterError(
        'webSearchStatus',
        'Claude web_search exposed an invalid checkbox state.',
        {
          kind: 'ui',
          detailCode: 'claude_web_search_state_invalid',
        }
      )
    }
    return { item, state: checked === 'true' ? 'on' : 'off' }
  }

  private async closeComposerToolsMenu(): Promise<void> {
    for (let attempt = 0; attempt < CLAUDE_MENU_CLOSE_ATTEMPTS; attempt += 1) {
      if (await this.isComposerToolsMenuClosed()) return
      await this.page.keyboard.press('Escape').catch(() => {})
    }
    await waitAsync(async () => await this.isComposerToolsMenuClosed(), {
      timeoutMs: 2000,
      onTimeout: async () => {
        throw new ProviderAdapterError(
          'webSearchCapability',
          'Claude Composer tools menu did not close cleanly.',
          {
            kind: 'ui',
            detailCode: 'claude_tools_menu_stuck',
          }
        )
      },
    })
  }

  private async isComposerToolsMenuClosed(): Promise<boolean> {
    const [expandedCount, visibleItemCount] = await Promise.all([
      this.getComposerRoot()
        .locator(`${CLAUDE_TOOLS_TRIGGER_SELECTOR}[aria-expanded="true"]`)
        .count()
        .catch(() => 0),
      this.getWebSearchItems()
        .count()
        .catch(() => 0),
    ])
    return expandedCount === 0 && visibleItemCount === 0
  }

  private createWebSearchUnavailableError(
    action: string
  ): ProviderAdapterUnsupportedError {
    return new ProviderAdapterUnsupportedError(
      action,
      'Claude web_search capability is not available on this page.'
    )
  }

  private async openModelRadios(): Promise<ClaudeLocator[]> {
    const mainMenu = this.page
      .locator('[role="menu"]:visible')
      .filter({
        has: this.page.locator(CLAUDE_SELECTABLE_RADIO_SELECTOR),
      })
      .first()
    await waitAsync(
      async () =>
        (await mainMenu.locator(CLAUDE_SELECTABLE_RADIO_SELECTOR).count()) > 0,
      {
        timeoutMs: 2000,
        onTimeout: async () => {
          throw new ProviderAdapterUnsupportedError(
            'change model',
            'Claude has no selectable models for this account.'
          )
        },
      }
    )
    const items = await this.collectLocators(
      mainMenu.locator(CLAUDE_SELECTABLE_RADIO_SELECTOR)
    )
    const nestedTrigger = mainMenu
      .locator(
        '[role="menuitem"][aria-haspopup="menu"]:not([data-testid="effort-menu-trigger"])'
      )
      .first()
    if (await nestedTrigger.isVisible().catch(() => false)) {
      await nestedTrigger.focus()
      await this.page.keyboard.press('ArrowRight')
      await waitAsync(
        async () =>
          (await this.page.locator('[role="menu"]:visible').count()) >= 2,
        { timeoutMs: 2000 }
      )
      const submenu = this.getOpenRadioSubmenu()
      items.push(
        ...(await this.collectLocators(
          submenu.locator(CLAUDE_SELECTABLE_RADIO_SELECTOR)
        ))
      )
    }
    return items
  }

  private getOpenRadioSubmenu(): ClaudeLocator {
    return this.page
      .locator('[role="menu"]:visible')
      .filter({
        has: this.page.locator(CLAUDE_SELECTABLE_RADIO_SELECTOR),
        hasNot: this.page.locator(CLAUDE_EFFORT_TRIGGER_SELECTOR),
      })
      .last()
  }

  private getOpenEffortMenu(): ClaudeLocator {
    return this.page
      .locator('[role="menu"]:visible')
      .filter({
        has: this.page.locator(CLAUDE_EFFORT_RADIO_SELECTOR),
      })
      .last()
  }

  private async openEffortRadios(): Promise<ClaudeLocator[]> {
    const effortMenu = this.getOpenEffortMenu()
    await waitAsync(
      async () =>
        (await effortMenu.locator(CLAUDE_EFFORT_RADIO_SELECTOR).count()) > 0,
      {
        timeoutMs: 2000,
        onTimeout: async () => {
          throw new ProviderAdapterUnsupportedError(
            'change model',
            'Claude effort selection is not available for this model.'
          )
        },
      }
    )
    return await this.collectLocators(
      effortMenu.locator(CLAUDE_EFFORT_RADIO_SELECTOR)
    )
  }

  private async verifyRadioSelection(
    items: readonly ClaudeLocator[],
    expectedText: string,
    kind: 'model' | 'effort',
    index: number
  ): Promise<void> {
    await waitAsync(
      async () => {
        for (const item of items) {
          if (
            (await item.getAttribute('aria-checked')) === 'true' &&
            normalizeMenuItemText(await item.innerText()) === expectedText
          ) {
            return true
          }
        }
        return false
      },
      {
        timeoutMs: 2000,
        onTimeout: async () => {
          throw new ProviderAdapterUnsupportedError(
            'change model',
            `Claude ${kind} ${index} could not be selected.`
          )
        },
      }
    )
  }

  private async collectLocators(
    locator: ClaudeLocator
  ): Promise<ClaudeLocator[]> {
    const items: ClaudeLocator[] = []
    for (let index = 0; index < (await locator.count()); index += 1) {
      items.push(locator.nth(index))
    }
    return items
  }

  private async ensureConversationPageAfterModelSelection(): Promise<void> {
    await delayAsync(200)
    if (isClaudeConversationUrl(this.page.url())) return
    await this.page
      .goto(this.conversationUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.getRestoreTimeoutMs(),
      })
      .catch(() => {})
    throw new ProviderAdapterUnsupportedError(
      'change model',
      'The selected Claude model is not available for this account.'
    )
  }

  private async waitForModelTriggerReady(
    trigger: ClaudeLocator
  ): Promise<void> {
    await waitAsync(
      async () =>
        (await trigger.isVisible().catch(() => false)) &&
        (await trigger.isEnabled().catch(() => false)),
      {
        timeoutMs: this.getRestoreTimeoutMs(),
        onTimeout: async () => {
          throw new ProviderAdapterError(
            'change model',
            'Claude model selector did not become ready after selection.',
            {
              kind: 'ui',
              detailCode: 'claude_model_selector_missing',
            }
          )
        },
      }
    )
  }

  private async waitForEffortTrigger(trigger: ClaudeLocator): Promise<void> {
    await waitAsync(async () => await trigger.isVisible().catch(() => false), {
      timeoutMs: 2000,
      onTimeout: async () => {
        throw new ProviderAdapterUnsupportedError(
          'change model',
          'Claude effort selection is not available for this model.'
        )
      },
    })
  }

  private async closeModelMenus(): Promise<void> {
    for (let attempt = 0; attempt < CLAUDE_MENU_CLOSE_ATTEMPTS; attempt += 1) {
      if (await this.areModelMenusClosed()) return
      await this.page.keyboard.press('Escape').catch(() => {})
    }
    await waitAsync(async () => await this.areModelMenusClosed(), {
      timeoutMs: 2000,
      onTimeout: async () => {
        throw new ProviderAdapterError(
          'change model',
          'Claude model menu did not close cleanly.',
          {
            kind: 'ui',
            detailCode: 'claude_model_menu_stuck',
          }
        )
      },
    })
  }

  private async areModelMenusClosed(): Promise<boolean> {
    const [inertCount, expandedCount, radioMenuCount] = await Promise.all([
      this.page
        .locator('[data-base-ui-inert]')
        .count()
        .catch(() => 0),
      this.page
        .locator(`${CLAUDE_MODEL_TRIGGER_SELECTOR}[aria-expanded="true"]`)
        .count()
        .catch(() => 0),
      this.page
        .locator('[role="menu"]:visible')
        .filter({ has: this.page.locator(CLAUDE_ANY_RADIO_SELECTOR) })
        .count()
        .catch(() => 0),
    ])
    return inertCount === 0 && expandedCount === 0 && radioMenuCount === 0
  }

  private isTargetCompletionEntry(entry: CapturedFetchEntry): boolean {
    if (entry.method !== 'POST') return false
    let url: URL
    try {
      url = new URL(entry.url, CLAUDE_ORIGIN)
    } catch {
      return false
    }
    if (url.origin !== CLAUDE_ORIGIN) return false
    const match = url.pathname.match(
      /^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion$/
    )
    if (match?.[1] === undefined) return false
    const entryConversationId = decodeURIComponent(match[1])
    return (
      this.conversationIdVal === null ||
      entryConversationId === this.conversationIdVal
    )
  }

  private getOrCreateCompletionCapture(
    entry: CapturedFetchEntry,
    captures: Map<number, ClaudeCompletionCapture>
  ): ClaudeCompletionCapture {
    const existing = captures.get(entry.id)
    if (existing !== undefined) return existing
    const url = new URL(entry.url, CLAUDE_ORIGIN)
    const match = url.pathname.match(
      /^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion$/
    )
    const entryConversationId = match?.[1] ? decodeURIComponent(match[1]) : null
    if (this.conversationIdVal === null && entryConversationId !== null) {
      this.conversationIdVal = entryConversationId
    }
    const capture = {
      entryId: entry.id,
      chunkIndex: 0,
      stream: new ClaudeCompletionStream(),
      finished: false,
    }
    captures.set(entry.id, capture)
    return capture
  }

  private validateCompletionEntry(entry: CapturedFetchEntry): void {
    if (entry.error !== null) {
      throw this.createProtocolError('Claude completion stream failed.')
    }
    if (entry.status !== null && (entry.status < 200 || entry.status >= 300)) {
      throw new ProviderAdapterError(
        'submit',
        `Claude completion failed with HTTP ${entry.status}.`,
        {
          kind: entry.status === 429 ? 'rate_limit' : 'protocol',
          detailCode: 'claude_completion_http_error',
        }
      )
    }
  }

  private createProtocolError(message: string): ProviderAdapterError {
    return new ProviderAdapterError('submit', message, {
      kind: 'protocol',
      detailCode: 'claude_completion_protocol_error',
    })
  }

  private async readHistoryViewport(
    action: 'bottom' | 'previous' | 'current'
  ): Promise<ClaudeHistoryViewportSnapshot> {
    const snapshot = await this.page.evaluate((requestedAction: unknown) => {
      if (
        requestedAction !== 'bottom' &&
        requestedAction !== 'previous' &&
        requestedAction !== 'current'
      ) {
        throw new Error('Unsupported Claude history viewport action.')
      }
      const feed = document.querySelector('[role="feed"]')
      if (!(feed instanceof HTMLElement)) {
        return {
          cells: [],
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          atBottom: false,
        }
      }
      let scroller: HTMLElement | null = feed
      while (
        scroller.parentElement !== null &&
        scroller.scrollHeight <= scroller.clientHeight
      ) {
        scroller = scroller.parentElement
      }
      if (requestedAction === 'bottom') {
        scroller.scrollTop = scroller.scrollHeight
      } else if (requestedAction === 'previous') {
        scroller.scrollTop = Math.max(
          0,
          scroller.scrollTop - Math.max(1, scroller.clientHeight * 0.8)
        )
      }

      const cells: ClaudeHistoryCellSnapshot[] = []
      for (const element of feed.querySelectorAll('[data-index]')) {
        const index = Number(element.getAttribute('data-index'))
        if (!Number.isInteger(index) || index < 0) continue
        const articles: ClaudeHistoryArticleSnapshot[] = Array.from(
          element.querySelectorAll('[role="article"]')
        ).map((article) => {
          const user = article.querySelector('[data-testid="user-message"]')
          if (user instanceof HTMLElement) {
            return {
              role: 'user' as const,
              text: user.innerText.trim(),
              html: null,
            }
          }
          const assistant = article.querySelector('.font-claude-response')
          if (assistant instanceof HTMLElement) {
            return {
              role: 'assistant' as const,
              text: assistant.innerText.trim(),
              html: assistant.innerHTML,
            }
          }
          return { role: 'unknown' as const, text: '', html: null }
        })
        cells.push({ index, articles })
      }

      return {
        cells,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        atBottom:
          scroller.scrollTop + scroller.clientHeight >=
          scroller.scrollHeight - 2,
      }
    }, action)
    if (!isClaudeHistoryViewportSnapshot(snapshot)) {
      throw new Error('Claude returned an invalid history viewport snapshot.')
    }
    return snapshot
  }
}

export class ClaudeAdapter extends ClaudeAdapterBase<Page> {}

function isClaudeHistoryViewportSnapshot(
  value: unknown
): value is ClaudeHistoryViewportSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.cells) &&
    value.cells.every(isClaudeHistoryCellSnapshot) &&
    typeof value.scrollTop === 'number' &&
    typeof value.scrollHeight === 'number' &&
    typeof value.clientHeight === 'number' &&
    typeof value.atBottom === 'boolean'
  )
}

function isClaudeHistoryCellSnapshot(
  value: unknown
): value is ClaudeHistoryCellSnapshot {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    Array.isArray(value.articles) &&
    value.articles.every(isClaudeHistoryArticleSnapshot)
  )
}

function isClaudeHistoryArticleSnapshot(
  value: unknown
): value is ClaudeHistoryArticleSnapshot {
  return (
    isRecord(value) &&
    (value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'unknown') &&
    typeof value.text === 'string' &&
    (typeof value.html === 'string' || value.html === null)
  )
}

export function buildClaudeHistoryResult(
  cells: readonly ClaudeHistoryCellSnapshot[],
  terminalIndex: number,
  conversationId: string | null,
  conflict = false
): ConversationHistoryResult {
  if (conflict) {
    return emptyHistoryResult(
      'Claude history changed while the virtual conversation was being read.'
    )
  }
  const byIndex = new Map<number, ClaudeHistoryCellSnapshot>()
  for (const cell of cells) {
    const previous = byIndex.get(cell.index)
    if (
      previous !== undefined &&
      JSON.stringify(previous.articles) !== JSON.stringify(cell.articles)
    ) {
      return emptyHistoryResult(
        'Claude history contained conflicting virtual conversation cells.'
      )
    }
    byIndex.set(cell.index, cell)
  }
  if (!Number.isInteger(terminalIndex) || terminalIndex < 0) {
    return emptyHistoryResult('Claude history terminal index is invalid.')
  }
  for (let index = 0; index <= terminalIndex; index += 1) {
    if (!byIndex.has(index)) {
      return emptyHistoryResult(
        `Claude history is incomplete because virtual cell ${index} was not loaded.`
      )
    }
  }

  const articles = [...byIndex.values()]
    .sort((left, right) => left.index - right.index)
    .flatMap((cell) =>
      cell.articles.map((article, articleIndex) => ({
        ...article,
        cellIndex: cell.index,
        articleIndex,
      }))
    )
  if (
    articles.some(
      (article) => article.role === 'unknown' || !article.text.trim()
    )
  ) {
    return emptyHistoryResult(
      'Claude history contained an unrecognized or empty message article.'
    )
  }

  const filtered = filterClaudeSetupHandshake(articles)
  for (let index = 0; index < filtered.length; index += 1) {
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant'
    if (filtered[index]!.role !== expectedRole) {
      return emptyHistoryResult(
        'Claude history message roles did not form a complete conversation branch.'
      )
    }
  }

  const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  })
  turndown.addRule('claude-thinking-duration-control', {
    filter: (node) => {
      if (
        node.nodeName !== 'BUTTON' &&
        node.getAttribute('role') !== 'button'
      ) {
        return false
      }
      const label = (node.textContent ?? '').trim().replace(/\s+/g, ' ')
      return label.startsWith('Thought for ')
    },
    replacement: () => '',
  })
  const messages: ConversationHistoryMessage[] = []
  for (const article of filtered) {
    if (article.role !== 'user' && article.role !== 'assistant') {
      return emptyHistoryResult(
        'Claude history contained an unrecognized message role.'
      )
    }
    const id = `claude-${conversationId ?? 'conversation'}-${article.cellIndex}-${article.articleIndex}`
    const text =
      article.role === 'assistant' && article.html !== null
        ? turndown.turndown(article.html).trim()
        : article.text.trim()
    if (!text) {
      return emptyHistoryResult(
        'Claude history contained a message without readable text.'
      )
    }
    messages.push({
      id,
      parentId: messages.at(-1)?.id ?? null,
      role: article.role,
      text,
      format: article.role === 'assistant' ? 'markdown' : 'plain',
      createdAt: null,
    })
  }

  return {
    messages,
    complete: true,
    warning:
      messages.length === 0
        ? 'Claude history contained no visible messages.'
        : null,
  }
}

function filterClaudeSetupHandshake<T extends ClaudeHistoryArticleSnapshot>(
  articles: readonly T[]
): T[] {
  if (articles.length < 2) return [...articles]
  const user = articles[0]!
  const assistant = articles[1]!
  if (
    user.role === 'user' &&
    user.text.includes('# Setup Handshake') &&
    user.text.includes('Reply with READY when initialization is complete.') &&
    assistant.role === 'assistant' &&
    /\bREADY\b/i.test(assistant.text)
  ) {
    return articles.slice(2)
  }
  return [...articles]
}

function readClaudeConversationId(
  value: string | null | undefined
): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.hostname !== 'claude.ai') return null
    const match = url.pathname.match(/^\/chat\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function isClaudeConversationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'claude.ai' &&
      (url.pathname === '/new' || /^\/chat\/[^/?#]+/.test(url.pathname))
    )
  } catch {
    return false
  }
}

function normalizeToPathArray(path: string | readonly string[]): string[] {
  return typeof path === 'string' ? [path] : [...path]
}

function normalizeMenuItemText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
