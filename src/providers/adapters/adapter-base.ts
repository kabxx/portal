import type { CDPSession, Locator, Page, Response } from 'playwright'
import {
  abortable,
  type AbortOptions,
  isAbortError,
  throwIfAborted,
  toError,
} from '../../runtime/runtime-cancellation.ts'
import { abortableSleep } from '../../shared/sleep.ts'
import {
  emptyHistoryResult,
  type ConversationHistoryResult,
} from '../conversation-history.ts'
import {
  resolveProviderComposerLimit,
  type ComposerLimit,
} from '../composer-limit.ts'
import type { ProviderId } from '../provider-id.ts'

export type { AbortOptions } from '../../runtime/runtime-cancellation.ts'

export interface ProviderPage {
  close(): Promise<void>
  pause(): Promise<void>
  on(event: 'response', listener: (response: Response) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'response', listener: (response: Response) => void): unknown
  off(event: 'close', listener: () => void): unknown
  isClosed(): boolean
  addInitScript?(script: unknown): Promise<unknown>
  evaluate?(pageFunction: unknown, argument?: unknown): Promise<unknown>
}

export interface ProviderCdpSession {
  on(event: string, listener: (event: unknown) => void): unknown
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  detach(): Promise<void>
}

export interface ProviderBrowserContext<
  TPage extends ProviderPage = Page,
  TSession extends ProviderCdpSession = CDPSession,
> {
  newPage(): Promise<TPage>
  newCDPSession?(page: TPage): Promise<TSession>
}

export const DEFAULT_SUBMIT_REQUEST_START_GRACE_MS = 30000
export const DEFAULT_SUBMIT_BLOCKED_WARNING_INTERVAL_MS = 30000
export const DEFAULT_RESPONSE_START_TIMEOUT_MS = 30000
export const DEFAULT_RESPONSE_STALL_TIMEOUT_MS = 30000
const HISTORY_CAPTURE_POLL_MS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCapturedFetchEntry(value: unknown): value is CapturedFetchEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.url === 'string' &&
    typeof value.method === 'string' &&
    (typeof value.status === 'number' || value.status === null) &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunk) => typeof chunk === 'string') &&
    (value.requestBody === undefined ||
      value.requestBody === null ||
      typeof value.requestBody === 'string') &&
    typeof value.done === 'boolean' &&
    (typeof value.error === 'string' || value.error === null)
  )
}

export type ProviderAdapterErrorKind =
  | 'unsupported'
  | 'auth'
  | 'transient'
  | 'ui'
  | 'protocol'
  | 'rate_limit'
  | 'unknown'

export type ProviderAdapterRecoveryAction =
  | 'none'
  | 'retry'
  | 'restore'
  | 'reload'

export interface RecoverableProviderAdapter {
  close(): Promise<void>
  isLoggedIn(): Promise<boolean>
  restore(options?: AbortOptions): Promise<void>
}

export interface ProviderAdapterErrorOptions {
  adapter?: RecoverableProviderAdapter | null
  kind?: ProviderAdapterErrorKind
  recovery?: ProviderAdapterRecoveryAction
  retryable?: boolean
  maxAttempts?: number
  detailCode?: string | null
  cause?: unknown
}

interface ProviderRetryInputControls {
  provider: string
  isComposerReady(): Promise<boolean>
  readComposerText(): Promise<string>
  writeText(): Promise<void>
  clearComposer(): Promise<void>
  isStopActive(): Promise<boolean>
  isSendReady(): Promise<boolean>
}

export class ProviderAdapterError extends Error {
  public kind: ProviderAdapterErrorKind
  public recovery: ProviderAdapterRecoveryAction
  public retryable: boolean
  public maxAttempts: number
  public detailCode: string | null
  public adapter: RecoverableProviderAdapter | null
  public readonly cause?: unknown

  constructor(
    public readonly action: string,
    message: string,
    {
      adapter = null,
      kind = 'unknown',
      recovery = 'none',
      retryable = false,
      maxAttempts = 1,
      detailCode = null,
      cause,
    }: ProviderAdapterErrorOptions = {}
  ) {
    super(message)
    this.name = 'ProviderAdapterError'
    this.kind = kind
    this.recovery = recovery
    this.retryable = retryable
    this.maxAttempts = Math.max(1, Math.trunc(maxAttempts))
    this.detailCode = detailCode
    this.adapter = adapter
    this.cause = cause
  }
}

export class ProviderAdapterActionError extends ProviderAdapterError {
  constructor(
    public readonly action: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(action, message, {
      kind: 'unknown',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
      cause,
    })
    this.name = 'ProviderAdapterActionError'
  }
}

export class ProviderAdapterRetryableError extends ProviderAdapterActionError {
  constructor(
    public readonly action: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(action, message, cause)
    this.name = 'ProviderAdapterRetryableError'
    this.retryable = true
    this.recovery = 'restore'
    this.maxAttempts = 2
    this.kind = 'transient'
  }
}

export class ProviderAdapterUnsupportedError extends ProviderAdapterError {
  constructor(
    public readonly action: string,
    message: string
  ) {
    super(action, message, {
      kind: 'unsupported',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
      cause: null,
    })
    this.name = 'ProviderAdapterUnsupportedError'
  }
}

export class ProviderResponseTimeoutError extends ProviderAdapterError {
  public constructor(phase: 'start' | 'stall', timeoutMs: number) {
    super(
      'submit',
      phase === 'start'
        ? `Provider did not send response activity within ${timeoutMs}ms after submit.`
        : `Provider response had no activity for ${timeoutMs}ms before completion.`,
      {
        kind: 'protocol',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode:
          phase === 'start'
            ? 'provider_response_start_timeout'
            : 'provider_response_stall_timeout',
      }
    )
    this.name = 'ProviderResponseTimeoutError'
  }
}

export function isProviderAdapterError(
  error: unknown
): error is ProviderAdapterError {
  return error instanceof ProviderAdapterError
}

export interface ProviderAdapterOptions {
  model: string | null
  skipSetup?: boolean
  signal?: AbortSignal | undefined
}

export interface ProviderAdapterCreateOptions {
  conversationUrl?: string | null
  signal?: AbortSignal | undefined
  timings?: ProviderTimingOptions
}

export interface ProviderTimingOptions {
  requestStartWarningAfterMs: number
  blockedWarningIntervalMs: number
  responseStartTimeoutMs: number
  responseStallTimeoutMs: number
  restoreTimeoutMs: number
  historyLoadTimeoutMs: number
  historyPageTimeoutMs: number
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  // Deferred producers may reject before consumers attach; observe immediately
  // while preserving the original promise for later consumption.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export function delayAsync(
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return abortableSleep(timeoutMs, signal)
}

export function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  onTimeout: () => Error,
  options: AbortOptions = {}
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timedPromise = new Promise<T>((resolve, reject) => {
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timer = null
        reject(onTimeout())
      }, timeoutMs)
    }

    void promise.then(
      (value) => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        resolve(value)
      },
      (error) => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        reject(toError(error, 'Provider operation failed.'))
      }
    )
  })
  return abortable(timedPromise, options.signal).finally(() => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  })
}

export function buildSubmitBlockedWarningMessage(providerName: string): string {
  return [
    `${providerName} submit has not started a provider request yet.`,
    'Check the browser and complete any verification if needed.',
    'Waiting for the page to resume or for a new request to start.',
  ].join('\n')
}

export interface CapturedFetchEntry {
  id: number
  url: string
  method: string
  requestBody?: string | null
  status: number | null
  chunks: string[]
  done: boolean
  error: string | null
}

interface CapturedCdpResponse {
  id: number
  requestId: string
  url: string
  method: string
  status: number | null
  completed: ReturnType<typeof createDeferred<void>>
  error: string | null
}

const FETCH_CAPTURE_INIT_SCRIPT = String.raw`
(() => {
  const install = () => {
    const globalObject = globalThis;
    if (globalObject.__portalFetchCaptureInstalled === true) {
      return;
    }
    if (globalObject.__portalFetchCaptureInstalling === true) {
      return;
    }

    try {
    globalObject.__portalFetchCaptureInstalling = true;
    globalObject.__portalFetchCaptureLastError = null;
    globalObject.__portalFetchCaptureEntries ??= [];
    globalObject.__portalFetchCaptureNextEntryId ??= 1;

    const registerEntry = (entry) => {
      globalObject.__portalFetchCaptureEntries?.push(entry);
      return entry;
    };

    const readRequestBody = (body) => {
      if (typeof body === 'string') {
        return body;
      }
      if (body instanceof ArrayBuffer) {
        return new TextDecoder('utf-8').decode(new Uint8Array(body));
      }
      if (ArrayBuffer.isView(body)) {
        return new TextDecoder('utf-8').decode(
          new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        );
      }
      return null;
    };

    globalObject.__portalGetFetchCaptureEntries = (startIndex = 0) => {
      const safeStartIndex = Number.isFinite(startIndex)
        ? Math.max(0, Math.floor(startIndex))
        : 0;
      return (globalObject.__portalFetchCaptureEntries ?? [])
        .slice(safeStartIndex)
        .map((entry) => ({
          ...entry,
          chunks: [...entry.chunks],
        }));
    };

    const scheduleRetry = () => {
      globalObject.__portalFetchCaptureInstalling = false;
      setTimeout(() => {
        globalObject.__portalFetchCaptureInstalled = false;
        globalObject.__portalFetchCaptureLastError = null;
        install();
      }, 0);
    };

    const fetchValue = globalObject.fetch;
    if (typeof fetchValue !== 'function') {
      scheduleRetry();
      return;
    }

    const OriginalXMLHttpRequest = globalObject.XMLHttpRequest;
    if (typeof OriginalXMLHttpRequest !== 'function') {
      scheduleRetry();
      return;
    }

    if (!globalObject.__portalOriginalFetch) {
      globalObject.__portalOriginalFetch = fetchValue.bind(globalObject);
    }
    if (!globalObject.__portalOriginalXMLHttpRequest) {
      globalObject.__portalOriginalXMLHttpRequest = OriginalXMLHttpRequest;
    }

    globalObject.fetch = async (...args) => {
      const requestLike = args[0];
      const init = args[1];
      const url =
        typeof requestLike === 'string'
          ? requestLike
          : requestLike instanceof Request
            ? requestLike.url
            : String(requestLike);
      const method = (
        init?.method ??
        (requestLike instanceof Request ? requestLike.method : null) ??
        'GET'
      ).toUpperCase();
      const requestBody = readRequestBody(init?.body);

      const response = await globalObject.__portalOriginalFetch(...args);
      const entry = registerEntry({
        id: globalObject.__portalFetchCaptureNextEntryId,
        url,
        method,
        requestBody,
        status: Number.isFinite(response.status) ? response.status : null,
        chunks: [],
        done: false,
        error: null,
      });
      globalObject.__portalFetchCaptureNextEntryId += 1;

      const clone = response.clone();
      const reader = clone.body?.getReader() ?? null;
      const decoder = new TextDecoder('utf-8');

      const finalize = () => {
        if (!entry.done) {
          const remainder = decoder.decode();
          if (remainder) {
            entry.chunks.push(remainder);
          }
          entry.done = true;
        }
      };

      if (reader === null) {
        void clone
          .text()
          .then((text) => {
            if (text) {
              entry.chunks.push(text);
            }
            finalize();
          })
          .catch((error) => {
            entry.error = String(error);
            finalize();
          });
        return response;
      }

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              finalize();
              break;
            }
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
              entry.chunks.push(chunk);
            }
          }
        } catch (error) {
          entry.error = String(error);
          finalize();
        }
      })();

      return response;
    };

    const xhrPrototype = globalObject.__portalOriginalXMLHttpRequest.prototype;
    if (!xhrPrototype.__portalOriginalOpen) {
      xhrPrototype.__portalOriginalOpen = xhrPrototype.open;
    }
    if (!xhrPrototype.__portalOriginalSend) {
      xhrPrototype.__portalOriginalSend = xhrPrototype.send;
    }
    if (!xhrPrototype.__portalPatched) {
      xhrPrototype.open = function(method, url, async, username, password) {
        this.__portalMethod = method.toUpperCase();
        this.__portalUrl = String(url);
        return xhrPrototype.__portalOriginalOpen.call(
          this,
          method,
          url,
          async ?? true,
          username ?? undefined,
          password ?? undefined
        );
      };

      xhrPrototype.send = function(body) {
        this.__portalEntry = registerEntry({
          id: globalObject.__portalFetchCaptureNextEntryId,
          url: this.__portalUrl ?? '',
          method: this.__portalMethod ?? 'GET',
          requestBody: readRequestBody(body),
          status: null,
          chunks: [],
          done: false,
          error: null,
        });
        globalObject.__portalFetchCaptureNextEntryId += 1;
        this.__portalLastResponseTextLength = 0;

        const appendResponseDelta = () => {
          if (this.__portalEntry === null || typeof this.responseText !== 'string') {
            return;
          }
          const nextResponseText = this.responseText;
          if (nextResponseText.length <= this.__portalLastResponseTextLength) {
            return;
          }
          this.__portalEntry.chunks.push(
            nextResponseText.slice(this.__portalLastResponseTextLength)
          );
          this.__portalLastResponseTextLength = nextResponseText.length;
        };

        this.addEventListener('progress', appendResponseDelta);
        this.addEventListener('readystatechange', () => {
          if (this.__portalEntry === null) {
            return;
          }
          this.__portalEntry.status = Number.isFinite(this.status)
            ? this.status
            : null;
          if (this.readyState === this.DONE) {
            appendResponseDelta();
            this.__portalEntry.done = true;
          }
        });
        this.addEventListener('error', () => {
          if (this.__portalEntry !== null) {
            this.__portalEntry.error = 'XMLHttpRequest failed.';
            this.__portalEntry.done = true;
          }
        });
        this.addEventListener('abort', () => {
          if (this.__portalEntry !== null) {
            this.__portalEntry.error = 'XMLHttpRequest aborted.';
            this.__portalEntry.done = true;
          }
        });
        this.addEventListener('loadend', () => {
          if (this.__portalEntry !== null) {
            appendResponseDelta();
            this.__portalEntry.status = Number.isFinite(this.status)
              ? this.status
              : null;
            this.__portalEntry.done = true;
          }
        });

        return xhrPrototype.__portalOriginalSend.call(this, body);
      };

      xhrPrototype.__portalPatched = true;
    }
    globalObject.__portalFetchCaptureInstalling = false;
    globalObject.__portalFetchCaptureInstalled = true;
    } catch (error) {
      globalObject.__portalFetchCaptureLastError = String(error);
      globalObject.__portalFetchCaptureInstalling = false;
    }
  };
  install();
})();
`

export abstract class ProviderAdapter<
  TPage extends ProviderPage = Page,
  TSession extends ProviderCdpSession = CDPSession,
> {
  protected get composerLimitProvider(): ProviderId | 'unknown' {
    return 'unknown'
  }

  protected context: ProviderBrowserContext<TPage, TSession>
  protected page!: TPage
  private submitStatusReporter:
    | ((message: string) => void | Promise<void>)
    | null = null
  private submitTextReporter:
    | ((message: string) => void | Promise<void>)
    | null = null
  private submitSentReporter: (() => void) | null = null
  private submitActivityReporter: (() => void) | null = null
  private submitDispatchReporter: (() => void) | null = null
  private readonly submitFetchActivitySnapshots = new Map<number, string>()
  private fetchCaptureInitialized = false
  private readonly capturedPageResponses: Response[] = []
  private readonly capturedPageResponseBodies = new WeakMap<
    Response,
    Promise<{ body: string; error: string | null }>
  >()
  private pageResponseListener: ((response: Response) => void) | null = null
  private portalClosing = false
  private cdpSession: TSession | null = null
  private cdpCacheDisabled = false
  private nextCdpResponseId = 1
  private readonly capturedCdpRequests = new Map<
    string,
    { url: string; method: string; headers: Record<string, string> }
  >()
  private readonly capturedCdpResponses = new Map<string, CapturedCdpResponse>()
  private readonly capturedCdpResponseBodies = new Map<
    string,
    Promise<{ body: string; error: string | null }>
  >()

  public constructor(
    context: ProviderBrowserContext<TPage, TSession>,
    protected readonly options: ProviderAdapterCreateOptions = {}
  ) {
    this.context = context
  }

  public static async create<
    TPage extends ProviderPage,
    TSession extends ProviderCdpSession,
    T extends ProviderAdapter<TPage, TSession>,
  >(
    this: new (
      context: ProviderBrowserContext<TPage, TSession>,
      options?: ProviderAdapterCreateOptions
    ) => T,
    context: ProviderBrowserContext<TPage, TSession>,
    options: ProviderAdapterCreateOptions = {}
  ): Promise<T> {
    const instance = new this(context, options)
    try {
      await instance.init({ signal: options.signal })
      return instance
    } catch (error) {
      if (error instanceof ProviderAdapterError && error.kind === 'auth') {
        error.adapter = instance
        throw error
      }
      await instance.close().catch(() => {})
      throw error
    }
  }

  protected async init(_options: AbortOptions = {}) {
    this.page = await this.context.newPage()
    if (this.options.conversationUrl && typeof this.page.on === 'function') {
      this.pageResponseListener = (response) => {
        this.capturedPageResponses.push(response)
        if (this.capturedPageResponses.length > 500) {
          this.capturedPageResponses.shift()
        }
      }
      this.page.on('response', this.pageResponseListener)
    }
    if (this.options.conversationUrl) {
      await this.startCdpHistoryCapture()
    }
    await this.ensureFetchCaptureInstalled()
  }

  public onUnexpectedPageClose(listener: () => void): () => void {
    let subscribed = true
    let closeObserved = false
    const onClose = () => {
      if (!subscribed || closeObserved) {
        return
      }
      closeObserved = true
      this.page.off('close', onClose)
      queueMicrotask(() => {
        if (!subscribed || this.portalClosing) {
          return
        }
        subscribed = false
        listener()
      })
    }

    this.page.on('close', onClose)
    if (this.page.isClosed()) {
      onClose()
    }

    return () => {
      if (!subscribed) {
        return
      }
      subscribed = false
      this.page.off('close', onClose)
    }
  }

  public async close() {
    this.portalClosing = true
    if (!this.page) {
      return
    }
    await this.finishHistoryCapture()
    await this.page.close()
  }

  public async finishHistoryCapture(): Promise<void> {
    await this.restoreCdpCache()
    if (
      this.pageResponseListener !== null &&
      typeof this.page?.off === 'function'
    ) {
      this.page.off('response', this.pageResponseListener)
    }
    this.pageResponseListener = null
    await this.cdpSession?.detach().catch(() => {})
    this.cdpSession = null
    this.capturedPageResponses.length = 0
    this.capturedCdpRequests.clear()
    this.capturedCdpResponses.clear()
    this.capturedCdpResponseBodies.clear()
  }

  public abstract restore(options?: AbortOptions): Promise<void>
  public abstract isLoggedIn(): Promise<boolean>
  public abstract get conversationId(): string | null
  public abstract get conversationUrl(): string

  public async loadHistory(
    _options: AbortOptions = {}
  ): Promise<ConversationHistoryResult> {
    return emptyHistoryResult(
      'This provider does not expose a history parser yet.'
    )
  }

  public async pause() {
    await this.page.pause()
  }

  public async stopGeneration(): Promise<void> {
    return undefined
  }

  public async getComposerLimit(
    options: AbortOptions = {}
  ): Promise<ComposerLimit> {
    throwIfAborted(options.signal)
    return this.composerLimitProvider === 'unknown'
      ? { kind: 'unknown', provider: 'unknown', source: 'unknown' }
      : await resolveProviderComposerLimit(
          this.page,
          this.composerLimitProvider,
          options
        )
  }

  protected async clickLocatorIfReady(locator: {
    count: () => Promise<number>
    first: () => {
      isVisible: () => Promise<boolean>
      click: () => Promise<void>
    }
  }): Promise<boolean> {
    if ((await locator.count().catch(() => 0)) !== 1) {
      return false
    }
    const target = locator.first()
    if (!(await target.isVisible().catch(() => false))) {
      return false
    }
    return await target
      .click()
      .then(() => true)
      .catch(() => false)
  }

  protected async getUniqueVisibleRetryLocator(
    locator: Locator
  ): Promise<Locator | null> {
    const count = await locator.count().catch(() => 0)
    let visible: Locator | null = null
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (!(await candidate.isVisible().catch(() => false))) {
        continue
      }
      if (visible !== null) {
        return null
      }
      visible = candidate
    }
    return visible
  }

  protected async isRetryComposerReady(locator: Locator): Promise<boolean> {
    const composer = await this.getUniqueVisibleRetryLocator(locator)
    return (
      composer !== null &&
      (await composer.isEditable().catch(() => false)) &&
      (await composer.isEnabled().catch(() => false))
    )
  }

  protected async readRetryComposerText(locator: Locator): Promise<string> {
    const composer = await this.getUniqueVisibleRetryLocator(locator)
    if (composer === null) {
      throw new Error('Retry Composer is missing or ambiguous.')
    }
    return await composer.evaluate((element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        return element.value
      }
      return element.textContent ?? ''
    })
  }

  protected async clearRetryComposerElements(locator: Locator): Promise<void> {
    const count = await locator.count()
    if (count === 0) {
      throw new Error('Retry Composer no longer exists.')
    }
    for (let index = 0; index < count; index += 1) {
      await locator.nth(index).evaluate((element) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          element.value = ''
        } else {
          element.textContent = ''
        }
        element.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
          })
        )
        element.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    const remainingCount = await locator.count()
    if (remainingCount === 0) {
      throw new Error('Retry Composer no longer exists after clearing.')
    }
    for (let index = 0; index < remainingCount; index += 1) {
      const remaining = await locator.nth(index).evaluate((element) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          return element.value
        }
        return element.textContent ?? ''
      })
      if (remaining !== '') {
        throw new Error('Retry Composer remained nonempty after clearing.')
      }
    }
  }

  protected async isRetryControlReady(locator: Locator): Promise<boolean> {
    const control = await this.getUniqueVisibleRetryLocator(locator)
    return control !== null && (await control.isEnabled().catch(() => false))
  }

  protected async isRetryControlActive(locator: Locator): Promise<boolean> {
    const count = await locator.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const control = locator.nth(index)
      if (
        (await control.isVisible().catch(() => false)) &&
        (await control.isEnabled().catch(() => false))
      ) {
        return true
      }
    }
    return false
  }

  public setSubmitStatusReporter(
    reporter: ((message: string) => void | Promise<void>) | null
  ) {
    this.submitStatusReporter = reporter
  }

  public setSubmitTextReporter(
    reporter: ((message: string) => void | Promise<void>) | null
  ) {
    this.submitTextReporter = reporter
  }

  public abstract changeModel(model: string): Promise<void>
  public abstract attachText(text: string): Promise<void>
  public abstract attachFile(path: string | readonly string[]): Promise<void>
  public abstract attachImage(path: string | readonly string[]): Promise<void>
  public abstract submit(options?: AbortOptions): Promise<string>

  protected async prepareRetrySubmitText(
    text: string,
    options: AbortOptions,
    controls: ProviderRetryInputControls
  ): Promise<() => Promise<void>> {
    let writeStarted = false

    try {
      throwIfAborted(options.signal)
      const composerReady = await controls.isComposerReady()
      throwIfAborted(options.signal)
      if (!composerReady) {
        throw this.createRetryInputError(
          controls.provider,
          'Composer is unavailable before retry.',
          'composer_unavailable'
        )
      }
      const composerText = await controls.readComposerText()
      throwIfAborted(options.signal)
      if (composerText !== '') {
        throw this.createRetryInputError(
          controls.provider,
          'Composer is not empty before retry.',
          'composer_not_empty'
        )
      }
      const stopActiveBeforeWrite = await controls.isStopActive()
      throwIfAborted(options.signal)
      if (stopActiveBeforeWrite) {
        throw this.createRetryInputError(
          controls.provider,
          'Provider is still generating before retry.',
          'generation_active'
        )
      }

      throwIfAborted(options.signal)
      writeStarted = true
      await controls.writeText()
      throwIfAborted(options.signal)
      const writtenText = await controls.readComposerText()
      throwIfAborted(options.signal)
      if (writtenText !== text) {
        throw this.createRetryInputError(
          controls.provider,
          'Composer content does not match the retry payload.',
          'composer_text_mismatch'
        )
      }
      const stopActiveAfterWrite = await controls.isStopActive()
      throwIfAborted(options.signal)
      if (stopActiveAfterWrite) {
        throw this.createRetryInputError(
          controls.provider,
          'Provider started generating before retry dispatch.',
          'generation_started'
        )
      }
      const sendReady = await controls.isSendReady()
      throwIfAborted(options.signal)
      if (!sendReady) {
        throw this.createRetryInputError(
          controls.provider,
          'Send control is unavailable after writing the retry payload.',
          'send_unavailable'
        )
      }
      throwIfAborted(options.signal)
      return async () => await controls.clearComposer()
    } catch (error) {
      if (writeStarted) {
        await this.clearRetryComposer(controls)
      }
      throw error
    }
  }

  protected async prepareRetrySubmit(
    _text: string,
    _options: AbortOptions
  ): Promise<() => Promise<void>> {
    throw new ProviderAdapterUnsupportedError(
      'retrySubmit',
      'This provider does not support automatic retry submission.'
    )
  }

  public async retrySubmitTextWithResponseTimeout(
    text: string,
    options: AbortOptions = {}
  ): Promise<string> {
    const clearComposer = await this.prepareRetrySubmit(text, options)
    let dispatchStarted = false

    try {
      return await this.runSubmitWithResponseTimeout(options, () => {
        dispatchStarted = true
      })
    } catch (error) {
      if (!dispatchStarted) {
        await this.clearRetryComposer({
          provider: this.constructor.name.replace(/Adapter$/, ''),
          clearComposer,
        })
      }
      throw error
    }
  }

  public async submitWithResponseTimeout(
    options: AbortOptions = {}
  ): Promise<string> {
    return await this.runSubmitWithResponseTimeout(options)
  }

  private async runSubmitWithResponseTimeout(
    options: AbortOptions,
    onDispatch?: () => void
  ): Promise<string> {
    const timeoutController = new AbortController()
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal])
    const timeoutDeferred = createDeferred<never>()
    let timeoutTimer: NodeJS.Timeout | null = null
    let timeoutError: ProviderResponseTimeoutError | null = null
    let settled = false
    let responseStarted = false
    let phase: 'start' | 'stall' = 'start'

    const clearTimer = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
    }
    const scheduleTimeout = (timeoutMs: number) => {
      clearTimer()
      timeoutTimer = setTimeout(() => {
        if (settled) return
        timeoutError = new ProviderResponseTimeoutError(phase, timeoutMs)
        timeoutController.abort(timeoutError)
        void this.stopGeneration().catch(() => {})
        timeoutDeferred.reject(timeoutError)
      }, timeoutMs)
    }

    this.submitFetchActivitySnapshots.clear()
    this.submitDispatchReporter = onDispatch ?? null
    this.submitSentReporter = () => {
      if (settled || timeoutError !== null || responseStarted) return
      phase = 'start'
      scheduleTimeout(this.getSubmitResponseStartTimeoutMs())
    }
    this.submitActivityReporter = () => {
      if (settled || timeoutError !== null) return
      responseStarted = true
      phase = 'stall'
      scheduleTimeout(this.getSubmitResponseStallTimeoutMs())
    }

    try {
      return await Promise.race([
        this.submit({ signal }),
        timeoutDeferred.promise,
      ])
    } catch (error) {
      throw timeoutError ?? error
    } finally {
      settled = true
      clearTimer()
      this.submitSentReporter = null
      this.submitActivityReporter = null
      this.submitDispatchReporter = null
      this.submitFetchActivitySnapshots.clear()
    }
  }

  private createRetryInputError(
    provider: string,
    message: string,
    suffix: string
  ): ProviderAdapterError {
    return new ProviderAdapterError('retrySubmit', `${provider}: ${message}`, {
      kind: 'ui',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
      detailCode: `${provider.toLowerCase()}_retry_${suffix}`,
    })
  }

  private async clearRetryComposer(
    controls: Pick<ProviderRetryInputControls, 'provider' | 'clearComposer'>
  ): Promise<void> {
    try {
      await controls.clearComposer()
    } catch (clearError) {
      throw new ProviderAdapterError(
        'retrySubmit',
        `${controls.provider}: retry input could not be cleared.`,
        {
          kind: 'ui',
          recovery: 'none',
          retryable: false,
          maxAttempts: 1,
          detailCode: `${controls.provider.toLowerCase()}_retry_clear_failed`,
          cause: clearError,
        }
      )
    }
  }

  protected async emitSubmitStatus(message: string): Promise<void> {
    await this.submitStatusReporter?.(message)
  }

  protected async emitSubmitStatusSafely(message: string): Promise<void> {
    await this.emitSubmitStatus(message).catch(() => {})
  }

  protected async emitSubmitText(message: string): Promise<void> {
    this.emitSubmitActivity()
    await this.submitTextReporter?.(message)
  }

  protected emitSubmitSent(): void {
    this.submitSentReporter?.()
  }

  protected emitSubmitDispatching(signal?: AbortSignal): void {
    throwIfAborted(signal)
    this.submitDispatchReporter?.()
  }

  protected emitSubmitActivity(): void {
    this.submitActivityReporter?.()
  }

  protected emitSubmitActivitySafely(): void {
    try {
      this.emitSubmitActivity()
    } catch {
      // Progress reporting must not interrupt provider submission.
    }
  }

  protected getSubmitRequestStartGraceMs(): number {
    return (
      this.options?.timings?.requestStartWarningAfterMs ??
      DEFAULT_SUBMIT_REQUEST_START_GRACE_MS
    )
  }

  protected getSubmitBlockedWarningIntervalMs(): number {
    return (
      this.options?.timings?.blockedWarningIntervalMs ??
      DEFAULT_SUBMIT_BLOCKED_WARNING_INTERVAL_MS
    )
  }

  protected getSubmitResponseStartTimeoutMs(): number {
    return (
      this.options?.timings?.responseStartTimeoutMs ??
      DEFAULT_RESPONSE_START_TIMEOUT_MS
    )
  }

  protected getSubmitResponseStallTimeoutMs(): number {
    return (
      this.options?.timings?.responseStallTimeoutMs ??
      DEFAULT_RESPONSE_STALL_TIMEOUT_MS
    )
  }

  protected getSubmitResponseTimeoutMs(): number | null {
    return null
  }

  protected getRestoreTimeoutMs(): number {
    return this.options?.timings?.restoreTimeoutMs ?? 180_000
  }

  protected getHistoryLoadTimeoutMs(): number {
    return this.options?.timings?.historyLoadTimeoutMs ?? 60_000
  }

  protected getHistoryPageTimeoutMs(): number {
    return this.options?.timings?.historyPageTimeoutMs ?? 10_000
  }

  protected async ensureFetchCaptureInstalled(): Promise<void> {
    if (this.fetchCaptureInitialized) {
      return
    }

    if (typeof this.page.addInitScript === 'function') {
      await this.page
        .addInitScript({ content: FETCH_CAPTURE_INIT_SCRIPT })
        .catch(() => {})
    }
    if (typeof this.page.evaluate === 'function') {
      await this.page.evaluate(FETCH_CAPTURE_INIT_SCRIPT).catch(() => {})
    }
    this.fetchCaptureInitialized = true
  }

  protected async getCapturedFetchEntries(
    startIndex = 0
  ): Promise<CapturedFetchEntry[]> {
    await this.ensureFetchCaptureInstalled()
    if (typeof this.page.evaluate !== 'function') {
      return []
    }

    const entries = await this.page
      .evaluate((startIndex: number) => {
        const globalObject = globalThis as typeof globalThis & {
          __portalGetFetchCaptureEntries?: (startIndex?: number) => Array<{
            id: number
            url: string
            method: string
            requestBody?: string | null
            status: number | null
            chunks: string[]
            done: boolean
            error: string | null
          }>
        }
        return globalObject.__portalGetFetchCaptureEntries?.(startIndex) ?? []
      }, startIndex)
      .catch(() => [])

    return Array.isArray(entries) ? entries.filter(isCapturedFetchEntry) : []
  }

  protected async getCapturedHistoryEntries(
    predicate: (entry: CapturedFetchEntry) => boolean,
    options: AbortOptions = {}
  ): Promise<CapturedFetchEntry[]> {
    try {
      let injectedEntries: CapturedFetchEntry[] = []
      const deadline = Date.now() + this.getHistoryPageTimeoutMs()
      while (true) {
        injectedEntries = (await this.getCapturedFetchEntries()).filter(
          predicate
        )
        const hasPageResponse = this.capturedPageResponses.some(
          (response, index) =>
            predicate({
              id: -(index + 1),
              url: response.url(),
              method: response.request().method(),
              status: response.status(),
              chunks: [],
              done: true,
              error: null,
            })
        )
        const hasCdpResponse = [...this.capturedCdpResponses.values()].some(
          (response) =>
            predicate({
              id: response.id,
              url: response.url,
              method: response.method,
              status: response.status,
              chunks: [],
              done: false,
              error: response.error,
            })
        )
        if (injectedEntries.length > 0 || hasPageResponse || hasCdpResponse) {
          break
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          break
        }
        await abortableSleep(
          Math.min(HISTORY_CAPTURE_POLL_MS, remainingMs),
          options.signal
        )
      }
      const pageResponses = this.capturedPageResponses
        .map((response, index) => ({
          response,
          entry: {
            id: -(index + 1),
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
            chunks: [],
            done: true,
            error: null,
          } satisfies CapturedFetchEntry,
        }))
        .filter(({ entry }) => predicate(entry))

      const pageEntries = await Promise.all(
        pageResponses.map(async ({ response, entry }) => {
          let bodyPromise = this.capturedPageResponseBodies.get(response)
          if (bodyPromise === undefined) {
            bodyPromise = response.text().then(
              (body) => ({ body, error: null }),
              (error) => ({ body: '', error: String(error) })
            )
            this.capturedPageResponseBodies.set(response, bodyPromise)
          }
          const captured = await abortable(bodyPromise, options.signal)
          return {
            ...entry,
            chunks: captured.body ? [captured.body] : [],
            error: captured.error,
          }
        })
      )
      const cdpEntries = await this.getCapturedCdpHistoryEntries(
        predicate,
        options
      )

      return [...cdpEntries, ...pageEntries, ...injectedEntries]
    } finally {
      await this.restoreCdpCache()
    }
  }

  protected async getCapturedHistoryRequestHeaders(
    predicate: (entry: CapturedFetchEntry) => boolean,
    options: AbortOptions = {}
  ): Promise<Record<string, string> | null> {
    const pageResponse = this.capturedPageResponses.find((response, index) =>
      predicate({
        id: -(index + 1),
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        chunks: [],
        done: true,
        error: null,
      })
    )
    if (pageResponse !== undefined) {
      try {
        return await abortable(
          pageResponse.request().allHeaders(),
          options.signal
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        return null
      }
    }

    for (const response of this.capturedCdpResponses.values()) {
      if (
        !predicate({
          id: response.id,
          url: response.url,
          method: response.method,
          status: response.status,
          chunks: [],
          done: false,
          error: response.error,
        })
      ) {
        continue
      }
      return this.capturedCdpRequests.get(response.requestId)?.headers ?? null
    }
    return null
  }

  private async startCdpHistoryCapture(): Promise<void> {
    if (typeof this.context.newCDPSession !== 'function') {
      return
    }
    try {
      const session = await this.context.newCDPSession(this.page)
      this.cdpSession = session
      session.on('Network.requestWillBeSent', (event) => {
        if (!isRecord(event) || !isRecord(event.request)) {
          return
        }
        const { requestId, request } = event
        if (
          typeof requestId !== 'string' ||
          typeof request.url !== 'string' ||
          typeof request.method !== 'string' ||
          !isRecord(request.headers)
        ) {
          return
        }
        this.capturedCdpRequests.set(requestId, {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name,
              String(value),
            ])
          ),
        })
      })
      session.on('Network.responseReceived', (event) => {
        if (!isRecord(event) || !isRecord(event.response)) {
          return
        }
        const { requestId, response } = event
        if (
          typeof requestId !== 'string' ||
          typeof response.url !== 'string' ||
          typeof response.status !== 'number'
        ) {
          return
        }
        const request = this.capturedCdpRequests.get(requestId)
        const existing = this.capturedCdpResponses.get(requestId)
        existing?.completed.resolve()
        this.capturedCdpResponses.set(requestId, {
          id: this.nextCdpResponseId++,
          requestId,
          url: response.url,
          method: request?.method ?? 'GET',
          status: response.status,
          completed: createDeferred<void>(),
          error: null,
        })
        this.trimCapturedCdpResponses()
      })
      session.on('Network.loadingFinished', (event) => {
        if (!isRecord(event) || typeof event.requestId !== 'string') {
          return
        }
        this.capturedCdpResponses.get(event.requestId)?.completed.resolve()
      })
      session.on('Network.loadingFailed', (event) => {
        if (
          !isRecord(event) ||
          typeof event.requestId !== 'string' ||
          typeof event.errorText !== 'string'
        ) {
          return
        }
        const response = this.capturedCdpResponses.get(event.requestId)
        if (response !== undefined) {
          response.error = event.errorText
          response.completed.resolve()
        }
      })
      await session.send('Network.enable', {
        maxTotalBufferSize: 64 * 1024 * 1024,
        maxResourceBufferSize: 16 * 1024 * 1024,
      })
      await session.send('Network.setCacheDisabled', { cacheDisabled: true })
      this.cdpCacheDisabled = true
    } catch {
      await this.cdpSession?.detach().catch(() => {})
      this.cdpSession = null
      this.cdpCacheDisabled = false
    }
  }

  private async getCapturedCdpHistoryEntries(
    predicate: (entry: CapturedFetchEntry) => boolean,
    options: AbortOptions
  ): Promise<CapturedFetchEntry[]> {
    const session = this.cdpSession
    if (session === null) {
      return []
    }
    const responses = [...this.capturedCdpResponses.values()].filter(
      (response) =>
        predicate({
          id: response.id,
          url: response.url,
          method: response.method,
          status: response.status,
          chunks: [],
          done: false,
          error: response.error,
        })
    )

    return await Promise.all(
      responses.map(async (response) => {
        await abortable(response.completed.promise, options.signal)
        let bodyPromise = this.capturedCdpResponseBodies.get(response.requestId)
        if (bodyPromise === undefined) {
          bodyPromise = session
            .send('Network.getResponseBody', { requestId: response.requestId })
            .then(
              (value) => {
                if (
                  !isRecord(value) ||
                  typeof value.body !== 'string' ||
                  typeof value.base64Encoded !== 'boolean'
                ) {
                  throw new Error('CDP returned an invalid response body.')
                }
                return {
                  body: value.base64Encoded
                    ? Buffer.from(value.body, 'base64').toString('utf8')
                    : value.body,
                  error: null,
                }
              },
              (error) => ({ body: '', error: String(error) })
            )
          this.capturedCdpResponseBodies.set(response.requestId, bodyPromise)
        }
        const captured = await abortable(bodyPromise, options.signal)
        return {
          id: response.id,
          url: response.url,
          method: response.method,
          status: response.status,
          chunks: captured.body ? [captured.body] : [],
          done: true,
          error: response.error ?? captured.error,
        }
      })
    )
  }

  private trimCapturedCdpResponses(): void {
    while (this.capturedCdpResponses.size > 500) {
      const requestId = this.capturedCdpResponses.keys().next().value
      if (typeof requestId !== 'string') return
      this.capturedCdpResponses.get(requestId)?.completed.resolve()
      this.capturedCdpResponses.delete(requestId)
      this.capturedCdpRequests.delete(requestId)
      this.capturedCdpResponseBodies.delete(requestId)
    }
  }

  private async restoreCdpCache(): Promise<void> {
    if (!this.cdpCacheDisabled || this.cdpSession === null) {
      return
    }
    this.cdpCacheDisabled = false
    await this.cdpSession
      .send('Network.setCacheDisabled', { cacheDisabled: false })
      .catch(() => {})
  }

  protected async getCapturedFetchEntryCount(): Promise<number> {
    await this.ensureFetchCaptureInstalled()
    if (typeof this.page.evaluate !== 'function') {
      return 0
    }

    const count = await this.page
      .evaluate(() => {
        const globalObject = globalThis as typeof globalThis & {
          __portalFetchCaptureEntries?: unknown[]
        }
        return globalObject.__portalFetchCaptureEntries?.length ?? 0
      })
      .catch(() => 0)

    return typeof count === 'number' && Number.isFinite(count) ? count : 0
  }

  protected async getLatestCapturedFetchBody(
    startIndex: number,
    predicate: (entry: CapturedFetchEntry) => boolean
  ): Promise<string | null> {
    const entries = (await this.getCapturedFetchEntries(startIndex)).filter(
      predicate
    )
    this.reportCapturedSubmitActivity(entries)
    const latestEntry = entries.at(-1) ?? null
    if (latestEntry === null) {
      return null
    }

    const body = latestEntry.chunks.join('')
    return body.trim() ? body : null
  }

  protected reportCapturedSubmitActivity(
    entries: readonly CapturedFetchEntry[]
  ): void {
    if (this.submitActivityReporter === null) return
    for (const entry of entries) {
      const snapshot = [
        entry.status ?? '',
        entry.chunks.length,
        entry.done,
        entry.error ?? '',
      ].join(':')
      if (this.submitFetchActivitySnapshots.get(entry.id) === snapshot) {
        continue
      }
      this.submitFetchActivitySnapshots.set(entry.id, snapshot)
      this.emitSubmitActivity()
    }
  }

  protected startSubmitTextPolling(
    readCurrentText: () => Promise<string | null>,
    intervalMs = 50
  ): () => void {
    let stopped = false
    let lastEmittedText = ''
    let pollInFlight = false

    const tick = async () => {
      if (stopped || pollInFlight) {
        return
      }
      pollInFlight = true
      try {
        const currentText = await readCurrentText()
        if (stopped || !currentText || currentText === lastEmittedText) {
          return
        }
        lastEmittedText = currentText
        await this.emitSubmitText(currentText)
      } catch (error) {
        if (!isAbortError(error)) {
          throw error
        }
      } finally {
        pollInFlight = false
      }
    }

    const timer = setInterval(() => {
      void tick().catch(() => {})
    }, intervalMs)
    void tick().catch(() => {})

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  protected async wrapAdapterActionErrorAsync<T>(
    action: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (error instanceof ProviderAdapterError) {
        throw error
      }
      throw new ProviderAdapterError(action, `Action failed during ${action}`, {
        kind: 'unknown',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: `${action}_failed`,
        cause: error,
      })
    }
  }
}
