import {
  ProviderAdapter,
  isProviderAdapterError,
} from '../providers/adapters/adapter-base.ts'
import { retryAsync } from '../shared/retry.ts'
import {
  abortable,
  type AbortOptions,
  isAbortError,
  throwIfAborted,
} from './runtime-cancellation.ts'
import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import {
  checkComposerLimit,
  ComposerLimitExceededError,
  type ComposerLimitCheck,
} from '../providers/composer-limit.ts'
import type { AgentSession } from '../agents/agent-extension.ts'
import type { AttachmentReader } from '../attachments/attachment-contracts.ts'
import type {
  ThreadRuntimeHandlers,
  ThreadToolCallMetadata,
} from '../threads/thread-runtime.ts'

export type RuntimeCoreHandlers = ThreadRuntimeHandlers
export type ToolCallMetadata = ThreadToolCallMetadata

export interface RuntimeCoreOptions {
  agentSession: AgentSession | null
  requestAttemptLimit?: number
  attachmentReader?: AttachmentReader
  onClose?: () => void | Promise<void>
}

/**
 * Kernel-side Provider session runtime. Text Tool extraction and execution
 * live in the web Provider implementation, not in this shared runtime.
 */
export abstract class RuntimeCore {
  private readonly agentSession: AgentSession | null
  private readonly requestAttemptLimit: number
  private readonly onClose: RuntimeCoreOptions['onClose']

  public constructor(
    private readonly agentAdapter: ProviderAdapter,
    options: RuntimeCoreOptions
  ) {
    this.agentSession = options.agentSession
    this.requestAttemptLimit = options.requestAttemptLimit ?? 3
    this.onClose = options.onClose
  }

  public abstract submitUserInput(
    input: string,
    handlers?: RuntimeCoreHandlers
  ): Promise<string>

  public async init(options: AbortOptions = {}): Promise<void> {
    const initialization = this.agentSession?.initialization ?? null
    if (initialization === null) return
    await this.retryAsync(async () => {
      throwIfAborted(options.signal)
      const limit = await this.agentAdapter.getComposerLimit({
        signal: options.signal,
      })
      const check = checkComposerLimit(initialization.prompt, limit)
      if (check.status === 'over_limit') {
        throw new ComposerLimitExceededError(check, 'internal')
      }
      await this.agentAdapter.attachText(initialization.prompt)
      throwIfAborted(options.signal)
      const response =
        await this.agentAdapter.submitWithResponseTimeout(options)
      throwIfAborted(options.signal)
      if (!initialization.accepts(response)) {
        throw new Error(
          'Agent initialization failed: response was not accepted.'
        )
      }
    }, options)
  }

  public async prepareExchangeInput(
    input: string,
    signal: AbortSignal = neverAbortedSignal
  ): Promise<string> {
    return this.agentSession === null
      ? input
      : await this.agentSession.prepareInput(input, signal)
  }

  public get conversationId(): string | null {
    return this.agentAdapter.conversationId
  }

  public get conversationUrl(): string {
    return this.agentAdapter.conversationUrl
  }

  public getAdapter(): ProviderAdapter {
    return this.agentAdapter
  }

  public async preflightInitialInput(
    input: string,
    signal?: AbortSignal
  ): Promise<ComposerLimitCheck> {
    const outboundText =
      this.agentSession === null
        ? input
        : await this.agentSession.previewInput(
            input,
            signal ?? neverAbortedSignal
          )
    const limit = await this.agentAdapter.getComposerLimit({ signal })
    throwIfAborted(signal)
    return checkComposerLimit(outboundText, limit)
  }

  public onUnexpectedPageClose(listener: () => void): () => void {
    return this.agentAdapter.onUnexpectedPageClose(listener)
  }

  private async retryAsync<T>(
    fn: () => Promise<T>,
    options: AbortOptions = {}
  ): Promise<T> {
    return await retryAsync(fn, {
      maxAttempts: this.requestAttemptLimit,
      retryIf: async (error, attempt) => {
        if (isAbortError(error) || !isProviderAdapterError(error)) {
          return false
        }
        return error.retryable && attempt + 1 < error.maxAttempts
      },
      onRetry: async (error) => {
        throwIfAborted(options.signal)
        if (!isProviderAdapterError(error)) return
        if (error.recovery === 'restore') {
          await abortable(
            this.agentAdapter.restore({ signal: options.signal }),
            options.signal
          )
          throwIfAborted(options.signal)
        }
      },
    })
  }

  public async pause(): Promise<void> {
    await this.agentAdapter.pause()
  }

  public async restore(options: AbortOptions = {}): Promise<void> {
    await this.agentAdapter.restore(options)
  }

  public async loadHistory(
    options: AbortOptions = {}
  ): Promise<ConversationHistoryResult> {
    try {
      return await this.agentAdapter.loadHistory(options)
    } finally {
      await this.agentAdapter.finishHistoryCapture()
    }
  }

  public async stopGeneration(): Promise<void> {
    await this.agentAdapter.stopGeneration()
  }

  public async close(): Promise<void> {
    const outcomes = await Promise.allSettled([
      this.agentAdapter.close(),
      Promise.resolve().then(async () => await this.agentSession?.close?.()),
      Promise.resolve().then(async () => await this.onClose?.()),
    ])
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected'
      )
      .map(({ reason }) => reason as unknown)
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Runtime close failed.')
    }
  }
}

const neverAbortedSignal = new AbortController().signal
