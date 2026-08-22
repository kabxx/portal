import { randomUUID } from 'node:crypto'

import type { AttachmentRef } from '../attachments/attachment-contracts.ts'
import type {
  ProviderCompletion,
  ProviderEvent,
  ProviderMessage,
  ProviderToolCall,
} from '../providers/provider-exchange.ts'
import { PROVIDER_ATTACHMENT_CAPABILITY } from '../providers/provider-exchange.ts'
import type {
  ProviderBinding,
  ProviderHost,
} from '../providers/provider-host.ts'
import type { ToolHost, ToolResult } from '../tools/tool-host.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import type { AgentMode, AgentStartup } from '../agents/agent-extension.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'

export type ConversationItem =
  | { readonly kind: 'user'; readonly text: string }
  | {
      readonly kind: 'assistant'
      readonly text: string
      readonly toolCalls?: readonly ProviderToolCall[]
    }
  | {
      readonly kind: 'tool.request'
      readonly toolCallId: string
      readonly name: string
      readonly input: Record<string, unknown> | string
    }
  | {
      readonly kind: 'tool.result'
      readonly toolCallId: string
      readonly name: string
      readonly result: ToolResult
    }
  | { readonly kind: 'error'; readonly message: string }

export interface ConversationTurn {
  readonly id: string
  readonly status: 'running' | 'completed' | 'failed' | 'canceled'
  readonly items: readonly ConversationItem[]
}

export interface ConversationThread {
  readonly id: string
  readonly providerId: string
  readonly conversationId: string
  readonly revision: number
  readonly turns: readonly ConversationTurn[]
}

export class ConversationStore {
  #revision = 0
  readonly #threads = new Map<string, ConversationThread>()

  public create(input: {
    readonly id: string
    readonly providerId: string
    readonly conversationId: string
  }): ConversationThread {
    if (this.#threads.has(input.id)) {
      throw new Error(`Conversation already exists: ${input.id}`)
    }
    const thread = freezeThread({
      id: input.id,
      providerId: input.providerId,
      conversationId: input.conversationId,
      revision: ++this.#revision,
      turns: [],
    })
    this.#threads.set(thread.id, thread)
    return thread
  }

  public get(id: string): ConversationThread | null {
    return this.#threads.get(id) ?? null
  }

  public commit(
    id: string,
    expectedRevision: number,
    update: (current: ConversationThread) => ConversationThread
  ): ConversationThread {
    const current = this.#threads.get(id)
    if (current === undefined) throw new Error(`Conversation not found: ${id}`)
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Conversation revision conflict: expected ${expectedRevision}, actual ${current.revision}.`
      )
    }
    const next = freezeThread({
      ...update(current),
      id: current.id,
      providerId: current.providerId,
      conversationId: current.conversationId,
      revision: ++this.#revision,
    })
    this.#threads.set(id, next)
    return next
  }
}

export class ConversationHostError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ConversationHostError'
  }
}

export interface ConversationOpenOptions {
  readonly signal?: AbortSignal
  readonly providerId: string
  readonly providerOwnerId: string
  readonly conversationId?: string | null
  readonly selectionRevision: string
  readonly conversationUrl?: string | null
  readonly model?:
    | import('../providers/provider-model-catalog.ts').ResolvedProviderModel
    | null
  readonly agentMode: AgentMode | null
  readonly agentStartup: AgentStartup
  readonly workingDirectory?: string
  readonly spawnDepth?: number
  readonly sessionKey?: string | null
  readonly threadId?: string
  readonly onProviderEvent?: (event: ProviderEvent) => void | Promise<void>
}

export interface ConversationSendOptions {
  readonly signal?: AbortSignal
  readonly attachments?: readonly AttachmentRef[]
  readonly maxToolLoops?: number
  readonly onProviderEvent?: (event: ProviderEvent) => void | Promise<void>
  /**
   * Receives generated turn items at commit time. This keeps tool calls and
   * results observable while the tool loop is still running.
   */
  readonly onTurnItem?: (
    item: Exclude<ConversationItem, { readonly kind: 'user' }>
  ) => void | Promise<void>
  readonly onToolProgress?: import('../tools/tool-host.ts').ToolHandlerContext['onProgress']
  readonly invocation?: import('./child-conversation-service.ts').ChildConversationParent
}

export class ConversationHost {
  readonly #providerHost: ProviderHost
  readonly #toolHost: ToolHost
  readonly #store: ConversationStore
  readonly #root: ResourceScope
  readonly #bindings = new Map<string, ProviderBinding>()
  readonly #activeExchanges = new Map<
    string,
    { cancel(reason?: unknown): void | Promise<void> }
  >()
  readonly #busy = new Set<string>()

  public constructor(options: {
    readonly providerHost: ProviderHost
    readonly toolHost: ToolHost
    readonly store?: ConversationStore
    readonly root: ResourceScope
  }) {
    this.#providerHost = options.providerHost
    this.#toolHost = options.toolHost
    this.#store = options.store ?? new ConversationStore()
    this.#root = options.root
  }

  public async open(
    options: ConversationOpenOptions
  ): Promise<ConversationThread> {
    const binding = await this.#providerHost.openBinding(
      options.providerId,
      options.providerOwnerId,
      options.selectionRevision,
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        conversationUrl: options.conversationUrl ?? null,
        model: options.model ?? null,
        agentMode: options.agentMode,
        agentStartup: options.agentStartup,
        workingDirectory: options.workingDirectory ?? process.cwd(),
        spawnDepth: options.spawnDepth ?? 0,
        sessionKey: options.sessionKey ?? null,
        ...(options.onProviderEvent === undefined
          ? {}
          : { onEvent: options.onProviderEvent }),
      }
    )
    const id = options.threadId ?? `conversation-${randomUUID()}`
    try {
      throwIfAborted(options.signal)
      const thread = this.#store.create({
        id,
        providerId: options.providerId,
        conversationId: binding.conversationId ?? options.conversationId ?? id,
      })
      this.#bindings.set(id, binding)
      return thread
    } catch (error) {
      try {
        await binding.close(error)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Conversation ${id} creation and Provider cleanup both failed.`,
          { cause: cleanupError }
        )
      }
      throw error
    }
  }

  public async close(threadId: string, reason?: unknown): Promise<void> {
    const errors: unknown[] = []
    try {
      await this.stopGeneration(threadId, reason)
    } catch (error) {
      errors.push(error)
    }
    const binding = this.#bindings.get(threadId)
    this.#bindings.delete(threadId)
    try {
      await binding?.close(reason)
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Conversation ${threadId} failed to close cleanly.`
      )
    }
  }

  public get(threadId: string): ConversationThread | null {
    return this.#store.get(threadId)
  }

  public identity(threadId: string): {
    readonly conversationId: string | null
    readonly conversationUrl: string | null
  } | null {
    const binding = this.#bindings.get(threadId)
    return binding === undefined
      ? null
      : Object.freeze({
          conversationId: binding.conversationId,
          conversationUrl: binding.conversationUrl,
        })
  }

  public async preflight(
    threadId: string,
    input: string,
    signal?: AbortSignal
  ): Promise<{
    readonly status: 'unknown' | 'within_limit' | 'over_limit'
  }> {
    return await this.#requireBinding(threadId).preflightInput(input, signal)
  }

  public async restore(threadId: string, signal?: AbortSignal): Promise<void> {
    await this.#requireBinding(threadId).restore(signal)
  }

  public async loadHistory(
    threadId: string,
    signal?: AbortSignal
  ): Promise<
    import('../providers/conversation-history.ts').ConversationHistoryResult
  > {
    return await this.#requireBinding(threadId).loadHistory(signal)
  }

  public onUnexpectedClose(threadId: string, listener: () => void): () => void {
    return this.#requireBinding(threadId).onUnexpectedClose(listener)
  }

  public async stopGeneration(
    threadId: string,
    reason?: unknown
  ): Promise<void> {
    await this.#activeExchanges.get(threadId)?.cancel(reason)
  }

  public async listCapabilities(threadId: string, signal: AbortSignal) {
    return await this.#requireBinding(threadId).listCapabilities(signal)
  }

  public async executeCapability(
    threadId: string,
    name: string,
    args: readonly string[],
    signal: AbortSignal
  ) {
    return await this.#requireBinding(threadId).executeCapability(
      name,
      args,
      signal
    )
  }

  public async send(
    threadId: string,
    text: string,
    options: ConversationSendOptions = {}
  ): Promise<ConversationThread> {
    if (this.#busy.has(threadId)) {
      throw new ConversationHostError(
        `Conversation is already running: ${threadId}`
      )
    }
    const binding = this.#bindings.get(threadId)
    if (binding === undefined) {
      throw new ConversationHostError(`Conversation is not open: ${threadId}`)
    }
    const current = this.#store.get(threadId)
    if (current === null)
      throw new ConversationHostError(`Conversation not found: ${threadId}`)
    this.#busy.add(threadId)
    const turnId = `turn-${randomUUID()}`
    let thread = this.#store.commit(threadId, current.revision, (state) => ({
      ...state,
      turns: [
        ...state.turns,
        { id: turnId, status: 'running', items: [{ kind: 'user', text }] },
      ],
    }))
    const operationScope = this.#root.createChild(
      `conversation:${threadId}:${turnId}`
    )
    let activeExchange: {
      cancel(reason?: unknown): void | Promise<void>
    } | null = null
    let cancellation: Promise<void> | null = null
    const cancel = () => {
      cancellation ??= cancelConversationOperation(
        operationScope,
        activeExchange,
        options.signal?.reason
      )
      void cancellation.catch(() => undefined)
    }
    if (options.signal?.aborted === true) cancel()
    else options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      let toolLoops = 0
      const maxToolLoops = options.maxToolLoops ?? 8
      let attachments: readonly AttachmentRef[] = [
        ...(options.attachments ?? []),
      ]
      if (
        attachments.length > 0 &&
        !binding.capabilities.includes(PROVIDER_ATTACHMENT_CAPABILITY)
      ) {
        throw new ConversationHostError(
          `Provider ${binding.providerId} does not support attachments.`
        )
      }
      while (true) {
        if (operationScope.signal.aborted) throw operationScope.signal.reason
        const exchange = await binding.exchange(
          {
            exchangeId: `${turnId}:${toolLoops}`,
            conversationId: thread.conversationId,
            messages: messagesFor(thread),
            attachments,
          },
          operationScope.signal
        )
        activeExchange = exchange
        this.#activeExchanges.set(threadId, exchange)
        const leg = await consumeExchange(
          exchange,
          operationScope.signal,
          options.onProviderEvent
        )
        activeExchange = null
        if (this.#activeExchanges.get(threadId) === exchange) {
          this.#activeExchanges.delete(threadId)
        }
        if (leg.completion.status !== 'completed') {
          thread = this.#appendTurnItem(
            thread,
            turnId,
            {
              kind: 'error',
              message: leg.completion.message,
            },
            leg.completion.status === 'canceled' ? 'canceled' : 'failed'
          )
          return thread
        }
        if (leg.toolRequest === null) {
          thread = this.#appendTurnItem(
            thread,
            turnId,
            { kind: 'assistant', text: leg.completion.text },
            'completed'
          )
          await options.onTurnItem?.({
            kind: 'assistant',
            text: leg.completion.text,
          })
          return thread
        }
        toolLoops += 1
        if (toolLoops > maxToolLoops) {
          throw new ConversationHostError('Tool loop limit exceeded.')
        }
        const assistantItem: ConversationItem = {
          kind: 'assistant',
          text: leg.completion.text,
          toolCalls: [
            {
              toolCallId: leg.toolRequest.toolCallId,
              name: leg.toolRequest.name,
              input: leg.toolRequest.input,
            },
          ],
        }
        thread = this.#appendTurnItem(thread, turnId, assistantItem)
        await options.onTurnItem?.(assistantItem)
        const toolRequestItem: ConversationItem = {
          kind: 'tool.request',
          toolCallId: leg.toolRequest.toolCallId,
          name: leg.toolRequest.name,
          input: leg.toolRequest.input,
        }
        thread = this.#appendTurnItem(thread, turnId, toolRequestItem)
        await options.onTurnItem?.(toolRequestItem)
        let result: ToolResult
        try {
          result = await this.#toolHost.execute(
            leg.toolRequest.name,
            leg.toolRequest.input,
            leg.toolRequest.toolCallId,
            {
              signal: operationScope.signal,
              availableCapabilities: binding.capabilities,
              ...(options.onToolProgress === undefined
                ? {}
                : { onProgress: options.onToolProgress }),
              ...(options.invocation === undefined
                ? {}
                : { invocation: options.invocation }),
            }
          )
        } catch (error) {
          if (operationScope.signal.aborted || isAbortError(error)) throw error
          const message = `Tool execution failed: ${getErrorMessage(error)}`
          result = Object.freeze({
            status: 'error',
            output: Object.freeze({ message }),
            displayText: message,
          })
        }
        const toolResultItem: ConversationItem = {
          kind: 'tool.result',
          toolCallId: leg.toolRequest.toolCallId,
          name: leg.toolRequest.name,
          result,
        }
        thread = this.#appendTurnItem(thread, turnId, toolResultItem)
        await options.onTurnItem?.(toolResultItem)
        attachments = extractAttachments(result)
        if (
          attachments.length > 0 &&
          !binding.capabilities.includes(PROVIDER_ATTACHMENT_CAPABILITY)
        ) {
          throw new ConversationHostError(
            `Provider ${binding.providerId} does not support attachments.`
          )
        }
      }
    } catch (error) {
      if (operationScope.signal.aborted) {
        thread = this.#appendTurnItem(
          thread,
          turnId,
          {
            kind: 'error',
            message: getErrorMessage(operationScope.signal.reason),
          },
          'canceled'
        )
        return thread
      }
      thread = this.#appendTurnItem(
        thread,
        turnId,
        { kind: 'error', message: getErrorMessage(error) },
        'failed'
      )
      return thread
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      this.#busy.delete(threadId)
      this.#activeExchanges.delete(threadId)
      await settleConversationCleanup(threadId, operationScope, cancellation)
    }
  }

  #requireBinding(threadId: string): ProviderBinding {
    const binding = this.#bindings.get(threadId)
    if (binding === undefined) {
      throw new ConversationHostError(`Conversation is not open: ${threadId}`)
    }
    return binding
  }

  #appendTurnItem(
    thread: ConversationThread,
    turnId: string,
    item: ConversationItem,
    status: ConversationTurn['status'] = 'running'
  ): ConversationThread {
    return this.#store.commit(thread.id, thread.revision, (state) => ({
      ...state,
      turns: state.turns.map((turn) =>
        turn.id !== turnId
          ? turn
          : { ...turn, status, items: [...turn.items, item] }
      ),
    }))
  }
}

async function settleConversationCleanup(
  threadId: string,
  operationScope: ResourceScope,
  cancellation: Promise<void> | null
): Promise<void> {
  const tasks: Promise<void>[] = [
    operationScope.dispose({ reason: 'conversation-complete' }),
  ]
  if (cancellation !== null) tasks.push(cancellation)
  const cleanup = await Promise.allSettled(tasks)
  const errors = cleanup.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : []
  )
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Conversation ${threadId} cancellation or cleanup failed.`
    )
  }
}

async function cancelConversationOperation(
  scope: ResourceScope,
  exchange: { cancel(reason?: unknown): void | Promise<void> } | null,
  reason: unknown
): Promise<void> {
  const outcomes = await Promise.allSettled([
    scope.dispose({ reason }),
    ...(exchange === null
      ? []
      : [Promise.resolve().then(async () => await exchange.cancel(reason))]),
  ])
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : []
  )
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Conversation cancellation failed.')
  }
}

async function consumeExchange(
  exchange: {
    readonly events: AsyncIterable<ProviderEvent>
    readonly completion: Promise<ProviderCompletion>
  },
  signal: AbortSignal,
  onEvent?: (event: ProviderEvent) => void | Promise<void>
): Promise<{
  readonly completion: ProviderCompletion
  readonly toolRequest: Extract<
    ProviderEvent,
    { readonly type: 'tool.request' }
  > | null
}> {
  let toolRequest: Extract<
    ProviderEvent,
    { readonly type: 'tool.request' }
  > | null = null
  const iterator = exchange.events[Symbol.asyncIterator]()
  let removeAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(toConversationError(signal.reason))
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', onAbort)
    }
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      const event = next.value
      await onEvent?.(event)
      if (event.type === 'tool.request') {
        if (toolRequest !== null)
          throw new ConversationHostError(
            'Provider emitted multiple Tool requests in one exchange.'
          )
        toolRequest = event
      }
    }
    return {
      completion: await Promise.race([exchange.completion, aborted]),
      toolRequest,
    }
  } finally {
    removeAbort()
    void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

function messagesFor(thread: ConversationThread): readonly ProviderMessage[] {
  const messages: ProviderMessage[] = []
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.kind === 'user')
        messages.push({ role: 'user', content: item.text })
      else if (item.kind === 'assistant')
        messages.push({
          role: 'assistant',
          content: item.text,
          ...(item.toolCalls === undefined
            ? {}
            : { toolCalls: item.toolCalls }),
        })
      else if (item.kind === 'tool.result') {
        messages.push({
          role: 'tool',
          toolCallId: item.toolCallId,
          toolName: item.name,
          content: JSON.stringify(item.result.output),
          toolResult: item.result,
        })
      }
    }
  }
  return Object.freeze(messages)
}

function freezeThread(thread: ConversationThread): ConversationThread {
  return Object.freeze({
    ...thread,
    turns: Object.freeze(
      thread.turns.map((turn) =>
        Object.freeze({ ...turn, items: Object.freeze([...turn.items]) })
      )
    ),
  })
}

function extractAttachments(result: ToolResult): readonly AttachmentRef[] {
  const attachment = result.output.attachment
  if (
    attachment === null ||
    typeof attachment !== 'object' ||
    Array.isArray(attachment)
  ) {
    return []
  }
  if (!isAttachmentRef(attachment)) return []
  return [
    Object.freeze({
      id: attachment.id,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    }),
  ]
}

function isAttachmentRef(value: unknown): value is AttachmentRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'id' in value &&
    typeof value.id === 'string' &&
    'mediaType' in value &&
    typeof value.mediaType === 'string' &&
    'sizeBytes' in value &&
    typeof value.sizeBytes === 'number' &&
    'sha256' in value &&
    typeof value.sha256 === 'string'
  )
}

function toConversationError(reason: unknown): ConversationHostError {
  return new ConversationHostError(
    reason instanceof Error && reason.message !== ''
      ? reason.message
      : 'Conversation exchange canceled.'
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
