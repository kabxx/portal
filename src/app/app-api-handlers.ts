import { randomUUID } from 'node:crypto'
import {
  ApiHttpError,
  type ApiEvent,
  type ApiHandlers,
  type PortalApiServer,
} from '../api/api-server.ts'
import {
  executeProviderCapability,
  isToggleCapabilityProvider,
  listProviderCapabilityStates,
} from '../cli-commands/commands/command-thread-capability.ts'
import type { McpLibrary } from '../mcp/mcp-library.ts'
import type { McpServerConfig } from '../mcp/mcp-config.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import {
  ProviderModelSelectionError,
  resolveProviderModel,
} from '../providers/provider-model-catalog.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import type { SkillLibrary } from '../skills/skill-library.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type {
  ProvisionResult,
  ThreadLifecycleService,
} from '../threads/thread-lifecycle-service.ts'
import type { ThreadManager } from '../threads/thread-manager.ts'
import {
  ThreadCloseTimeoutError,
  type ThreadOperationCoordinator,
  type ThreadOperationHandle,
} from '../threads/thread-operation-coordinator.ts'
import { buildThreadHistoryTitle } from '../threads/thread-store.ts'
import type { StopTarget } from './app-lifecycle.ts'
import { PROVIDERS, normalizeProviderId } from './app-provider-catalog.ts'
import { parseApiThreadCreationMode } from './app-runtime-settings.ts'

export interface ApiHandlerDependencies {
  threadManager: ThreadManager
  threadOperations: ThreadOperationCoordinator
  threadLifecycle: ThreadLifecycleService
  ui: TerminalController
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  isBrowserConnected: () => boolean
  isForegroundOperationActive: () => boolean
  getServerStatus: () => ReturnType<PortalApiServer['status']>
  getHookStatus: () => unknown
  publishEvent: (threadId: string, event: ApiEvent) => void
  withCancellableOperation: <T>(
    stopTarget: StopTarget | null,
    runOperation: (
      signal: AbortSignal,
      setStopTarget: (target: StopTarget | null) => void
    ) => Promise<T>
  ) => Promise<T>
}

export type ThreadReloadStartResult =
  | {
      accepted: true
      operationId: string
      operation: ThreadOperationHandle
    }
  | {
      accepted: false
      reason: 'not_found' | 'busy'
    }

export interface ApiHandlerBundle {
  handlers: ApiHandlers
  startThreadReload: (threadId: string) => ThreadReloadStartResult
}

export function createApiHandlers({
  threadManager,
  threadOperations,
  threadLifecycle,
  ui,
  skillLibrary,
  mcpLibrary,
  isBrowserConnected,
  isForegroundOperationActive,
  getServerStatus,
  getHookStatus,
  publishEvent,
  withCancellableOperation,
}: ApiHandlerDependencies): ApiHandlerBundle {
  const getThread = (threadId: string) => {
    const thread = threadManager.getThread(threadId)
    if (thread === null) {
      throw new ApiHttpError(
        404,
        'THREAD_NOT_FOUND',
        `Unknown thread: ${threadId}`
      )
    }
    return thread
  }

  const toThreadSummary = (threadId: string) => {
    const thread = getThread(threadId)
    return {
      id: thread.id,
      provider: thread.provider,
      title: thread.title,
      conversationUrl: thread.runtime.conversationUrl,
      busy: threadOperations.get(thread.id) !== null,
      active: threadManager.getActiveThread()?.id === thread.id,
      turnCount: thread.turnCount,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }
  }

  const publish = (
    threadId: string,
    type: ApiEvent['type'],
    data: Record<string, unknown> = {}
  ) => {
    publishEvent(threadId, { type, data })
  }

  const startThreadReload = (threadId: string): ThreadReloadStartResult => {
    const thread = threadManager.getThread(threadId)
    if (thread === null) {
      return { accepted: false, reason: 'not_found' }
    }

    const operationId = randomUUID()
    const startResult = threadLifecycle.startOperation(
      threadId,
      async ({ signal }) => {
        try {
          throwIfAborted(signal)
          publish(threadId, 'thread.action', {
            operationId,
            action: 'reload',
            phase: 'started',
          })
          await thread.runtime.restore({ signal })
          throwIfAborted(signal)
          ui.renderThreadInfo(
            thread,
            'thread reload',
            'Provider page reloaded.'
          )
          publish(threadId, 'thread.action', {
            operationId,
            action: 'reload',
            phase: 'completed',
          })
        } catch (error) {
          const cancelled = isAbortError(error)
          const message = error instanceof Error ? error.message : String(error)
          publish(threadId, 'thread.action', {
            operationId,
            action: 'reload',
            phase: cancelled ? 'cancelled' : 'failed',
            ...(cancelled ? {} : { message }),
          })
          if (!cancelled) {
            ui.renderThreadWarning(thread, 'thread reload', message)
          }
          throw error
        } finally {
          ui.setThreadBusy(threadId, false)
        }
      },
      null
    )

    if (!startResult.accepted) {
      return { accepted: false, reason: 'busy' }
    }
    ui.setThreadBusy(threadId, true)
    return {
      accepted: true,
      operationId,
      operation: startResult.operation,
    }
  }

  const startMessage = async (threadId: string, input: string) => {
    const thread = getThread(threadId)
    let lastAssistantStream = ''
    const startResult = threadLifecycle.startSend(
      threadId,
      input,
      async (signal) => {
        try {
          throwIfAborted(signal)
          publish(threadId, 'message.started', { input })
          const result = await threadManager.submitThreadInput(
            threadId,
            input,
            {
              signal,
              source: 'api',
              onAssistantStream: async (message) => {
                const delta = message.startsWith(lastAssistantStream)
                  ? message.slice(lastAssistantStream.length)
                  : message
                lastAssistantStream = message
                publish(threadId, 'assistant.delta', { text: delta })
                ui.renderAssistantStream(thread, message)
              },
              onAssistantStreamReset: async () => {
                lastAssistantStream = ''
                publish(threadId, 'assistant.reset', {})
              },
              onManualSkill: async (name) => {
                publish(threadId, 'status', {
                  message: `Using skill: ${name}`,
                })
                ui.renderThreadInfo(thread, 'skill', `Using skill: ${name}`)
              },
              onToolProgress: (event, toolCall, toolCallId, turn) => {
                publish(threadId, 'tool.output', {
                  tool: toolCall?.tool ?? 'unknown',
                  toolCallId,
                  turnId: turn.id,
                  event,
                })
              },
              onTurnItem: async (item) => {
                if (item.kind === 'assistant_text') {
                  lastAssistantStream = ''
                  publish(threadId, 'assistant.message', { text: item.text })
                  ui.renderAssistantMessage(thread, item.text)
                } else if (item.kind === 'tool_call') {
                  publish(threadId, 'tool.started', {
                    tool: item.toolName,
                    payload: item.rawPayload,
                    ...(item.toolCallId === undefined
                      ? {}
                      : { toolCallId: item.toolCallId }),
                  })
                  ui.renderToolCall(
                    thread,
                    item.toolName,
                    item.rawPayload,
                    item.toolCallId
                  )
                } else if (item.kind === 'tool_result') {
                  publish(threadId, 'tool.completed', {
                    tool: item.toolName,
                    outcome: item.outcome,
                    result: item.result,
                    ...(item.toolCallId === undefined
                      ? {}
                      : { toolCallId: item.toolCallId }),
                    ...(item.displayText === undefined
                      ? {}
                      : { displayText: item.displayText }),
                  })
                  ui.renderToolResult(
                    thread,
                    item.toolName,
                    item.outcome,
                    item.result,
                    item.displayText,
                    item.toolCallId
                  )
                } else if (item.kind === 'status') {
                  publish(threadId, 'status', { message: item.text })
                } else if (item.kind === 'error') {
                  ui.renderThreadError(thread, 'thread', item.text)
                }
              },
            }
          )
          await threadLifecycle.recordActivity({
            threadId: thread.id,
            provider: thread.provider,
            conversationUrl: thread.runtime.conversationUrl,
            title: buildThreadHistoryTitle(input),
          })
          publish(threadId, 'message.completed', {
            assistant: result?.assistant ?? '',
          })
        } catch (error) {
          if (isAbortError(error)) {
            publish(threadId, 'message.cancelled')
          } else {
            publish(threadId, 'message.failed', {
              message: error instanceof Error ? error.message : String(error),
            })
          }
          throw error
        } finally {
          ui.clearLiveCommand(thread)
          ui.setThreadBusy(thread.id, false)
        }
      }
    )

    if (!startResult.accepted) {
      throw new ApiHttpError(
        409,
        'THREAD_BUSY',
        `Thread ${threadId} already has an active operation.`
      )
    }
    ui.renderUserMessage(thread, input)
    ui.setThreadBusy(thread.id, true)
    void startResult.operation.done.catch(() => {})
    return {
      accepted: true,
      status: 'busy',
      threadId,
    }
  }

  const handlers: ApiHandlers = {
    status: () => ({
      browserConnected: isBrowserConnected(),
      activeThreadId: threadManager.getActiveThread()?.id ?? null,
      busy: threadOperations.list().length > 0,
      server: getServerStatus(),
      hooks: getHookStatus(),
    }),
    providers: () => [...PROVIDERS],
    listThreads: () =>
      threadManager.listThreads().map(({ id }) => toThreadSummary(id)),
    getThread: (threadId) => toThreadSummary(threadId),
    createThread: async (input) => {
      if (isForegroundOperationActive()) {
        throw new ApiHttpError(
          409,
          'OPERATION_BUSY',
          'Another foreground operation is already running.'
        )
      }
      const providerValue = input.provider
      if (typeof providerValue !== 'string') {
        throw new ApiHttpError(400, 'INVALID_REQUEST', 'provider is required.')
      }
      const provider = normalizeProviderId(providerValue)
      if (provider === null) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          `Unsupported provider: ${providerValue}`
        )
      }
      const model = input.model
      if (model !== undefined && model !== null && typeof model !== 'string') {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'model must be a string or null.'
        )
      }
      const option = input.option
      if (
        option !== undefined &&
        option !== null &&
        typeof option !== 'string'
      ) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'option must be a string or null.'
        )
      }
      let resolvedModel
      try {
        resolvedModel = resolveProviderModel(
          provider,
          model === undefined ? null : model,
          option === undefined ? null : option
        )
      } catch (error) {
        if (!(error instanceof ProviderModelSelectionError)) throw error
        throw new ApiHttpError(400, 'INVALID_REQUEST', error.message)
      }
      const mode = parseApiThreadCreationMode(input.mode)
      const created = await withCancellableOperation(
        null,
        async (signal, setStopTarget) => {
          void setStopTarget
          return requireProvisionResult(
            await threadLifecycle.create(
              {
                provider,
                model: resolvedModel,
                mode,
                source: 'api',
                activate: false,
              },
              signal
            ),
            'THREAD_CREATE_FAILED'
          )
        }
      )
      return toThreadSummary(created.threadId)
    },
    resumeThread: async (input) => {
      if (isForegroundOperationActive()) {
        throw new ApiHttpError(
          409,
          'OPERATION_BUSY',
          'Another foreground operation is already running.'
        )
      }
      const conversationUrl = input.conversationUrl
      if (
        typeof conversationUrl !== 'string' ||
        conversationUrl.trim() === ''
      ) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'conversationUrl is required.'
        )
      }
      const resolvedConversation = resolveConversationUrl(conversationUrl)
      if (resolvedConversation === null) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'conversationUrl is invalid or unsupported.'
        )
      }
      const resumed = await withCancellableOperation(
        null,
        async (signal, setStopTarget) => {
          void setStopTarget
          return requireProvisionResult(
            await threadLifecycle.resume(
              {
                conversationUrl: resolvedConversation.conversationUrl,
                source: 'api',
                activate: false,
              },
              signal
            ),
            'THREAD_RESUME_FAILED'
          )
        }
      )
      return toThreadSummary(resumed.threadId)
    },
    closeThread: async (threadId) => {
      getThread(threadId)
      ui.setThreadBusy(threadId, true)
      try {
        const closed = (await threadLifecycle.close(threadId, 'user')).closed
        if (!closed) {
          throw new ApiHttpError(
            404,
            'THREAD_NOT_FOUND',
            `Unknown thread: ${threadId}`
          )
        }
        return { closed: true, threadId }
      } catch (error) {
        if (error instanceof ThreadCloseTimeoutError) {
          throw new ApiHttpError(409, 'THREAD_CLOSE_TIMEOUT', error.message)
        }
        throw error
      } finally {
        if (threadOperations.get(threadId) === null) {
          ui.setThreadBusy(threadId, false)
        }
        if (threadManager.getThread(threadId) === null) {
          ui.removeThreadTimeline(threadId)
        }
      }
    },
    submitMessage: startMessage,
    reloadThread: async (threadId) => {
      const result = startThreadReload(threadId)
      if (!result.accepted) {
        if (result.reason === 'not_found') {
          throw new ApiHttpError(
            404,
            'THREAD_NOT_FOUND',
            `Unknown thread: ${threadId}`
          )
        }
        throw new ApiHttpError(
          409,
          'THREAD_BUSY',
          `Thread ${threadId} already has an active operation.`
        )
      }
      void result.operation.done.catch(() => {})
      return {
        accepted: true,
        status: 'busy',
        operationId: result.operationId,
        action: 'reload',
        threadId,
      }
    },
    cancelMessage: async (threadId) => {
      getThread(threadId)
      const running = threadOperations.get(threadId) !== null
      await threadLifecycle.cancel(threadId)
      return { cancelled: running, threadId }
    },
    activateSkill: async (threadId, name) => {
      const skills = await skillLibrary.list()
      const skill = skills.skills.find((item) => item.name === name)
      if (skill === undefined || !skill.enabled) {
        throw new ApiHttpError(
          404,
          'SKILL_NOT_AVAILABLE',
          `Skill is not enabled: ${name}`
        )
      }
      return await startMessage(threadId, `$${name}`)
    },
    listCapabilities: async (threadId) => {
      const thread = getThread(threadId)
      return {
        provider: thread.provider,
        capabilities: await listProviderCapabilityStates(
          thread.provider,
          thread.runtime
        ),
      }
    },
    setCapability: async (threadId, name, state) => {
      const thread = getThread(threadId)
      return await setApiProviderCapability(
        thread.provider,
        thread.runtime,
        name,
        state
      )
    },
    clearCapability: async (threadId, name) => {
      const thread = getThread(threadId)
      return await clearApiProviderCapability(
        thread.provider,
        thread.runtime,
        name
      )
    },
    listSkills: async () => await skillLibrary.list(),
    addSkill: async (input) => {
      if (typeof input.source !== 'string' || input.source.trim() === '') {
        throw new ApiHttpError(400, 'INVALID_REQUEST', 'source is required.')
      }
      const registryUrl = input.registryUrl
      if (registryUrl !== undefined && typeof registryUrl !== 'string') {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'registryUrl must be a string.'
        )
      }
      return await skillLibrary.add(
        input.source,
        registryUrl === undefined ? {} : { registryUrl }
      )
    },
    setSkillEnabled: async (name, enabled) => {
      const changed = enabled
        ? await skillLibrary.enable(name)
        : await skillLibrary.disable(name)
      if (!changed) {
        throw new ApiHttpError(404, 'SKILL_NOT_FOUND', `Unknown skill: ${name}`)
      }
      return { name, enabled }
    },
    removeSkill: async (name) => {
      const result = await skillLibrary.remove(name)
      if (!result.removed) {
        throw new ApiHttpError(404, 'SKILL_NOT_FOUND', `Unknown skill: ${name}`)
      }
      return { removed: true, name, warnings: result.warnings }
    },
    listMcpServers: async () => {
      const result = await mcpLibrary.list()
      return {
        issues: result.issues,
        servers: result.servers.map(({ name, enabled, config }) => ({
          name,
          enabled,
          config: redactMcpConfig(config),
        })),
      }
    },
    addMcpServer: async (name, config) => {
      await mcpLibrary.add(name, config)
      return { name, added: true }
    },
    setMcpServer: async (name, config) => {
      await mcpLibrary.set(name, config)
      return { name, updated: true }
    },
    removeMcpServer: async (name) => {
      if (!(await mcpLibrary.remove(name))) {
        throw new ApiHttpError(
          404,
          'MCP_NOT_FOUND',
          `Unknown MCP server: ${name}`
        )
      }
      return { removed: true, name }
    },
    setMcpServerEnabled: async (name, enabled) => {
      const changed = enabled
        ? await mcpLibrary.enable(name)
        : await mcpLibrary.disable(name)
      if (!changed) {
        throw new ApiHttpError(
          404,
          'MCP_NOT_FOUND',
          `Unknown MCP server: ${name}`
        )
      }
      return { name, enabled }
    },
    listMcpResources: async (threadId, server) => {
      const session = getThread(threadId).runtime.getMcpSession()
      if (session === null) {
        return { items: [], issues: [] }
      }
      return await session.listResources(server)
    },
    listMcpPrompts: async (threadId, server) => {
      const session = getThread(threadId).runtime.getMcpSession()
      if (session === null) {
        return { items: [], issues: [] }
      }
      return await session.listPrompts(server)
    },
  }

  return { handlers, startThreadReload }
}

export async function setApiProviderCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string,
  state: string
): Promise<{ name: string; state: string }> {
  const isToggleProvider = isToggleCapabilityProvider(provider)
  if (isToggleProvider && state !== 'on' && state !== 'off') {
    throw new ApiHttpError(
      400,
      'INVALID_REQUEST',
      'Toggle capability state must be on or off.'
    )
  }
  if (!isToggleProvider && state !== 'selected' && state !== 'on') {
    throw new ApiHttpError(
      400,
      'INVALID_REQUEST',
      'Action capability state must be selected or on.'
    )
  }
  const execution = await executeProviderCapability(
    provider,
    runtime,
    name,
    isToggleProvider ? [state] : []
  )
  if (execution.status !== 'ok') {
    throw new ApiHttpError(400, 'CAPABILITY_ERROR', execution.result.body)
  }
  return { name, state: execution.result.body }
}

export async function clearApiProviderCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string
): Promise<{ name: string; cleared: true }> {
  const isToggleProvider = isToggleCapabilityProvider(provider)
  const execution = await executeProviderCapability(
    provider,
    runtime,
    isToggleProvider ? name : 'none',
    isToggleProvider ? ['off'] : []
  )
  if (execution.status !== 'ok') {
    throw new ApiHttpError(400, 'CAPABILITY_ERROR', execution.result.body)
  }
  return { name, cleared: true }
}

function requireProvisionResult(
  result: ProvisionResult,
  failureCode: string
): Extract<ProvisionResult, { ok: true }> {
  if (result.ok) return result
  throw new ApiHttpError(502, failureCode, result.failure.message)
}

function redactMcpConfig(config: McpServerConfig): Record<string, unknown> {
  const record = config as McpServerConfig & {
    headers?: Record<string, string>
    env?: Record<string, string>
  }
  const { headers, env, ...safe } = record
  return {
    ...safe,
    ...(headers === undefined ? {} : { hasHeaders: true }),
    ...(env === undefined ? {} : { hasEnv: true }),
  }
}
