import { abortable, throwIfAborted } from '../runtime/runtime-cancellation.ts'
import {
  normalizeProviderId,
  PROVIDERS,
} from '../providers/provider-catalog.ts'
import {
  listProviderModelOptions,
  listProviderModels,
  resolveProviderModel,
  ProviderModelSelectionError,
} from '../providers/provider-model-catalog.ts'
import {
  parseThreadHistoryId,
  parseThreadHistoryLimit,
} from '../threads/thread-store.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import type { PortalHostStartedServices } from './portal-host.ts'
import type { TerminalController } from '../terminal-ui/terminal-controller.ts'
import type { KeybindingCatalog } from '../keybindings/keybinding-catalog.ts'
import type { PortalMcpServer } from '../mcp-server/mcp-server.ts'
import type { ThreadOperationHandle } from '../threads/thread-operation-coordinator.ts'
import type {
  CommandCompletionSnapshot,
  CommandCompletionCandidate,
} from '../cli-commands/core/command-contracts.ts'
import type {
  CommandCatalogService,
  CommandJobService,
  CommandKeybindingService,
  CommandMcpService,
  CommandOutputMessage,
  CommandOutputService,
  CommandProviderService,
  CommandSkillService,
  CommandThreadService,
  CommandServiceBundle,
} from '../cli-commands/core/command-services.ts'
import {
  executePortalCommandCapability,
  listPortalCommandCapabilities,
} from './portal-command-capabilities.ts'

export interface PortalCommandServiceOptions {
  readonly started: PortalHostStartedServices
  readonly ui: TerminalController
  readonly keybindings: KeybindingCatalog
  readonly mcp: PortalMcpServer
}

const commandCompletionSnapshot = createCommandCompletionSnapshot()

export function portalCommandCompletionSnapshot(): CommandCompletionSnapshot {
  return commandCompletionSnapshot
}

export function createPortalCommandServices(
  options: PortalCommandServiceOptions,
  catalog: CommandCatalogService
): CommandServiceBundle {
  const { started, ui, keybindings, mcp } = options
  const output: CommandOutputService = {
    write(message: CommandOutputMessage): void {
      const body = message.body
      const format = message.format ?? 'plain'
      if (message.threadId !== undefined) {
        const thread = started.threadManager.getThread(message.threadId)
        if (thread !== null) {
          if (message.level === 'warning') {
            ui.renderThreadWarning(thread, message.title, body, format)
          } else if (message.level === 'error') {
            ui.renderThreadError(thread, message.title, body, format)
          } else {
            ui.renderThreadInfo(thread, message.title, body, format)
          }
          return
        }
      }
      if (message.level === 'info') ui.renderInfo(message.title, body, format)
      else if (message.level === 'success')
        ui.renderSuccess(message.title, body, format)
      else if (message.level === 'warning')
        ui.renderWarning(message.title, body, format)
      else ui.renderError(message.title, body, format)
    },
    navigate(event): void {
      if (event.kind === 'show-home') ui.showHomeTimeline()
      else if (event.kind === 'show-thread')
        ui.showThreadTimeline(event.threadId)
      else ui.removeThreadTimeline(event.threadId)
    },
  }

  const threads: CommandThreadService = {
    async create(input) {
      throwIfAborted(input.signal)
      const provider = normalizeProviderId(input.provider)
      if (provider === null)
        return { ok: false, message: `Unknown provider: ${input.provider}` }
      let model
      try {
        model = resolveProviderModel(provider, input.modelKey, input.optionKey)
      } catch (error) {
        if (error instanceof ProviderModelSelectionError) {
          return { ok: false, message: error.message }
        }
        throw error
      }
      const result = await abortable(
        started.lifecycle.create(
          {
            provider,
            model,
            mode: input.mode,
            source: 'tui',
            activate: true,
          },
          input.signal
        ),
        input.signal
      )
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.failure.message }
    },
    list() {
      const active = started.threadManager.getActiveThread()?.id ?? null
      return started.threadManager.listThreads().map((thread) => ({
        id: thread.id,
        provider: thread.provider,
        title: thread.title,
        turnCount: thread.turnCount,
        conversationUrl: thread.runtime.conversationUrl,
        active: thread.id === active,
      }))
    },
    async history(limitInput, signal) {
      const parsed = parseThreadHistoryLimit(limitInput ?? undefined)
      if (parsed.error !== null || parsed.limit === null) {
        return { ok: false, message: parsed.error ?? 'Invalid history limit.' }
      }
      const entries = await abortable(
        started.threadStore.list(parsed.limit),
        signal
      )
      return {
        ok: true,
        entries: entries.map((entry) => ({ ...entry })),
      }
    },
    async resume(target, signal) {
      const historyId = parseThreadHistoryId(target)
      if (target.startsWith('#') && historyId === null) {
        return {
          ok: false,
          message: `Invalid history id: ${target}. Expected #<positive-integer>.`,
        }
      }
      const historyEntry =
        historyId === null
          ? null
          : await abortable(started.threadStore.getById(historyId), signal)
      if (historyId !== null && historyEntry === null) {
        return { ok: false, message: `History entry not found: #${historyId}` }
      }
      const resolved = resolveConversationUrl(
        historyEntry?.conversationUrl ?? target
      )
      if (resolved === null) {
        return {
          ok: false,
          message: `Unsupported conversation URL: ${historyEntry?.conversationUrl ?? target}`,
        }
      }
      const duplicate = started.threadManager
        .listThreads()
        .some(
          (thread) =>
            thread.runtime.conversationUrl === resolved.conversationUrl
        )
      if (duplicate) {
        return {
          ok: false,
          message: `Conversation already exists. Use /thread switch to select it.`,
        }
      }
      const result = await abortable(
        started.lifecycle.resume(
          {
            conversationUrl: resolved.conversationUrl,
            source: 'tui',
            activate: true,
          },
          signal
        ),
        signal
      )
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.failure.message }
    },
    async reloadActive(signal) {
      const thread = started.threadManager.getActiveThread()
      if (thread === null) return { ok: false, message: 'No active thread.' }
      const startResult = started.lifecycle.startOperation(
        thread.id,
        async ({ signal: operationSignal }) => {
          await thread.runtime.restore({ signal: operationSignal })
        },
        null
      )
      if (!startResult.accepted) {
        return {
          ok: false,
          message:
            startResult.reason === 'not_found'
              ? `Unknown thread: ${thread.id}`
              : startResult.reason === 'closing'
                ? `Thread ${thread.id} is closing.`
                : `Thread ${thread.id} already has an active operation.`,
          threadId: thread.id,
        }
      }
      ui.setThreadBusy(thread.id, true)
      clearThreadBusyOnSettlement(ui, thread.id, startResult.operation)
      try {
        await waitForThreadOperation(startResult.operation, signal)
        return { ok: true }
      } catch (error) {
        throwIfAborted(signal)
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          threadId: thread.id,
        }
      }
    },
    switchTo(threadId) {
      return started.threadManager.switchThread(threadId) !== null
    },
    status() {
      const active = started.threadManager.getActiveThread()
      if (active === null) return null
      return {
        id: active.id,
        provider: active.provider,
        title: active.title,
        turnCount: active.turnCount,
        conversationUrl: active.runtime.conversationUrl,
        active: true,
      }
    },
    async close(threadId, signal) {
      const active = started.threadManager.getActiveThread()?.id ?? null
      const target = threadId ?? active
      if (target === null) return { ok: false, message: 'No active thread.' }
      if (started.threadManager.getThread(target) === null)
        return { ok: false, message: `Unknown thread: ${target}` }
      try {
        const result = await abortable(
          started.lifecycle.close(target, 'user'),
          signal
        )
        return {
          ok: true,
          threadId: target,
          wasActive: active === target && result.closed,
        }
      } catch (error) {
        throwIfAborted(signal)
        const removed = started.threadManager.getThread(target) === null
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          ...(removed ? { removedThreadId: target } : {}),
        }
      }
    },
    detach() {
      const active = started.threadManager.getActiveThread()?.id ?? null
      if (active !== null) started.threadManager.deactivateThread()
      return active
    },
    async listCapabilities(signal) {
      const active = started.threadManager.getActiveThread()
      if (active === null)
        return {
          ok: false,
          message: 'No active thread. Use /thread agent <provider> first.',
        }
      return {
        ok: true,
        ...(await listPortalCommandCapabilities(
          active.provider,
          active.runtime,
          signal
        )),
      }
    },
    async executeCapability(name, args, signal) {
      const active = started.threadManager.getActiveThread()
      if (active === null)
        return {
          status: 'no-active-thread',
          title: '/thread capability',
          body: 'No active thread. Use /thread agent <provider> first.',
          format: 'plain',
        }
      return await executePortalCommandCapability(
        active.provider,
        active.runtime,
        name,
        args,
        signal
      )
    },
  }

  const providers: CommandProviderService = {
    list: () => [...PROVIDERS],
    resolve: (value) => normalizeProviderId(value),
    completionSnapshot: () => commandCompletionSnapshot,
  }

  const skills: CommandSkillService = {
    add: async (source, input) =>
      await abortable(
        started.skillLibrary.add(source, {
          ...(input.registryUrl === undefined
            ? {}
            : { registryUrl: input.registryUrl }),
          signal: input.signal,
        }),
        input.signal
      ),
    list: async (signal) =>
      await abortable(started.skillLibrary.list(), signal),
    enable: async (name, signal) =>
      await abortable(started.skillLibrary.enable(name), signal),
    disable: async (name, signal) =>
      await abortable(started.skillLibrary.disable(name), signal),
    remove: async (name, signal) =>
      await abortable(started.skillLibrary.remove(name), signal),
  }

  const mcpService: CommandMcpService = {
    start: async (signal) => {
      throwIfAborted(signal)
      await abortable(mcp.start(), signal)
    },
    stop: async (signal) => {
      throwIfAborted(signal)
      await abortable(mcp.stop(), signal)
    },
    status: () => mcp.status(),
  }
  const jobs: CommandJobService = {
    list: () => started.runCommandJobs.list().map((job) => ({ ...job })),
    stop: async (id, signal) => {
      const result = await abortable(started.runCommandJobs.stop(id), signal)
      return result === 'not_found' ? 'not-found' : result
    },
  }
  const keybindingService: CommandKeybindingService = {
    reset: async (signal) => {
      throwIfAborted(signal)
      await abortable(keybindings.reset(), signal)
    },
  }
  return Object.freeze({
    output,
    catalog,
    threads,
    providers,
    skills,
    mcp: mcpService,
    jobs,
    keybindings: keybindingService,
  })
}

function clearThreadBusyOnSettlement(
  ui: TerminalController,
  threadId: string,
  operation: ThreadOperationHandle
): void {
  const settled =
    operation.settled ??
    operation.done.then(
      () => undefined,
      () => undefined
    )
  void settled
    .then(
      () => ui.setThreadBusy(threadId, false),
      () => ui.setThreadBusy(threadId, false)
    )
    .catch(() => undefined)
}

async function waitForThreadOperation(
  operation: ThreadOperationHandle,
  signal: AbortSignal
): Promise<void> {
  let cancellation: Promise<boolean> | undefined
  const cancel = () => {
    cancellation ??= operation.cancel()
    void cancellation.catch(() => undefined)
  }
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  try {
    await abortable(operation.done, signal)
  } catch (error) {
    if (signal.aborted) {
      cancel()
      await cancellation?.catch(() => undefined)
    }
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

function createCommandCompletionSnapshot(): CommandCompletionSnapshot {
  const entries: CommandCompletionSnapshot['entries'][number][] = [
    Object.freeze({
      sourceId: 'portal.command.providers',
      dependencies: Object.freeze({}),
      candidates: Object.freeze(
        PROVIDERS.map((value): CommandCompletionCandidate =>
          Object.freeze({ value, description: value })
        )
      ),
    }),
  ]
  for (const provider of PROVIDERS) {
    const models = listProviderModels(provider)
    entries.push(
      Object.freeze({
        sourceId: 'portal.command.models',
        dependencies: Object.freeze({ provider }),
        candidates: Object.freeze(
          models.map((value) => Object.freeze({ value, description: value }))
        ),
      })
    )
    for (const modelKey of models) {
      entries.push(
        Object.freeze({
          sourceId: 'portal.command.model-options',
          dependencies: Object.freeze({ provider, 'model-key': modelKey }),
          candidates: Object.freeze(
            listProviderModelOptions(provider, modelKey).map((value) =>
              Object.freeze({ value, description: value })
            )
          ),
        })
      )
    }
  }
  return Object.freeze({ entries: Object.freeze(entries) })
}
