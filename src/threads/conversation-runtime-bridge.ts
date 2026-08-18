import type {
  ThreadRuntime,
  ThreadRuntimeHandlers,
  ThreadToolCallMetadata,
} from './thread-runtime.ts'
import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import type { ToolCall, ToolResult } from '../tools/core/tool-registry.ts'
import type { ConversationHost, ConversationItem } from './conversation-host.ts'

export interface ConversationRuntimeBridgeOptions {
  readonly host: ConversationHost
  readonly threadId: string
  readonly providerId: string
  readonly model: ResolvedProviderModel | null
  readonly workingDirectory: string
  readonly spawnDepth: number
}

export function createConversationRuntimeBridge(
  options: ConversationRuntimeBridgeOptions
): ThreadRuntime {
  const runtime: ThreadRuntime = {
    get conversationId() {
      return options.host.identity(options.threadId)?.conversationId ?? null
    },
    get conversationUrl() {
      return options.host.identity(options.threadId)?.conversationUrl ?? ''
    },
    preflightInitialInput: async (input, signal) =>
      await options.host.preflight(options.threadId, input, signal),
    onUnexpectedPageClose: (listener) =>
      options.host.onUnexpectedClose(options.threadId, listener),
    submitUserInput: async (input, handlers) =>
      await submitThroughConversation(options, input, handlers),
    restore: async (restoreOptions = {}) =>
      await options.host.restore(options.threadId, restoreOptions.signal),
    loadHistory: async (historyOptions = {}) =>
      await options.host.loadHistory(options.threadId, historyOptions.signal),
    stopGeneration: async () =>
      await options.host.stopGeneration(options.threadId),
    listProviderCapabilities: async (signal) =>
      await options.host.listCapabilities(options.threadId, signal),
    executeProviderCapability: async (name, args, signal) =>
      await options.host.executeCapability(
        options.threadId,
        name,
        args,
        signal
      ),
    close: async () =>
      await options.host.close(options.threadId, 'thread-runtime-close'),
  }
  return Object.freeze(runtime)
}

export function createConversationExchangeDelegate(options: {
  readonly host: ConversationHost
  readonly threadId: string
  readonly providerId: string
  readonly model: ResolvedProviderModel | null
  readonly workingDirectory: string
  readonly spawnDepth: number
}): (input: string, handlers: ThreadRuntimeHandlers) => Promise<string> {
  return async (input, handlers) =>
    await submitThroughConversation(options, input, handlers)
}

async function submitThroughConversation(
  options: ConversationRuntimeBridgeOptions,
  input: string,
  handlers: ThreadRuntimeHandlers = {}
): Promise<string> {
  const thread = await options.host.send(options.threadId, input, {
    ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
    ...(handlers.maxToolCalls === undefined
      ? {}
      : { maxToolLoops: handlers.maxToolCalls }),
    invocation: {
      providerId: options.providerId,
      model: options.model,
      spawnDepth: options.spawnDepth,
      workingDirectory: options.workingDirectory,
    },
    onProviderEvent: async (event) => {
      if (event.type === 'text.delta') {
        await handlers.onAssistantStream?.(event.text)
      } else if (event.type === 'text.reset') {
        await handlers.onAssistantStreamReset?.()
      } else if (event.type === 'status') {
        await handlers.onStatus?.(event.message)
      } else if (event.type === 'attention.request') {
        await handlers.onStatus?.(event.prompt)
      }
    },
    ...(handlers.onToolProgress === undefined
      ? {}
      : {
          onToolProgress: (event) =>
            handlers.onToolProgress?.(event, null, 'tool'),
        }),
  })
  const turn = thread.turns.at(-1)
  if (turn === undefined) throw new Error('Conversation produced no turn.')
  const toolCalls = new Map<string, ToolCall>()
  let finalText = ''
  for (const item of turn.items) {
    if (item.kind === 'assistant') {
      if (item.text !== '') await handlers.onAssistantText?.(item.text)
      finalText = item.text
      continue
    }
    if (item.kind === 'tool.request') {
      const call: ToolCall = { tool: item.name, params: item.input }
      toolCalls.set(item.toolCallId, call)
      await handlers.onToolCall?.(
        call,
        rawPayload(item),
        metadata(item.toolCallId, item.input)
      )
      continue
    }
    if (item.kind === 'tool.result') {
      const result: ToolResult = {
        outcome: item.result.status,
        result: item.result.output,
        ...(item.result.displayText === undefined
          ? {}
          : { displayText: item.result.displayText }),
      }
      const call = toolCalls.get(item.toolCallId)
      if (call === undefined) {
        throw new Error(
          `Tool result ${item.toolCallId} has no matching Tool request.`
        )
      }
      await handlers.onToolResult?.(
        result,
        call,
        metadata(item.toolCallId, call?.params ?? '')
      )
    }
  }
  if (turn.status === 'failed' || turn.status === 'canceled') {
    const failure = [...turn.items]
      .reverse()
      .find(
        (item): item is Extract<ConversationItem, { kind: 'error' }> =>
          item.kind === 'error'
      )
    throw new Error(failure?.message ?? `Conversation ${turn.status}.`)
  }
  return finalText
}

function rawPayload(
  item: Extract<ConversationItem, { kind: 'tool.request' }>
): string {
  return typeof item.input === 'string'
    ? item.input
    : JSON.stringify(item.input)
}

function metadata(
  toolCallId: string,
  input: Record<string, unknown> | string
): ThreadToolCallMetadata {
  return {
    toolCallId,
    originalInput: structuredClone(input),
    effectiveInput: structuredClone(input),
    rewrittenBy: Object.freeze([]),
  }
}
