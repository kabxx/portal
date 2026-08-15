import type {
  ProviderAdapter,
  ProviderAdapterOptions,
} from '../providers/adapters/adapter-base.ts'
import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import type { ToolServices } from '../tools/core/tool-definition.ts'
import { ToolRegistry } from '../tools/core/tool-registry.ts'
import { AttachImageTool } from '../tools/builtins/attach-image-tool.ts'
import { ApplyPatchTool } from '../tools/builtins/apply-patch-tool.ts'
import { RunCommandTool } from '../tools/builtins/run-command-tool.ts'
import { SpawnTool } from '../tools/builtins/spawn-tool.ts'
import type { SkillLibrary } from '../skills/skill-library.ts'
import { RuntimeCore } from './runtime-core.ts'
import { throwIfAborted } from './runtime-cancellation.ts'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
import type { RuntimeSetupMode } from './setup-handshake.ts'

export interface RuntimeFactoryOptions extends ProviderAdapterOptions {
  setupMode?: RuntimeSetupMode
  toolServices?: ToolServices
  skillLibrary?: SkillLibrary
  projectInstructions?: ProjectInstructions | null
  allowedTools?: readonly string[] | null
  advertiseSpawnTool?: boolean
  requestAttemptLimit?: number
  workingDirectory?: string
}

const DEFAULT_TOOLS = [
  AttachImageTool,
  RunCommandTool,
  ApplyPatchTool,
  SpawnTool,
]

export async function createRuntimeFromAdapter(
  adapter: ProviderAdapter,
  options: RuntimeFactoryOptions = { model: null }
): Promise<RuntimeCore> {
  const { signal } = options

  try {
    const skillCatalog = await options.skillLibrary?.createCatalogSnapshot()
    const availableTools = [...DEFAULT_TOOLS]
    const allowedTools = options.allowedTools ?? null
    const tools =
      allowedTools === null
        ? availableTools
        : availableTools.filter((ToolClass) => {
            const tool = new ToolClass(adapter, {})
            return allowedTools.includes(tool.name)
          })
    if (allowedTools !== null) {
      const selected = new Set(
        tools.map((ToolClass) => new ToolClass(adapter, {}).name)
      )
      const unavailable = allowedTools.filter((name) => !selected.has(name))
      if (unavailable.length > 0) {
        throw new Error(
          `Requested unavailable tools: ${unavailable.join(', ')}`
        )
      }
    }
    const services: ToolServices = {
      ...(options.toolServices ?? {}),
    }
    const toolRegistry = new ToolRegistry(
      adapter,
      tools,
      services,
      options.advertiseSpawnTool === false ? ['spawn'] : []
    )
    const runtime = new RuntimeCore(adapter, toolRegistry, {
      skills: skillCatalog?.setupSkills ?? [],
      projectInstructions: options.projectInstructions ?? null,
      requestAttemptLimit: options.requestAttemptLimit ?? 3,
      workingDirectory: options.workingDirectory ?? process.cwd(),
    })
    throwIfAborted(signal)
    if (options.model !== null) {
      await adapter.changeModel(options.model)
    }
    throwIfAborted(signal)
    const setupMode = options.setupMode ?? 'full'
    if (setupMode === 'inline') {
      runtime.enableInlineSetup()
    } else if (setupMode !== 'skip') {
      await runtime.init({ signal, setupMode })
    }
    throwIfAborted(signal)
    return runtime
  } catch (error) {
    if (isProviderAdapterError(error) && error.kind === 'auth') {
      error.adapter = adapter
      throw error
    }
    await adapter.close().catch(() => {})
    throw error
  }
}
