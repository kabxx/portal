import type { BrowserContext } from 'playwright'

import type { AttachmentReader } from '../attachments/attachment-contracts.ts'
import { portalBrowserSessionService } from '../platform/browser-session-service.ts'
import { retryAsync } from '../shared/retry.ts'
import { sleepWithAbortAsync } from '../shared/sleep.ts'
import {
  toolRuntimeService,
  type ToolRuntimeService,
} from '../tools/tool-runtime-service.ts'
import {
  formatToolResultMessage,
  isToolCallAtResponseEnd,
  ToolRegistry,
} from '../tools/core/tool-registry.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import { initializeRuntimeWithLoginWait } from '../runtime/runtime-initializer.ts'
import { createRuntimeFromAdapter } from '../runtime/runtime-factory.ts'
import {
  isProviderAdapterError,
  type ProviderAdapter,
} from './adapters/adapter-base.ts'
import { createFirstPartyWebProviderAdapter } from './first-party-web-provider-factory.ts'
import type { FirstPartyProviderId as ProviderId } from './first-party-provider-id.ts'
import {
  executeWebProviderCapability,
  listWebProviderCapabilities,
} from './web-provider-capabilities.ts'
import type {
  ProviderCompletion,
  ProviderEndpoint,
  ProviderEndpointContext,
  ProviderEndpointFactory,
  ProviderEvent,
  ProviderMessage,
  ProviderOutboundLeg,
  ProviderSessionControl,
} from './provider-exchange.ts'

export interface WebProviderEndpointOptions {
  readonly context: BrowserContext
  readonly tools: ToolRuntimeService
  readonly requestAttemptLimit?: number
  readonly browserProfileDir?: string
  readonly createAdapter?: typeof createFirstPartyWebProviderAdapter
  readonly createRuntime?: typeof createRuntimeFromAdapter
}

export function createWebProviderEndpointFactory(
  providerId: ProviderId,
  overrides: Pick<
    WebProviderEndpointOptions,
    'createAdapter' | 'createRuntime' | 'requestAttemptLimit'
  > = {}
): ProviderEndpointFactory {
  return async (context) => {
    const browser = (
      await context.services.get(portalBrowserSessionService)
    ).current()
    const tools = await context.services.get(toolRuntimeService)
    return await createWebProviderEndpoint(providerId, context, {
      context: browser.context,
      tools,
      browserProfileDir: browser.profileDirectory,
      ...overrides,
    })
  }
}

export async function createWebProviderEndpoint(
  providerId: ProviderId,
  context: Parameters<ProviderEndpointFactory>[0],
  options: WebProviderEndpointOptions
): Promise<ProviderEndpoint> {
  const attachmentReader: AttachmentReader = Object.freeze({
    read: context.readAttachment,
  })
  let loginAttentionSent = false
  const runtime = await initializeRuntimeWithLoginWait({
    provider: providerId,
    browserProfileDir: options.browserProfileDir ?? '(browser profile)',
    threadId: context.sessionKey ?? '(pending)',
    createAdapter: async () =>
      await (options.createAdapter?.(
        options.context,
        providerId,
        context.conversationUrl,
        context.signal
      ) ??
        createFirstPartyWebProviderAdapter(
          options.context,
          providerId,
          context.conversationUrl,
          context.signal
        )),
    createRuntime: async (adapter) =>
      await (options.createRuntime?.(adapter, {
        model: context.model,
        toolHost: options.tools,
        providerId,
        currentSpawnDepth: context.spawnDepth,
        workingDirectory: context.workingDirectory,
        textToolProtocol: adapter.textToolProtocol,
        attachmentReader,
        signal: context.signal,
        createAgentSession: async ({ tools, textToolProtocol }) =>
          await context.openAgentSession({ tools, textToolProtocol }),
      }) ??
        createRuntimeFromAdapter(adapter, {
          model: context.model,
          toolHost: options.tools,
          providerId,
          currentSpawnDepth: context.spawnDepth,
          workingDirectory: context.workingDirectory,
          textToolProtocol: adapter.textToolProtocol,
          attachmentReader,
          signal: context.signal,
          createAgentSession: async ({ tools, textToolProtocol }) =>
            await context.openAgentSession({ tools, textToolProtocol }),
        })),
    onWarning: async (plan) => {
      if (plan.requiresLogin || plan.requiresHumanInput) {
        loginAttentionSent = true
      }
      if (plan.requiresLogin || plan.requiresHumanInput) {
        await context.emit({
          type: 'attention.request',
          requestId: `${providerId}:${plan.requiresHumanInput ? 'challenge' : 'login'}`,
          kind: plan.requiresHumanInput ? 'human-input' : 'login',
          prompt: plan.lines.join('\n'),
        })
      } else {
        await context.emit({
          type: 'status',
          message: plan.lines.join('\n'),
        })
      }
    },
    onLoginWait: async (_provider, kind = 'login') => {
      if (kind === 'human-input') return
      if (loginAttentionSent) return
      loginAttentionSent = true
      await context.emit({
        type: 'attention.request',
        requestId: `${providerId}:login`,
        kind: 'login',
        prompt: `Complete login for ${providerId} in the browser profile, then Portal will retry.`,
      })
    },
    waitForLogin: async () => await sleepWithAbortAsync(1000, context.signal),
    signal: context.signal,
    maxRetryAttempts: options.requestAttemptLimit ?? 3,
  })
  if (runtime === null) {
    throw new Error(`Could not initialize ${providerId} Provider runtime.`)
  }
  const adapter = runtime.getAdapter()
  const tools = new ToolRegistry(adapter, {
    toolHost: options.tools,
    protocol: adapter.textToolProtocol,
    invocation: {
      providerId,
      model: context.model,
      spawnDepth: context.spawnDepth,
      workingDirectory: context.workingDirectory,
    },
  })
  const session: ProviderSessionControl = {
    preflightInput: async (input, signal) =>
      await runtime.preflightInitialInput(input, signal),
    restore: async (signal) => await runtime.restore({ signal }),
    loadHistory: async (signal) => await runtime.loadHistory({ signal }),
    onUnexpectedClose: (listener) => adapter.onUnexpectedPageClose(listener),
    listCapabilities: async (signal) =>
      await listWebProviderCapabilities(providerId, runtime, signal),
    executeCapability: async (name, args, signal) =>
      await executeWebProviderCapability(
        providerId,
        runtime,
        name,
        args,
        signal
      ),
  }
  Object.freeze(session)
  const invoke: ProviderEndpoint = async (
    input: ProviderOutboundLeg,
    exchangeContext: ProviderEndpointContext
  ) => {
    const events = new ProviderEventQueue()
    const submission = submitLeg({
      input,
      context: exchangeContext,
      adapter,
      tools,
      requestAttemptLimit: options.requestAttemptLimit ?? 3,
      prepareText: async (text, signal) =>
        await runtime.prepareExchangeInput(text, signal),
      onEvent: (event) => events.push(event),
    })
    void submission.then(
      () => events.close(),
      () => events.close()
    )
    const completion = submission.then<ProviderCompletion, ProviderCompletion>(
      ({ text }) => ({
        status: 'completed',
        text,
        delivery: 'sent',
      }),
      (error: unknown) =>
        exchangeContext.signal.aborted || isAbortError(error)
          ? {
              status: 'canceled',
              message: getErrorMessage(exchangeContext.signal.reason ?? error),
              delivery: 'unknown',
            }
          : {
              status: 'failed',
              message: getErrorMessage(error),
              delivery: 'unknown',
            }
    )
    return Object.freeze({
      events,
      completion,
      cancel: async () => await adapter.stopGeneration(),
    })
  }
  const endpoint: ProviderEndpoint = Object.assign(invoke, {
    session,
    close: async () => await runtime.close(),
  })
  Object.defineProperties(endpoint, {
    conversationId: {
      enumerable: true,
      get: () => runtime.conversationId,
    },
    conversationUrl: {
      enumerable: true,
      get: () => runtime.conversationUrl,
    },
  })
  return endpoint
}

async function submitLeg(options: {
  readonly input: ProviderOutboundLeg
  readonly context: ProviderEndpointContext
  readonly adapter: ProviderAdapter
  readonly tools: ToolRegistry
  readonly requestAttemptLimit: number
  readonly prepareText: (text: string, signal: AbortSignal) => Promise<string>
  readonly onEvent: (event: ProviderEvent) => void
}): Promise<{
  readonly text: string
  readonly toolRequest: {
    readonly toolCallId: string
    readonly name: string
    readonly input: Record<string, unknown> | string
  } | null
}> {
  const message = options.input.messages.at(-1)
  if (message === undefined) throw new Error('Provider leg has no message.')
  for (const attachment of options.input.attachments) {
    throwIfAborted(options.context.signal)
    await options.adapter.attachAttachment(attachment, {
      read: options.context.readAttachment,
    })
  }
  const payload = await options.prepareText(
    formatOutboundMessage(message, options),
    options.context.signal
  )
  let lastStreamedText: string | null = null
  const response = await submitWithRetry(
    options.adapter,
    payload,
    options.context.signal,
    options.requestAttemptLimit,
    {
      onText: (snapshot) => {
        const projected = options.tools.projectStreamingAssistantText(snapshot)
        if (projected === lastStreamedText) return
        lastStreamedText = projected
        options.onEvent({ type: 'text.delta', text: projected })
      },
      onStatus: (message) => options.onEvent({ type: 'status', message }),
      onReset: () => {
        lastStreamedText = null
        options.onEvent({ type: 'text.reset' })
      },
    }
  )
  const result = await decodeWebProviderResponse(
    response,
    options.input.exchangeId,
    options.tools
  )
  if (result.text !== '' && result.text !== lastStreamedText) {
    options.onEvent({ type: 'text.delta', text: result.text })
  }
  if (result.toolRequest !== null) {
    options.onEvent({ type: 'tool.request', ...result.toolRequest })
  }
  return result
}

export async function decodeWebProviderResponse(
  response: string,
  exchangeId: string,
  tools: ToolRegistry
): Promise<{
  readonly text: string
  readonly toolRequest: {
    readonly toolCallId: string
    readonly name: string
    readonly input: Record<string, unknown> | string
  } | null
}> {
  if (tools.protocol === null) {
    return Object.freeze({ text: response, toolRequest: null })
  }
  const extracted = await tools.extractToolCall(response)
  if (extracted === null || !isToolCallAtResponseEnd(extracted)) {
    return Object.freeze({ text: response, toolRequest: null })
  }
  const parsed = tools.parseToolCallPayload(
    extracted.rawPayload,
    extracted.declaredToolName
  )
  if (parsed === null) {
    throw new Error(
      `Provider returned an invalid ${tools.protocol.displayName} payload.`
    )
  }
  return Object.freeze({
    text: extracted.leadingText.trim(),
    toolRequest: Object.freeze({
      toolCallId: `${exchangeId}:tool`,
      name: parsed.tool,
      input: parsed.params,
    }),
  })
}

function formatOutboundMessage(
  message: ProviderMessage,
  options: { readonly tools: ToolRegistry }
): string {
  if (
    message.role !== 'tool' ||
    message.toolName === undefined ||
    message.toolResult === undefined
  ) {
    return message.content
  }
  if (options.tools.protocol === null) return message.content
  return formatToolResultMessage(
    message.toolName,
    {
      outcome: message.toolResult.status,
      result: message.toolResult.output,
      ...(message.toolResult.displayText === undefined
        ? {}
        : { displayText: message.toolResult.displayText }),
    },
    undefined,
    options.tools.protocol
  )
}

async function submitWithRetry(
  adapter: ProviderAdapter,
  payload: string,
  signal: AbortSignal,
  maxAttempts: number,
  callbacks: {
    readonly onText: (message: string) => void | Promise<void>
    readonly onStatus: (message: string) => void | Promise<void>
    readonly onReset: () => void | Promise<void>
  }
): Promise<string> {
  let attemptGeneration = 0
  let streamedInAttempt = false
  return await retryAsync(
    async () => {
      throwIfAborted(signal)
      const generation = ++attemptGeneration
      streamedInAttempt = false
      adapter.setSubmitTextReporter(async (message) => {
        if (generation !== attemptGeneration) return
        streamedInAttempt = true
        await callbacks.onText(message)
      })
      adapter.setSubmitStatusReporter(async (message) => {
        if (generation !== attemptGeneration) return
        await callbacks.onStatus(message)
      })
      try {
        await adapter.attachText(payload)
        throwIfAborted(signal)
        return await adapter.submitWithResponseTimeout({ signal })
      } finally {
        if (generation === attemptGeneration) {
          attemptGeneration += 1
          adapter.setSubmitTextReporter(null)
          adapter.setSubmitStatusReporter(null)
        }
      }
    },
    {
      maxAttempts,
      retryIf: async (error, attempt) =>
        !isAbortError(error) &&
        isProviderAdapterError(error) &&
        error.retryable &&
        attempt + 1 < error.maxAttempts,
      onRetry: async (error) => {
        throwIfAborted(signal)
        if (streamedInAttempt) await callbacks.onReset()
        if (isProviderAdapterError(error) && error.recovery === 'restore') {
          await adapter.restore({ signal })
        }
      },
    }
  )
}

class ProviderEventQueue implements AsyncIterable<ProviderEvent> {
  readonly #events: ProviderEvent[] = []
  readonly #waiters: ((result: IteratorResult<ProviderEvent>) => void)[] = []
  #closed = false

  public push(event: ProviderEvent): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#events.push(event)
    else waiter({ done: false, value: event })
  }

  public close(): void {
    if (this.#closed) return
    this.#closed = true
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ done: true, value: undefined })
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: async () => {
        const event = this.#events.shift()
        if (event !== undefined) return { done: false, value: event }
        if (this.#closed) return { done: true, value: undefined }
        return await new Promise<IteratorResult<ProviderEvent>>((resolve) => {
          this.#waiters.push(resolve)
        })
      },
      return: async () => {
        this.close()
        return { done: true, value: undefined }
      },
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
