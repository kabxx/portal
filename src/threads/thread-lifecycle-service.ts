import type {
  ProjectInstructions,
  ProjectInstructionWarning,
} from '../instructions/project-instructions.ts'
import type { ProviderAdapter } from '../providers/adapters/adapter-base.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import { initializeRuntimeWithLoginWait } from '../runtime/runtime-initializer.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import type { ConversationHistoryResult } from '../providers/conversation-history.ts'
import type { HookExecutionScope } from '../hooks/hook-types.ts'
import {
  ThreadOperationCoordinator,
  ThreadCloseTimeoutError,
  type OperationStopTarget,
  type StartThreadOperationResult,
  type ThreadOperationContext,
  type ThreadOperationHandle,
} from './thread-operation-coordinator.ts'
import type {
  ThreadHandle,
  ThreadInputHandlers,
  ThreadInputResult,
  ThreadManager,
} from './thread-manager.ts'
import type { ThreadStore } from './thread-store.ts'
import type { ThreadCreationMode } from './thread-creation-mode.ts'
import {
  ConversationAlreadyClaimedError,
  ConversationReservationError,
  type ThreadRuntimeRegistry,
} from './thread-runtime-registry.ts'

const NEVER_ABORTED_SIGNAL = new AbortController().signal

export type ThreadLifecycleStage =
  | 'resolving'
  | 'preparing'
  | 'waiting_for_login'
  | 'building_runtime'
  | 'loading_history'
  | 'committing'
  | 'closing'

export type ThreadLifecycleEvent =
  | {
      type: 'provision.started'
      threadId: string
      source: ThreadLifecycleSource
      stage: 'resolving'
    }
  | {
      type: 'provision.warning'
      threadId: string
      source: ThreadLifecycleSource
      title: string
      lines: readonly string[]
    }
  | {
      type: 'provision.login_wait'
      threadId: string
      source: ThreadLifecycleSource
      provider: ProviderId
    }
  | {
      type: 'thread.ready'
      threadId: string
      source: ThreadLifecycleSource
      origin: 'new' | 'resumed'
      provider: ProviderId
      conversationUrl: string
    }
  | {
      type: 'thread.history'
      threadId: string
      source: ThreadLifecycleSource
      history: ConversationHistoryResult
    }
  | {
      type: 'thread.closed'
      threadId: string
      reason: ThreadCloseReason
    }
  | {
      type: 'provision.finished'
      threadId: string
      source: ThreadLifecycleSource
      status: 'failed' | 'cancelled'
      stage: ThreadLifecycleStage
      message: string
    }

export type ThreadCloseReason =
  | 'user'
  | 'provider_page_closed'
  | 'shutdown'
  | 'provision_failed'

export type ThreadLifecycleSource = HookExecutionScope['source']

export interface ThreadLifecycleObserver {
  onEvent(event: ThreadLifecycleEvent): void | Promise<void>
}

export interface ThreadLifecycleDependencies {
  threadManager: ThreadManager
  threadOperations: ThreadOperationCoordinator
  threadStore: ThreadStore
  runtimeRegistry: ThreadRuntimeRegistry<RuntimeCore>
  browserProfileDir: string
  initializationAttemptLimit: number
  resolveConversationUrl(
    value: string
  ): { provider: ProviderId; conversationUrl: string } | null
  createProjectInstructions(
    onWarning: (warning: ProjectInstructionWarning) => void | Promise<void>
  ): Promise<ProjectInstructions>
  createAdapter(input: {
    provider: ProviderId
    conversationUrl: string | null
    threadId: string
    signal: AbortSignal
  }): Promise<ProviderAdapter>
  createRuntime(input: {
    adapter: ProviderAdapter
    provider: ProviderId
    model: ResolvedProviderModel | null
    mode: ThreadCreationMode | 'resume'
    projectInstructions: ProjectInstructions
    signal: AbortSignal
  }): Promise<RuntimeCore>
  waitForLogin(signal: AbortSignal): Promise<void>
  observer?: ThreadLifecycleObserver
}

export type ThreadLifecycleFailureCode =
  | 'invalid_conversation'
  | 'conversation_already_open'
  | 'provider_failure'
  | 'history_failure'
  | 'cancelled'
  | 'not_found'
  | 'busy'

export interface ThreadLifecycleFailure {
  code: ThreadLifecycleFailureCode
  stage: ThreadLifecycleStage
  message: string
  threadId?: string
}

export interface ThreadLifecycleResult {
  ok: true
  threadId: string
  provider: ProviderId
  conversationUrl: string
  createdAt: number
  history: ConversationHistoryResult | null
  warnings: readonly string[]
}

export interface ThreadLifecycleFailureResult {
  ok: false
  failure: ThreadLifecycleFailure
}

export type ProvisionResult =
  | ThreadLifecycleResult
  | ThreadLifecycleFailureResult

export interface CreateThreadCommand {
  provider: ProviderId
  model: ResolvedProviderModel | null
  mode: ThreadCreationMode
  source?: ThreadLifecycleSource
  activate?: boolean
}

export interface ResumeThreadCommand {
  conversationUrl: string
  source?: ThreadLifecycleSource
  activate?: boolean
}

export interface CloseThreadResult {
  ok: true
  threadId: string
  closed: boolean
}

export class ThreadLifecycleService {
  private readonly activeOperations = new Map<string, ThreadOperationHandle>()

  public constructor(
    private readonly dependencies: ThreadLifecycleDependencies
  ) {}

  public async create(
    command: CreateThreadCommand,
    signal?: AbortSignal
  ): Promise<ProvisionResult> {
    return await this.provision(
      {
        origin: 'new',
        provider: command.provider,
        model: command.model,
        mode: command.mode,
        source: command.source ?? 'tui',
        activate:
          command.activate ??
          (command.source !== 'api' && command.source !== 'mcp'),
      },
      signal
    )
  }

  public async resume(
    command: ResumeThreadCommand,
    signal?: AbortSignal
  ): Promise<ProvisionResult> {
    return await this.provision(
      {
        origin: 'resumed',
        conversationUrl: command.conversationUrl,
        source: command.source ?? 'tui',
        activate:
          command.activate ??
          (command.source !== 'api' && command.source !== 'mcp'),
      },
      signal
    )
  }

  public async close(
    threadId: string,
    reason: ThreadCloseReason = 'user'
  ): Promise<CloseThreadResult> {
    if (this.dependencies.runtimeRegistry.has(threadId)) {
      this.dependencies.runtimeRegistry.setState(threadId, 'closing')
    }
    this.activeOperations.delete(threadId)
    let closeError: unknown = null
    let closed: boolean
    try {
      closed = await this.dependencies.threadOperations.close(
        threadId,
        async () =>
          await this.dependencies.threadManager.closeThread(threadId, 'system')
      )
    } catch (error) {
      closeError = error
      closed = this.dependencies.threadManager.getThread(threadId) === null

      // A provider page can disappear while a submit/cleanup operation is
      // stuck. The logical thread must still be removed, otherwise its dead
      // URL remains reserved forever. Keep the normal user close strict, but
      // use the former page-close recovery policy for this terminal signal.
      if (
        reason === 'provider_page_closed' &&
        error instanceof ThreadCloseTimeoutError &&
        !closed
      ) {
        let settled =
          await this.dependencies.threadOperations.waitForIdle(threadId)
        if (settled) {
          try {
            closed = await this.dependencies.threadOperations.close(
              threadId,
              async () =>
                await this.dependencies.threadManager.closeThread(
                  threadId,
                  'system'
                )
            )
            closeError = null
          } catch (retryError) {
            closeError = retryError
            settled = false
          }
        }
        if (
          !settled &&
          this.dependencies.threadManager.getThread(threadId) !== null
        ) {
          const lateSettlement =
            this.dependencies.threadOperations.abandon(threadId)
          try {
            closed = await this.dependencies.threadManager.closeThread(
              threadId,
              'system'
            )
            closeError = null
          } catch (forceCloseError) {
            closeError = forceCloseError
            closed =
              this.dependencies.threadManager.getThread(threadId) === null
          }
          void lateSettlement?.catch(() => {})
        }
      }
    }

    // A timeout means the ThreadManager still owns the runtime. Keep the URL
    // claim and closing admission state until the logical thread is removed.
    const removed =
      closed && this.dependencies.runtimeRegistry.has(threadId)
        ? this.dependencies.runtimeRegistry.remove(threadId)
        : null
    if (removed !== null) {
      await this.notify({ type: 'thread.closed', threadId, reason })
    }
    if (closeError !== null) {
      throw closeError instanceof Error
        ? closeError
        : new Error('Thread close failed.')
    }
    return { ok: true, threadId, closed }
  }

  public startSend(
    threadId: string,
    input: string,
    handlers:
      | ThreadInputHandlers
      | ((signal: AbortSignal) => Promise<void>) = {},
    onResult?: (result: ThreadInputResult | null) => void
  ): StartThreadOperationResult {
    return this.startOperation(threadId, async ({ signal }) => {
      if (typeof handlers === 'function') {
        await handlers(signal)
      } else {
        const result = await this.dependencies.threadManager.submitThreadInput(
          threadId,
          input,
          { ...handlers, signal }
        )
        onResult?.(result)
      }
    })
  }

  public startOperation(
    threadId: string,
    runner: (context: ThreadOperationContext) => Promise<void>,
    stopTarget?: OperationStopTarget | null
  ): StartThreadOperationResult {
    const thread = this.dependencies.threadManager.getThread(threadId)
    if (thread === null) {
      return { accepted: false, reason: 'not_found' }
    }
    const registrySnapshot =
      this.dependencies.runtimeRegistry.getSnapshot(threadId)
    if (registrySnapshot?.state === 'closing') {
      return { accepted: false, reason: 'closing' }
    }
    if (registrySnapshot !== null && registrySnapshot.state !== 'idle') {
      return { accepted: false, reason: 'running' }
    }
    if (registrySnapshot !== null) {
      this.dependencies.runtimeRegistry.setState(threadId, 'running')
    }
    const runtime =
      this.dependencies.runtimeRegistry.get(threadId)?.runtime ?? thread.runtime
    const startResult = this.dependencies.threadOperations.tryStart(
      threadId,
      stopTarget === undefined ? runtime : stopTarget,
      async (context) => await runner(context)
    )
    if (startResult.accepted) {
      const operation = this.wrapOperation(threadId, startResult.operation)
      this.activeOperations.set(threadId, operation)
      const settled = operation.settled ?? operation.done
      void settled.then(
        () => this.finishOperation(threadId, operation),
        () => this.finishOperation(threadId, operation)
      )
      return {
        accepted: true,
        operation,
      }
    }
    if (registrySnapshot !== null) {
      this.dependencies.runtimeRegistry.setState(threadId, 'idle')
    }
    return startResult
  }

  public async cancel(threadId: string): Promise<boolean> {
    const operation = this.activeOperations.get(threadId)
    if (operation === undefined) {
      return false
    }
    const snapshot = this.dependencies.runtimeRegistry.getSnapshot(threadId)
    if (snapshot?.state === 'running') {
      this.dependencies.runtimeRegistry.setState(threadId, 'cancelling')
    }
    await operation.cancel()
    return true
  }

  public async cancelAll(): Promise<void> {
    await Promise.all(
      this.dependencies.threadOperations.list().map(async ({ threadId }) => {
        await this.cancel(threadId)
      })
    )
  }

  public async send(
    threadId: string,
    input: string,
    handlers: ThreadInputHandlers = {}
  ): Promise<ThreadInputResult | null> {
    let result: ThreadInputResult | null = null
    const startResult = this.startSend(threadId, input, handlers, (value) => {
      result = value
    })
    if (!startResult.accepted) {
      return null
    }
    await startResult.operation.done
    return result
  }

  public async recordActivity(input: {
    threadId?: string
    provider: ProviderId
    conversationUrl: string
    title: string | null
    createdAt?: number
  }): Promise<string | null> {
    try {
      if (input.threadId !== undefined) {
        this.dependencies.runtimeRegistry.updateConversationIdentity(
          input.threadId,
          { conversationUrl: input.conversationUrl }
        )
      }
      await this.dependencies.threadStore.touch(input)
      if (input.title !== null) {
        await this.dependencies.threadStore.setTitleIfEmpty({
          conversationUrl: input.conversationUrl,
          title: input.title,
        })
      }
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return message
    }
  }

  private async provision(
    request:
      | {
          origin: 'new'
          provider: ProviderId
          model: ResolvedProviderModel | null
          mode: ThreadCreationMode
          source: ThreadLifecycleSource
          activate: boolean
        }
      | {
          origin: 'resumed'
          conversationUrl: string
          source: ThreadLifecycleSource
          activate: boolean
        },
    signal?: AbortSignal
  ): Promise<ProvisionResult> {
    const threadId = this.dependencies.runtimeRegistry.createThreadId()
    const warnings: string[] = []
    let provider: ProviderId | null = null
    let runtime: RuntimeCore | null = null
    let reservedUrl: string | null = null
    let history: ConversationHistoryResult | null = null
    let stage: ThreadLifecycleStage = 'resolving'

    await this.notify({
      type: 'provision.started',
      threadId,
      source: request.source,
      stage: 'resolving',
    })

    try {
      throwIfAborted(signal)
      let conversationUrl: string | null = null
      if (request.origin === 'resumed') {
        const resolved = this.dependencies.resolveConversationUrl(
          request.conversationUrl
        )
        if (resolved === null) {
          return await this.failure(
            threadId,
            'invalid_conversation',
            'resolving',
            `Unsupported conversation URL: ${request.conversationUrl}`,
            request.source
          )
        }
        provider = resolved.provider
        conversationUrl = resolved.conversationUrl
        try {
          this.dependencies.runtimeRegistry.reserveConversationUrl(
            threadId,
            conversationUrl
          )
        } catch (error) {
          if (error instanceof ConversationAlreadyClaimedError) {
            return await this.failure(
              threadId,
              'conversation_already_open',
              'resolving',
              error.message,
              request.source,
              error.threadId
            )
          }
          if (error instanceof ConversationReservationError) {
            return await this.failure(
              threadId,
              'conversation_already_open',
              'resolving',
              error.message,
              request.source,
              error.ownerId
            )
          }
          throw error
        }
        reservedUrl = conversationUrl
      } else {
        provider = request.provider
      }

      stage = 'preparing'
      const projectInstructions =
        await this.dependencies.createProjectInstructions(async (warning) => {
          await this.notify({
            type: 'provision.warning',
            threadId,
            source: request.source,
            title: 'instructions',
            lines: [
              warning.message,
              ...(warning.path === undefined
                ? []
                : [`source: ${warning.path}`]),
            ],
          })
        })
      throwIfAborted(signal)

      let waitingForLogin = false
      stage = 'building_runtime'
      await this.notify({
        type: 'provision.warning',
        threadId,
        source: request.source,
        title: 'thread',
        lines: ['Preparing provider session.'],
      })
      runtime = await initializeRuntimeWithLoginWait({
        provider,
        browserProfileDir: this.dependencies.browserProfileDir,
        threadId,
        createAdapter: async () =>
          await this.dependencies.createAdapter({
            provider: provider!,
            conversationUrl,
            threadId,
            signal: signal ?? NEVER_ABORTED_SIGNAL,
          }),
        createRuntime: async (adapter) =>
          await this.dependencies.createRuntime({
            adapter,
            provider: provider!,
            model: request.origin === 'new' ? request.model : null,
            mode: request.origin === 'new' ? request.mode : 'resume',
            projectInstructions,
            signal: signal ?? NEVER_ABORTED_SIGNAL,
          }),
        onWarning: async (plan) => {
          await this.notify({
            type: 'provision.warning',
            threadId,
            source: request.source,
            title: plan.title,
            lines: plan.lines,
          })
        },
        onLoginWait: async () => {
          if (!waitingForLogin) {
            waitingForLogin = true
            await this.notify({
              type: 'provision.login_wait',
              threadId,
              source: request.source,
              provider: provider!,
            })
          }
        },
        waitForLogin: async () =>
          await this.dependencies.waitForLogin(signal ?? NEVER_ABORTED_SIGNAL),
        signal,
        maxRetryAttempts: this.dependencies.initializationAttemptLimit,
      })
      throwIfAborted(signal)
      if (runtime === null) {
        return await this.failure(
          threadId,
          'provider_failure',
          'preparing',
          `Could not prepare ${provider} runtime.`,
          request.source
        )
      }

      if (request.origin === 'resumed') {
        stage = 'loading_history'
        try {
          history = await runtime.loadHistory({ signal })
        } catch (error) {
          if (isAbortError(error)) {
            throw error
          }
          const message = `Could not load remote conversation history: ${error instanceof Error ? error.message : String(error)}`
          history = {
            messages: [],
            complete: false,
            warning: message,
          }
          warnings.push(message)
        }
      }

      const actualUrl = runtime.conversationUrl
      stage = 'committing'
      let snapshot
      try {
        snapshot = this.dependencies.runtimeRegistry.commitPrepared({
          id: threadId,
          reservationOwnerId: threadId,
          provider,
          runtime,
          origin: request.origin === 'resumed' ? 'resumed' : 'new',
          source: request.source,
          conversationId: runtime.conversationId,
          conversationUrl: actualUrl,
          history:
            history === null
              ? { status: 'not_loaded' }
              : history.warning === null
                ? { status: 'complete' }
                : {
                    status: 'incomplete',
                    reasonCode: 'provider_warning',
                    message: history.warning,
                  },
          createdAt: Date.now(),
        })
      } catch (error) {
        if (error instanceof ConversationAlreadyClaimedError) {
          return await this.failure(
            threadId,
            'conversation_already_open',
            'committing',
            error.message,
            request.source,
            error.threadId
          )
        }
        if (error instanceof ConversationReservationError) {
          return await this.failure(
            threadId,
            'conversation_already_open',
            'committing',
            error.message,
            request.source,
            error.ownerId
          )
        }
        throw error
      }

      let thread: ThreadHandle
      try {
        thread = this.dependencies.threadManager.addThread({
          id: threadId,
          provider,
          runtime,
          createdAt: snapshot.createdAt,
          origin: request.origin === 'resumed' ? 'resumed' : 'new',
          source: request.source,
          activate: request.activate,
        })
      } catch (error) {
        this.dependencies.runtimeRegistry.setState(threadId, 'closing')
        this.dependencies.runtimeRegistry.remove(threadId)
        throw error
      }
      runtime = null
      try {
        await this.dependencies.threadStore.touch({
          provider,
          conversationUrl: actualUrl,
          title: null,
          createdAt: thread.createdAt,
        })
      } catch (error) {
        warnings.push(
          `Thread metadata was not persisted: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      await this.notify({
        type: 'thread.ready',
        threadId,
        source: request.source,
        origin: request.origin === 'resumed' ? 'resumed' : 'new',
        provider,
        conversationUrl: actualUrl,
      })
      if (history !== null) {
        await this.notify({
          type: 'thread.history',
          threadId,
          source: request.source,
          history,
        })
      }
      return {
        ok: true,
        threadId,
        provider,
        conversationUrl: actualUrl,
        createdAt: thread.createdAt,
        history,
        warnings,
      }
    } catch (error) {
      if (isAbortError(error)) {
        return await this.failure(
          threadId,
          'cancelled',
          'preparing',
          'Thread provisioning was cancelled.',
          request.source
        )
      }
      return await this.failure(
        threadId,
        request.origin === 'resumed' && stage === 'loading_history'
          ? 'history_failure'
          : 'provider_failure',
        stage,
        error instanceof Error ? error.message : String(error),
        request.source
      )
    } finally {
      if (runtime !== null) {
        await runtime.close().catch(() => {})
      }
      if (reservedUrl !== null) {
        this.dependencies.runtimeRegistry.releaseConversationUrl(
          threadId,
          reservedUrl
        )
      }
    }
  }

  private async notify(event: ThreadLifecycleEvent): Promise<void> {
    try {
      await this.dependencies.observer?.onEvent(event)
    } catch {
      // A UI/SSE observer cannot change the lifecycle result.
    }
  }

  private wrapOperation(
    threadId: string,
    operation: ThreadOperationHandle
  ): ThreadOperationHandle {
    return {
      ...operation,
      cancel: async () => {
        const active = this.activeOperations.get(threadId)
        if (active !== undefined && active.done !== operation.done) {
          return false
        }
        const snapshot = this.dependencies.runtimeRegistry.getSnapshot(threadId)
        if (snapshot?.state === 'running') {
          this.dependencies.runtimeRegistry.setState(threadId, 'cancelling')
        }
        return await operation.cancel()
      },
    }
  }

  private finishOperation(
    threadId: string,
    operation: ThreadOperationHandle
  ): void {
    if (this.activeOperations.get(threadId)?.done !== operation.done) {
      return
    }
    this.syncRuntimeIdentity(threadId)
    this.activeOperations.delete(threadId)
    const snapshot = this.dependencies.runtimeRegistry.getSnapshot(threadId)
    if (snapshot?.state === 'running' || snapshot?.state === 'cancelling') {
      this.dependencies.runtimeRegistry.setState(threadId, 'idle')
    }
  }

  private syncRuntimeIdentity(threadId: string): void {
    const entry = this.dependencies.runtimeRegistry.get(threadId)
    if (entry === null) {
      return
    }
    try {
      this.dependencies.runtimeRegistry.updateConversationIdentity(threadId, {
        conversationId: entry.runtime.conversationId,
        conversationUrl: entry.runtime.conversationUrl,
      })
    } catch (error) {
      void this.notify({
        type: 'provision.warning',
        threadId,
        source: entry.snapshot.source,
        title: 'thread',
        lines: [
          `Could not update the conversation identity: ${error instanceof Error ? error.message : String(error)}`,
        ],
      })
    }
  }

  private async failure(
    threadId: string,
    code: ThreadLifecycleFailureCode,
    stage: ThreadLifecycleStage,
    message: string,
    source: ThreadLifecycleSource,
    duplicateThreadId?: string
  ): Promise<ThreadLifecycleFailureResult> {
    await this.notify({
      type: 'provision.finished',
      threadId,
      source,
      status: code === 'cancelled' ? 'cancelled' : 'failed',
      stage,
      message,
    })
    return {
      ok: false,
      failure: {
        code,
        stage,
        message,
        ...(duplicateThreadId === undefined
          ? {}
          : { threadId: duplicateThreadId }),
      },
    }
  }
}
