import { randomUUID } from 'node:crypto'
import type { BrowserContext } from 'playwright'
import type { HookExecutionScope } from '../hooks/hook-types.ts'
import type { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
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

export function nextSpawnDepth(
  currentSpawnDepth: number,
  spawnDepthLimit: number
): number | null {
  return currentSpawnDepth >= spawnDepthLimit ? null : currentSpawnDepth + 1
}

export function createToolServices({
  context,
  provider,
  model,
  skillLibrary,
  projectInstructions,
  runCommandJobs,
  hookDispatcher,
  settings,
  currentSpawnDepth,
  workingDirectory,
}: {
  context: BrowserContext
  provider: ProviderId
  model: ResolvedProviderModel | null
  skillLibrary: SkillLibrary
  projectInstructions: ProjectInstructions
  runCommandJobs: RunCommandJobManager
  hookDispatcher: HookDispatcher
  settings: PortalRuntimeSettings
  currentSpawnDepth: number
  workingDirectory: string
}): ToolServices {
  return {
    runCommandJobs,
    spawnTask: async (
      { prompt, provider: requestedProvider },
      options = {}
    ) => {
      const childSpawnDepth = nextSpawnDepth(
        currentSpawnDepth,
        settings.spawnDepthLimit
      )
      if (childSpawnDepth === null) {
        return {
          kind: 'error',
          message: `SPAWN_DEPTH_LIMIT_REACHED: spawn depth ${currentSpawnDepth} reached the configured limit ${settings.spawnDepthLimit}`,
        }
      }
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
        projectInstructions,
        runCommandJobs,
        hookDispatcher,
        settings,
        currentSpawnDepth: childSpawnDepth,
        workingDirectory,
        ...(options.executionScope !== undefined
          ? {
              executionScope: {
                ...options.executionScope,
                source: 'spawn' as const,
                spawnDepth: childSpawnDepth,
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
  projectInstructions,
  runCommandJobs,
  hookDispatcher,
  settings,
  currentSpawnDepth,
  executionScope,
  signal,
  workingDirectory,
}: {
  context: BrowserContext
  provider: ProviderId
  model: ResolvedProviderModel | null
  prompt: string
  skillLibrary: SkillLibrary
  projectInstructions: ProjectInstructions
  runCommandJobs: RunCommandJobManager
  hookDispatcher: HookDispatcher
  settings: PortalRuntimeSettings
  currentSpawnDepth: number
  executionScope?: HookExecutionScope
  signal?: AbortSignal
  workingDirectory: string
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
      skillLibrary,
      projectInstructions,
      hookDispatcher,
      advertiseSpawnTool: currentSpawnDepth < settings.spawnDepthLimit,
      requestAttemptLimit: settings.requestAttemptLimit,
      workingDirectory,
      toolServices: createToolServices({
        context,
        provider,
        model,
        skillLibrary,
        projectInstructions,
        runCommandJobs,
        hookDispatcher,
        settings,
        currentSpawnDepth,
        workingDirectory,
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
