import {
  ProviderAdapter,
  type AbortOptions,
  awaitWithTimeout,
  buildSubmitBlockedWarningMessage,
  ProviderAdapterError,
  ProviderAdapterUnsupportedError,
  createDeferred,
  delayAsync,
} from './adapter-base.ts'
import {
  abortable,
  isAbortError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import { retryAsync } from '../../shared/retry.ts'
import { waitAsync } from '../../shared/wait.ts'
import type { Locator } from 'playwright'
import { emptyHistoryResult, parseGlmHistory } from '../conversation-history.ts'

const GLM_CHAT_URL = 'https://chat.z.ai'
const GLM_READY_BUTTON_SELECTOR = '#send-message-button'
const GLM_COMPOSER_SELECTOR = '#chat-input'
const GLM_UPLOAD_BUTTON_SELECTOR = '#upload-file-button'
const GLM_MODEL_TRIGGER_SELECTOR = 'button[id^="model-selector-"]'
const GLM_MODEL_MENU_SELECTOR = '[data-dropdown-menu-content]'
const GLM_MODEL_ITEM_SELECTOR = 'button[data-value]'
const GLM_STOP_BUTTON_SELECTOR =
  '.messageInputContainer button.bg-black.rounded-full'
const GLM_SIGNED_OUT_AVATAR_SELECTOR =
  'div.pointer-events-auto.px-1\\.5.pb-3\\.5 > button > svg[viewBox="0 0 20 20"] path[fill-rule="evenodd"][clip-rule="evenodd"]'
const GLM_BLOCKING_DIALOG_SELECTOR = '[data-dialog-overlay][data-state="open"]'
const GLM_ADVANCED_SEARCH_SWITCH_SELECTOR =
  '[data-tooltip-content] button[role="switch"][data-switch-root]'
const GLM_SUBMIT_RESPONSE_TIMEOUT_MS = 300000
const GLM_HISTORY_LOAD_TIMEOUT_MS = 60000
const GLM_HISTORY_PAGE_TIMEOUT_MS = 10000
const GLM_HISTORY_POLL_MS = 100

export type GlmToggleCapability = 'thinking' | 'search' | 'advanced_search'
export type GlmToggleState = 'on' | 'off'

type GlmDirectToggleCapability = Exclude<GlmToggleCapability, 'advanced_search'>

const GLM_TOGGLE_BUTTON_SELECTORS: Record<GlmDirectToggleCapability, string> = {
  thinking: 'button[data-autothink]',
  search: 'button[data-active]:has(svg[viewBox="0 0 15 15"])',
}

interface GlmStreamError {
  code: string
  detail: string | null
}

interface GlmParsedResponse {
  text: string
  isFinished: boolean
  error: GlmStreamError | null
}

interface GlmAdvancedSearchSnapshot {
  enabled: boolean
  state: GlmToggleState
}

function readGlmConversationIdFromUrl(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.hostname !== 'chat.z.ai') {
      return undefined
    }
    const match = url.pathname.match(/^\/c\/([^/?#]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

function isGlmCompletionUrl(value: string): boolean {
  try {
    const url = new URL(value, GLM_CHAT_URL)
    return (
      url.origin === GLM_CHAT_URL && url.pathname === '/api/v2/chat/completions'
    )
  } catch {
    return false
  }
}

export class GlmAdapter extends ProviderAdapter {
  private conversationIdVal!: string | null

  private getSendButton() {
    return this.page.locator(GLM_READY_BUTTON_SELECTOR).first()
  }

  private getUploadButton() {
    return this.page.locator(GLM_UPLOAD_BUTTON_SELECTOR).first()
  }

  private getToggleButton(capability: GlmDirectToggleCapability) {
    return this.page.locator(GLM_TOGGLE_BUTTON_SELECTORS[capability]).first()
  }

  private async findAdvancedSearchSwitch(): Promise<Locator | null> {
    await this.page.bringToFront()
    await this.page.keyboard.press('Escape').catch(() => {})
    await this.page.mouse.move(1, 1)
    await this.getToggleButton('search').locator('..').hover({
      force: true,
      timeout: 5000,
    })
    const advancedSearchSwitch = this.page
      .locator(GLM_ADVANCED_SEARCH_SWITCH_SELECTOR)
      .first()
    try {
      await advancedSearchSwitch.waitFor({ state: 'visible', timeout: 2000 })
      return advancedSearchSwitch
    } catch {
      return null
    }
  }

  private async getAdvancedSearchSnapshot(): Promise<GlmAdvancedSearchSnapshot | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const button = await this.findAdvancedSearchSwitch()
      if (button !== null) {
        const snapshot = await button
          .evaluate((element) => ({
            enabled: !(element as HTMLButtonElement).disabled,
            checked: element.getAttribute('aria-checked') === 'true',
          }))
          .catch(() => null)
        if (snapshot !== null) {
          return {
            enabled: snapshot.enabled,
            state: snapshot.checked ? 'on' : 'off',
          }
        }
      }
      await delayAsync(100)
    }
    return null
  }

  private async applyAdvancedSearchState(
    targetState: GlmToggleState
  ): Promise<boolean | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const button = await this.findAdvancedSearchSwitch()
      if (button !== null) {
        const result = await button
          .evaluate((element, target) => {
            const targetButton = element as HTMLButtonElement
            if (targetButton.disabled) {
              return { enabled: false }
            }
            const currentState =
              targetButton.getAttribute('aria-checked') === 'true'
                ? 'on'
                : 'off'
            if (currentState !== target) {
              targetButton.click()
            }
            return { enabled: true }
          }, targetState)
          .catch(() => null)
        if (result !== null) {
          return result.enabled
        }
      }
      await delayAsync(100)
    }
    return null
  }

  private async closeAdvancedSearchTooltip(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {})
  }

  public async hasToggleCapability(
    capability: GlmToggleCapability
  ): Promise<boolean> {
    if (capability === 'advanced_search') {
      return await this.wrapAdapterActionErrorAsync(
        `${capability}Available`,
        async () => {
          try {
            const snapshot = await this.getAdvancedSearchSnapshot()
            return snapshot !== null && snapshot.enabled
          } finally {
            await this.closeAdvancedSearchTooltip()
          }
        }
      )
    }

    return await this.wrapAdapterActionErrorAsync(
      `${capability}Available`,
      async () => {
        const buttons = this.page.locator(
          GLM_TOGGLE_BUTTON_SELECTORS[capability]
        )
        return (
          (await buttons.count()) > 0 &&
          (await buttons
            .first()
            .isVisible()
            .catch(() => false))
        )
      }
    )
  }

  public async getToggleState(
    capability: GlmToggleCapability
  ): Promise<GlmToggleState> {
    if (capability === 'advanced_search') {
      return await this.wrapAdapterActionErrorAsync(
        `${capability}Status`,
        async () => {
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
      )
    }

    if (!(await this.hasToggleCapability(capability))) {
      throw new ProviderAdapterUnsupportedError(
        `${capability}Status`,
        `GLM ${capability} capability is not available on this page.`
      )
    }

    const attribute =
      capability === 'thinking' ? 'data-autothink' : 'data-active'
    const value = await this.wrapAdapterActionErrorAsync(
      `${capability}Status`,
      async () => await this.getToggleButton(capability).getAttribute(attribute)
    )
    return value === 'true' ? 'on' : 'off'
  }

  public async setToggleState(
    capability: GlmToggleCapability,
    targetState: GlmToggleState
  ): Promise<GlmToggleState> {
    if (capability === 'advanced_search') {
      return await this.wrapAdapterActionErrorAsync(
        `${capability}Set`,
        async () => {
          if (targetState === 'on') {
            await this.setToggleState('thinking', 'on')
            await this.setToggleState('search', 'on')
          }

          try {
            const applied = await this.applyAdvancedSearchState(targetState)
            if (applied !== true) {
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
      )
    }

    return await this.wrapAdapterActionErrorAsync(
      `${capability}Set`,
      async () => {
        const button = this.getToggleButton(capability)
        const currentState = await this.getToggleState(capability)
        if (currentState !== targetState) {
          await button.click()
        }
        return await this.getToggleState(capability)
      }
    )
  }

  private async waitForReadyButton(
    action: 'restore' | 'submit',
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const readyButton = this.getSendButton()
    await waitAsync(
      async () => await readyButton.isVisible().catch(() => false),
      {
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
      }
    )
  }

  private async isSendButtonReady(): Promise<boolean> {
    const sendButton = this.getSendButton()
    return (
      (await sendButton.isVisible().catch(() => false)) &&
      (await sendButton.isEnabled().catch(() => false))
    )
  }

  private async dismissBlockingDialog(
    action: string,
    signal?: AbortSignal
  ): Promise<void> {
    const overlay = this.page.locator(GLM_BLOCKING_DIALOG_SELECTOR).first()
    if (!(await overlay.isVisible().catch(() => false))) {
      return
    }
    throwIfAborted(signal)
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

  private async clickComposerWithDialogRecovery(): Promise<void> {
    const composer = this.page.locator(GLM_COMPOSER_SELECTOR).first()
    try {
      await composer.click({ timeout: 2000 })
    } catch {
      await this.dismissBlockingDialog('attachText')
      await composer.click()
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ProviderAdapterUnsupportedError) {
      return false
    }
    if (error instanceof ProviderAdapterError) {
      if (error.retryable) {
        return true
      }
      return this.isRetryableError(error.cause)
    }
    if (!(error instanceof Error)) {
      return false
    }
    const message = error.message.toLowerCase()
    return (
      message.includes('timed out') ||
      message.includes('timeout') ||
      message.includes('net::') ||
      message.includes('network') ||
      message.includes('socket') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('connection closed') ||
      message.includes('connection reset') ||
      message.includes('target page, context or browser has been closed')
    )
  }

  protected async init(options: AbortOptions = {}) {
    await super.init(options)
    const { signal } = options
    this.conversationIdVal =
      readGlmConversationIdFromUrl(this.options.conversationUrl) ?? null
    await this.restore({ signal })
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    const { signal } = options
    const isAvailable = async () => {
      try {
        return new URL(this.page.url()).hostname === 'chat.z.ai'
      } catch {
        return false
      }
    }

    try {
      await retryAsync(async () => {
        await this.wrapAdapterActionErrorAsync('restore', async () => {
          await abortable(
            this.page.goto(this.conversationUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            }),
            signal
          )
          await waitAsync(async () => await isAvailable(), {
            timeoutMs: 60000,
            signal,
          })
        })
      })
      await this.waitForReadyButton('restore', 60000, signal)
      if (!(await this.isLoggedIn())) {
        throw new ProviderAdapterError(
          'restore',
          'GLM is not logged in for the current browser profile.',
          {
            kind: 'auth',
            recovery: 'none',
            retryable: false,
            maxAttempts: 1,
            detailCode: 'glm_signed_out',
          }
        )
      }
      await this.dismissBlockingDialog('restore', signal)
      await this.waitForReadyButton('restore', 60000, signal)
    } catch (error) {
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'restore',
          'GLM restore failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'glm_restore_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  public async loadHistory(options: AbortOptions = {}) {
    const { signal } = options
    throwIfAborted(signal)
    const readResult = async () => {
      const metadataEntries = await this.getCapturedHistoryEntries(
        (entry) =>
          entry.method === 'GET' &&
          entry.status === 200 &&
          /\/api\/v1\/chats\/[^/?#]+$/.test(entry.url),
        options
      )
      const batchEntries = await this.getCapturedHistoryEntries(
        (entry) =>
          entry.method === 'POST' &&
          entry.status === 200 &&
          entry.url.includes('/messages/batch'),
        options
      )
      const metadata = metadataEntries.find((entry) =>
        entry.chunks.join('').trim()
      )
      const batches = batchEntries
        .map((entry) => entry.chunks.join(''))
        .filter((body) => body.trim())
      return {
        bodyCount: batches.length,
        result:
          metadata === undefined || batches.length === 0
            ? emptyHistoryResult('GLM history response was not captured.')
            : parseGlmHistory(metadata.chunks.join(''), batches),
      }
    }

    let state = await readResult()
    const deadline = Date.now() + GLM_HISTORY_LOAD_TIMEOUT_MS
    while (!state.result.complete && Date.now() < deadline) {
      throwIfAborted(signal)
      const scrolled = await this.page
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
      if (!scrolled) break

      const previousBodyCount = state.bodyCount
      const previousMessageCount = state.result.messages.length
      const pageDeadline = Math.min(
        deadline,
        Date.now() + GLM_HISTORY_PAGE_TIMEOUT_MS
      )
      let progressed = false
      while (Date.now() < pageDeadline) {
        await delayAsync(
          Math.min(GLM_HISTORY_POLL_MS, pageDeadline - Date.now()),
          signal
        )
        const next = await readResult()
        state = next
        if (
          next.result.complete ||
          next.bodyCount > previousBodyCount ||
          next.result.messages.length > previousMessageCount
        ) {
          progressed = true
          break
        }
      }
      if (!progressed) break
    }
    return state.result
  }

  public async isLoggedIn(): Promise<boolean> {
    try {
      if (new URL(this.page.url()).hostname !== 'chat.z.ai') {
        return false
      }
    } catch {
      return false
    }

    const signedOutAvatarVisible = await this.page
      .locator(GLM_SIGNED_OUT_AVATAR_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
    return !signedOutAvatarVisible
  }

  public async changeModel(model: string): Promise<void> {
    const modelNumber = Number(model.trim())
    if (!Number.isSafeInteger(modelNumber) || modelNumber < 1) {
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `GLM does not support model "${model}".`
      )
    }
    const modelIndex = modelNumber - 1

    await this.dismissBlockingDialog('changeModel')
    await this.page.locator(GLM_MODEL_TRIGGER_SELECTOR).first().click()
    const modelMenu = this.page.locator(GLM_MODEL_MENU_SELECTOR).last()
    await waitAsync(
      async () => await modelMenu.isVisible().catch(() => false),
      { timeoutMs: 5000 }
    )
    const modelItems = modelMenu.locator(GLM_MODEL_ITEM_SELECTOR)
    if ((await modelItems.count()) <= modelIndex) {
      await this.page.keyboard.press('Escape').catch(() => {})
      throw new ProviderAdapterUnsupportedError(
        'changeModel',
        `GLM does not have model ${modelNumber}.`
      )
    }
    await modelItems.nth(modelIndex).click()
  }

  public async attachText(text: string): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachText', async () => {
      await this.dismissBlockingDialog('attachText')
      await this.clickComposerWithDialogRecovery()
      await this.page.keyboard.insertText(text)
    })
  }

  public async attachFile(path: string | readonly string[]): Promise<void> {
    await this.wrapAdapterActionErrorAsync('attachFile', async () => {
      await this.dismissBlockingDialog('attachFile')
      const uploadButtons = this.page.locator(GLM_UPLOAD_BUTTON_SELECTOR)
      if ((await uploadButtons.count()) === 0) {
        throw new ProviderAdapterUnsupportedError(
          'attachFile',
          'GLM file upload is not available in the current conversation.'
        )
      }

      const uploadButton = this.getUploadButton()
      const isAvailable =
        (await uploadButton.isVisible().catch(() => false)) &&
        (await uploadButton.isEnabled().catch(() => false))
      if (!isAvailable) {
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
    })
  }

  public async attachImage(path: string | readonly string[]): Promise<void> {
    await this.attachFile(path)
  }

  public override async stopGeneration(): Promise<void> {
    await this.clickLocatorIfReady(this.page.locator(GLM_STOP_BUTTON_SELECTOR))
  }

  private isTargetCompletionRequest(
    request: import('playwright').Request
  ): boolean {
    return isGlmCompletionUrl(request.url())
  }

  protected getSubmitBlockedWarningMessage(): string {
    return buildSubmitBlockedWarningMessage('GLM')
  }

  private async readCurrentStreamedResponseText(
    fetchCaptureStartIndex: number
  ): Promise<string | null> {
    const raw = await this.getLatestCapturedFetchBody(
      fetchCaptureStartIndex,
      (entry) => entry.method === 'POST' && isGlmCompletionUrl(entry.url)
    )
    if (!raw) {
      return null
    }

    const parsedResponse = this.parseResponse(raw)
    const text = parsedResponse?.text.trim() ?? ''
    return text ? parsedResponse!.text : null
  }

  public async submit(options: AbortOptions = {}): Promise<string> {
    try {
      return await this.wrapAdapterActionErrorAsync('submit', async () => {
        const { signal } = options
        throwIfAborted(signal)
        await this.dismissBlockingDialog('submit', signal)
        const sendButton = this.getSendButton()
        await waitAsync(async () => await this.isSendButtonReady(), {
          timeoutMs: GLM_SUBMIT_RESPONSE_TIMEOUT_MS,
          signal,
        })
        throwIfAborted(signal)

        const fetchCaptureStartIndex = await this.getCapturedFetchEntryCount()
        const requestStarted = createDeferred<void>()
        const targetResponse = createDeferred<import('playwright').Response>()
        let requestObserved = false
        let responseObserved = false
        let terminalError: unknown = null
        let warningTimer: NodeJS.Timeout | null = null
        let settled = false

        const stopWarningTimer = () => {
          if (warningTimer !== null) {
            clearInterval(warningTimer)
            warningTimer = null
          }
        }
        const resolveRequestStarted = () => {
          if (requestObserved) {
            return
          }
          requestObserved = true
          stopWarningTimer()
          requestStarted.resolve()
        }
        const settleTargetResponse = (
          resolution:
            | { kind: 'resolve'; response: import('playwright').Response }
            | { kind: 'reject'; error: unknown }
        ) => {
          if (settled) {
            return
          }
          settled = true
          stopWarningTimer()
          if (resolution.kind === 'resolve') {
            responseObserved = true
            targetResponse.resolve(resolution.response)
            return
          }
          terminalError = resolution.error
          targetResponse.reject(resolution.error)
        }

        const onRequest = (request: import('playwright').Request) => {
          if (this.isTargetCompletionRequest(request)) {
            resolveRequestStarted()
          }
        }
        const onRequestFailed = (request: import('playwright').Request) => {
          if (!this.isTargetCompletionRequest(request)) {
            return
          }
          resolveRequestStarted()
          const failureText =
            request.failure()?.errorText ?? 'unknown network failure'
          settleTargetResponse({
            kind: 'reject',
            error: new ProviderAdapterError(
              'submit',
              `GLM request failed before a response was received: ${failureText}`,
              {
                kind: 'transient',
                recovery: 'restore',
                retryable: true,
                maxAttempts: 2,
                detailCode: 'glm_submit_request_failed',
              }
            ),
          })
        }
        const onResponse = (response: import('playwright').Response) => {
          if (!this.isTargetCompletionRequest(response.request())) {
            return
          }
          resolveRequestStarted()
          settleTargetResponse({ kind: 'resolve', response })
        }
        const onClose = () => {
          settleTargetResponse({
            kind: 'reject',
            error: new Error(
              'Target page, context or browser has been closed.'
            ),
          })
        }

        this.page.on('request', onRequest)
        this.page.on('requestfailed', onRequestFailed)
        this.page.on('response', onResponse)
        this.page.on('close', onClose)

        let stopSubmitTextPolling = () => {}
        try {
          stopSubmitTextPolling = this.startSubmitTextPolling(
            async () =>
              await this.readCurrentStreamedResponseText(fetchCaptureStartIndex)
          )
          await sendButton.click()
          throwIfAborted(signal)

          await abortable(
            Promise.race([
              delayAsync(this.getSubmitRequestStartGraceMs()),
              requestStarted.promise,
              targetResponse.promise,
            ]).catch(() => {}),
            signal
          )

          if (!requestObserved && !responseObserved && terminalError === null) {
            const warningMessage = this.getSubmitBlockedWarningMessage()
            await this.emitSubmitStatus(warningMessage)
            warningTimer = setInterval(() => {
              void this.emitSubmitStatusSafely(warningMessage)
            }, this.getSubmitBlockedWarningIntervalMs())
            await abortable(
              Promise.race([requestStarted.promise, targetResponse.promise]),
              signal
            )
          }

          const response = await awaitWithTimeout(
            targetResponse.promise,
            GLM_SUBMIT_RESPONSE_TIMEOUT_MS,
            () =>
              new Error(
                'Timed out waiting for GLM response after the request started.'
              ),
            { signal }
          )
          throwIfAborted(signal)
          const rawResponse = await abortable(response.text(), signal)
          const parsedResponse = this.parseResponse(rawResponse)
          if (parsedResponse === null) {
            throw new ProviderAdapterError(
              'submit',
              'Failed to parse GLM response.',
              {
                kind: 'protocol',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'glm_response_parse_failed',
              }
            )
          }
          if (parsedResponse.error !== null) {
            throw this.createStreamError(parsedResponse.error)
          }
          if (!parsedResponse.isFinished) {
            throw new ProviderAdapterError(
              'submit',
              'GLM response ended without a completion marker.',
              {
                kind: 'protocol',
                recovery: 'none',
                retryable: false,
                maxAttempts: 1,
                detailCode: 'glm_response_incomplete',
              }
            )
          }

          await this.waitForReadyButton(
            'submit',
            GLM_SUBMIT_RESPONSE_TIMEOUT_MS,
            signal
          )
          this.conversationIdVal =
            this.conversationIdVal ??
            readGlmConversationIdFromUrl(this.page.url()) ??
            null
          await this.emitSubmitText(parsedResponse.text)
          throwIfAborted(signal)
          return parsedResponse.text
        } finally {
          stopSubmitTextPolling()
          stopWarningTimer()
          this.page.off('request', onRequest)
          this.page.off('requestfailed', onRequestFailed)
          this.page.off('response', onResponse)
          this.page.off('close', onClose)
        }
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (this.isRetryableError(error)) {
        throw new ProviderAdapterError(
          'submit',
          'GLM submit failed due to a temporary page or network issue.',
          {
            kind: 'transient',
            recovery: 'restore',
            retryable: true,
            maxAttempts: 2,
            detailCode: 'glm_submit_transient_failure',
            cause: error,
          }
        )
      }
      throw error
    }
  }

  private createStreamError(error: GlmStreamError): ProviderAdapterError {
    const normalizedCode = error.code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    const isRateLimit = /(?:rate|limit|concurrency)/i.test(error.code)
    return new ProviderAdapterError(
      'submit',
      `GLM response failed: ${error.detail ?? error.code}`,
      {
        kind: isRateLimit ? 'rate_limit' : 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: normalizedCode
          ? `glm_stream_error_${normalizedCode}`
          : 'glm_stream_error',
      }
    )
  }

  private parseResponse(raw: string): GlmParsedResponse | null {
    let text = ''
    let isFinished = false
    let streamError: GlmStreamError | null = null

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) {
        continue
      }
      const payload = line.slice(5).trim()
      if (!payload) {
        continue
      }
      if (payload === '[DONE]') {
        isFinished = true
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue
      }
      const record = parsed as Record<string, unknown>
      if (record.data === '[DONE]') {
        isFinished = true
        continue
      }
      if (record.type !== 'chat:completion') {
        continue
      }
      if (
        !record.data ||
        typeof record.data !== 'object' ||
        Array.isArray(record.data)
      ) {
        continue
      }

      const data = record.data as Record<string, unknown>
      const phase = typeof data.phase === 'string' ? data.phase : null
      if (phase === 'answer' && typeof data.delta_content === 'string') {
        text += data.delta_content
      } else if (
        phase === null &&
        typeof data.content === 'string' &&
        data.content
      ) {
        text += data.content
      }

      if (
        data.error &&
        typeof data.error === 'object' &&
        !Array.isArray(data.error)
      ) {
        const errorRecord = data.error as Record<string, unknown>
        streamError = {
          code:
            typeof errorRecord.code === 'string' ? errorRecord.code : 'UNKNOWN',
          detail:
            typeof errorRecord.detail === 'string' ? errorRecord.detail : null,
        }
      }
      if (phase === 'done' || data.done === true) {
        isFinished = true
      }
    }

    const normalizedText = text.trim()
    if (!normalizedText && streamError === null) {
      return null
    }
    return {
      text: normalizedText,
      isFinished,
      error: streamError,
    }
  }

  public get conversationId(): string | null {
    return this.conversationIdVal
  }

  public get conversationUrl(): string {
    return new URL(
      this.conversationId
        ? `${GLM_CHAT_URL}/c/${this.conversationId}`
        : GLM_CHAT_URL
    ).toString()
  }
}
