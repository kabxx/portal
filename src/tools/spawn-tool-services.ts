import type { BrowserContext } from 'playwright'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
import type { RunCommandJobManager } from '../processes/run-command-job-manager.ts'
import type { ProviderAdapter } from '../providers/adapters/adapter-base.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import { createRuntimeFromAdapter } from '../runtime/runtime-factory.ts'
import type { SkillLibrary } from '../skills/skill-library.ts'
import type { SpawnTaskResult, ToolServices } from './core/tool-definition.ts'
import {
  createAdapterForProvider,
  normalizeProviderId,
} from '../providers/provider-catalog.ts'
import type { PortalRuntimeSettings } from '../runtime/runtime-settings.ts'

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
        settings,
        currentSpawnDepth: childSpawnDepth,
        workingDirectory,
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
  settings,
  currentSpawnDepth,
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
  settings: PortalRuntimeSettings
  currentSpawnDepth: number
  signal?: AbortSignal
  workingDirectory: string
}): Promise<SpawnTaskResult> {
  let adapter: ProviderAdapter | null = null
  let runtime: RuntimeCore | null = null
  try {
    throwIfAborted(signal)
    adapter = await createAdapterForProvider(context, provider, null, signal)
    runtime = await createRuntimeFromAdapter(adapter, {
      model,
      setupMode: 'full',
      skillLibrary,
      projectInstructions,
      advertiseSpawnTool: currentSpawnDepth < settings.spawnDepthLimit,
      workingDirectory,
      toolServices: createToolServices({
        context,
        provider,
        model,
        skillLibrary,
        projectInstructions,
        runCommandJobs,
        settings,
        currentSpawnDepth,
        workingDirectory,
      }),
      signal,
    })
    throwIfAborted(signal)
    const output = await runtime.submitUserInput(prompt, {
      ...(signal !== undefined ? { signal } : {}),
    })
    return {
      provider,
      conversationUrl: runtime.conversationUrl,
      output,
    }
  } finally {
    if (runtime !== null) {
      await runtime.close().catch(() => {})
    } else {
      await adapter?.close().catch(() => {})
    }
  }
}
