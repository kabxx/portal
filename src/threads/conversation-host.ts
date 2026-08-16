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
  readonly providerId: string
  readonly providerOwnerId: string
  readonly conversationId: string
  readonly selectionRevision: string
}

export interface ConversationSendOptions {
  readonly signal?: AbortSignal
  readonly attachments?: readonly AttachmentRef[]
  readonly maxToolLoops?: number
}

export class ConversationHost {
  readonly #providerHost: ProviderHost
  readonly #toolHost: ToolHost
  readonly #store: ConversationStore
  readonly #root: ResourceScope
  readonly #bindings = new Map<string, ProviderBinding>()
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
      options.selectionRevision
    )
    const id = `conversation-${randomUUID()}`
    try {
      const thread = this.#store.create({
        id,
        providerId: options.providerId,
        conversationId: options.conversationId,
      })
      this.#bindings.set(id, binding)
      return thread
    } catch (error) {
      await binding.close(error).catch(() => undefined)
      throw error
    }
  }

  public async close(threadId: string, reason?: unknown): Promise<void> {
    const binding = this.#bindings.get(threadId)
    this.#bindings.delete(threadId)
    await binding?.close(reason)
  }

  public get(threadId: string): ConversationThread | null {
    return this.#store.get(threadId)
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
    const cancel = () => {
      void operationScope.dispose({ reason: options.signal?.reason })
      void activeExchange?.cancel(options.signal?.reason)
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
        const leg = await consumeExchange(exchange, operationScope.signal)
        activeExchange = null
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
          return this.#appendTurnItem(
            thread,
            turnId,
            { kind: 'assistant', text: leg.completion.text },
            'completed'
          )
        }
        toolLoops += 1
        if (toolLoops > maxToolLoops) {
          throw new ConversationHostError('Tool loop limit exceeded.')
        }
        thread = this.#appendTurnItem(thread, turnId, {
          kind: 'assistant',
          text: leg.completion.text,
          toolCalls: [
            {
              toolCallId: leg.toolRequest.toolCallId,
              name: leg.toolRequest.name,
              input: leg.toolRequest.input,
            },
          ],
        })
        thread = this.#appendTurnItem(thread, turnId, {
          kind: 'tool.request',
          toolCallId: leg.toolRequest.toolCallId,
          name: leg.toolRequest.name,
          input: leg.toolRequest.input,
        })
        const result = await this.#toolHost.execute(
          leg.toolRequest.name,
          leg.toolRequest.input,
          leg.toolRequest.toolCallId,
          {
            signal: operationScope.signal,
            availableCapabilities: binding.capabilities,
          }
        )
        thread = this.#appendTurnItem(thread, turnId, {
          kind: 'tool.result',
          toolCallId: leg.toolRequest.toolCallId,
          name: leg.toolRequest.name,
          result,
        })
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
      await operationScope.dispose({ reason: 'conversation-complete' })
      this.#busy.delete(threadId)
    }
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

async function consumeExchange(
  exchange: {
    readonly events: AsyncIterable<ProviderEvent>
    readonly completion: Promise<ProviderCompletion>
  },
  signal: AbortSignal
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
  const completion = exchange.completion.then((value) => ({
    kind: 'completion' as const,
    value,
  }))
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(toConversationError(signal.reason))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(toConversationError(signal.reason)),
      {
        once: true,
      }
    )
  })
  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().then((result) => ({ kind: 'event' as const, result })),
        completion,
        aborted,
      ])
      if (next.kind === 'completion') {
        return { completion: next.value, toolRequest }
      }
      if (next.result.done) {
        return { completion: await exchange.completion, toolRequest }
      }
      const event = next.result.value
      if (event.type === 'tool.request') {
        if (toolRequest !== null)
          throw new ConversationHostError(
            'Provider emitted multiple Tool requests in one exchange.'
          )
        toolRequest = event
      }
    }
  } finally {
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
          content: JSON.stringify(item.result.output),
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
