import { randomUUID } from 'node:crypto'
import type { BrowserContext } from 'playwright'
import type { HookExecutionScope } from '../hooks/hook-types.ts'
import type { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
import type { McpLibrary } from '../mcp/mcp-library.ts'
import type { RunCommandJobManager } from '../processes/run-command-job-manager.ts'
import type { ProviderAdapter } from '../providers/adapters/adapter-base.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import {
  isAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import { createRuntimeFromAdapter } from '../runtime/runtime-factory.ts'
import type { SkillLibrary } from '../skills/skill-library.ts'
import type {
  SpawnTaskResult,
  ToolServices,
} from '../tools/core/tool-definition.ts'
import {
  createAdapterForProvider,
  getProviderPrompt,
  normalizeProviderId,
} from './app-provider-catalog.ts'
import type { PortalRuntimeSettings } from './app-runtime-settings.ts'

export function inheritSpawnModelSelection(
  parentProvider: ProviderId,
  spawnProvider: ProviderId,
  model: ResolvedProviderModel | null
): ResolvedProviderModel | null {
  return spawnProvider === parentProvider ? model : null
}

export function createToolServices({
  context,
  provider,
  model,
  skillLibrary,
  mcpLibrary,
  projectInstructions,
  runCommandJobs,
  hookDispatcher,
  settings,
}: {
  context: BrowserContext
  provider: ProviderId
  model: ResolvedProviderModel | null
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  projectInstructions: ProjectInstructions
  runCommandJobs: RunCommandJobManager
  hookDispatcher: HookDispatcher
  settings: PortalRuntimeSettings
}): ToolServices {
  return {
    runCommandJobs,
    spawnTask: async (
      { prompt, provider: requestedProvider },
      options = {}
    ) => {
      const spawnProvider =
        requestedProvider === undefined
          ? provider
          : normalizeProviderId(requestedProvider)
      if (spawnProvider === null) {
        return {
          kind: 'error',
          message: `Unsupported spawn provider: ${requestedProvider}`,
        }
      }
      const spawnOptions = {
        context,
        provider: spawnProvider,
        model: inheritSpawnModelSelection(provider, spawnProvider, model),
        prompt,
        skillLibrary,
        mcpLibrary,
        projectInstructions: projectInstructions.fork(),
        runCommandJobs,
        hookDispatcher,
        settings,
        ...(options.executionScope !== undefined
          ? {
              executionScope: {
                ...options.executionScope,
                source: 'spawn' as const,
                spawnDepth: options.executionScope.spawnDepth + 1,
                ...(options.executionScope.threadId === undefined
                  ? {}
                  : { parentThreadId: options.executionScope.threadId }),
                ...(options.executionScope.turnId === undefined
                  ? {}
                  : { parentTurnId: options.executionScope.turnId }),
                ...(options.toolCallId === undefined
                  ? {}
                  : { parentToolCallId: options.toolCallId }),
              },
            }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }
      return await runSpawnTask(spawnOptions)
    },
  }
}

async function runSpawnTask({
  context,
  provider,
  model,
  prompt,
  skillLibrary,
  mcpLibrary,
  projectInstructions,
  runCommandJobs,
  hookDispatcher,
  settings,
  executionScope,
  signal,
}: {
  context: BrowserContext
  provider: ProviderId
  model: ResolvedProviderModel | null
  prompt: string
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  projectInstructions: ProjectInstructions
  runCommandJobs: RunCommandJobManager
  hookDispatcher: HookDispatcher
  settings: PortalRuntimeSettings
  executionScope?: HookExecutionScope
  signal?: AbortSignal
}): Promise<SpawnTaskResult> {
  let adapter: ProviderAdapter | null = null
  let runtime: RuntimeCore | null = null
  const spawnId = randomUUID()
  try {
    throwIfAborted(signal)
    if (executionScope !== undefined) {
      await hookDispatcher.dispatch(
        hookDispatcher.createEvent(
          'spawn.started',
          executionScope,
          { prompt },
          { spawnId }
        ),
        executionScope,
        signal
      )
    }
    adapter = await createAdapterForProvider(
      context,
      provider,
      null,
      signal,
      settings.providerTimings
    )
    runtime = await createRuntimeFromAdapter(adapter, {
      model,
      setupMode: 'full',
      providerPrompt: getProviderPrompt(provider),
      skillLibrary,
      mcpLibrary,
      projectInstructions,
      hookDispatcher,
      requestAttemptLimit: settings.requestAttemptLimit,
      toolServices: createToolServices({
        context,
        provider,
        model,
        skillLibrary,
        mcpLibrary,
        projectInstructions,
        runCommandJobs,
        hookDispatcher,
        settings,
      }),
      signal,
    })
    throwIfAborted(signal)
    const output = await runtime.submitUserInput(prompt, {
      ...(signal !== undefined ? { signal } : {}),
      ...(executionScope === undefined ? {} : { executionScope }),
    })
    if (executionScope !== undefined) {
      await hookDispatcher.dispatch(
        hookDispatcher.createEvent(
          'spawn.completed',
          executionScope,
          { output },
          { spawnId }
        ),
        executionScope
      )
    }
    return {
      provider,
      conversationUrl: runtime.conversationUrl,
      output,
    }
  } catch (error) {
    if (executionScope !== undefined) {
      await hookDispatcher.dispatch(
        hookDispatcher.createEvent(
          isAbortError(error) ? 'spawn.cancelled' : 'spawn.failed',
          executionScope,
          { message: error instanceof Error ? error.message : String(error) },
          { spawnId }
        ),
        executionScope
      )
    }
    throw error
  } finally {
    if (runtime !== null) {
      await runtime.close().catch(() => {})
    } else {
      await adapter?.close().catch(() => {})
    }
  }
}
