import type {
  ProviderAdapter,
  ProviderAdapterOptions,
} from '../providers/adapters/adapter-base.ts'
import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import { ToolRegistry } from '../tools/core/tool-registry.ts'
import { RuntimeCore, type RuntimeCoreOptions } from './runtime-core.ts'
import { throwIfAborted } from './runtime-cancellation.ts'
import type { SetupSkill } from './setup-prompt.ts'
import type { RuntimeSetupMode } from './setup-handshake.ts'
import { DEFAULT_TEXT_TOOL_PROTOCOL } from '../tools/core/text-tool-protocol.ts'
import type { TextToolProtocol } from '../tools/core/text-tool-protocol.ts'
import type { ToolRuntimeService } from '../tools/tool-runtime-service.ts'
import type { AttachmentReader } from '../attachments/attachment-contracts.ts'

export interface RuntimeFactoryOptions extends ProviderAdapterOptions {
  setupMode?: RuntimeSetupMode
  toolHost: ToolRuntimeService
  skills?: readonly SetupSkill[]
  projectInstructions?: string | null
  allowedTools?: readonly string[] | null
  advertiseSpawnTool?: boolean
  requestAttemptLimit?: number
  workingDirectory?: string
  textToolProtocol?: TextToolProtocol
  providerId?: string
  currentSpawnDepth?: number
  attachmentReader?: AttachmentReader
  exchangeDelegate?: RuntimeCoreOptions['exchangeDelegate']
  onClose?: RuntimeCoreOptions['onClose']
}

/** The caller owns the adapter until this function returns a RuntimeCore. */
export async function createRuntimeFromAdapter(
  adapter: ProviderAdapter,
  options: RuntimeFactoryOptions
): Promise<RuntimeCore> {
  const { signal } = options
  try {
    const allowedTools = options.allowedTools ?? null
    const graphToolNames = options.toolHost
      .list()
      .map(({ descriptor }) => descriptor.name)
    if (allowedTools !== null) {
      const selected = new Set(graphToolNames)
      const unavailable = allowedTools.filter((name) => !selected.has(name))
      if (unavailable.length > 0) {
        throw new Error(
          `Requested unavailable tools: ${unavailable.join(', ')}`
        )
      }
    }
    const hiddenToolNames = [
      ...(options.advertiseSpawnTool === false ? ['spawn'] : []),
      ...(allowedTools === null
        ? []
        : graphToolNames.filter((name) => !allowedTools.includes(name))),
    ]
    const toolRegistry = new ToolRegistry(adapter, {
      toolHost: options.toolHost,
      hiddenToolNames,
      protocol: options.textToolProtocol ?? DEFAULT_TEXT_TOOL_PROTOCOL,
      ...(options.providerId === undefined
        ? {}
        : {
            invocation: {
              providerId: options.providerId,
              model: options.model,
              spawnDepth: options.currentSpawnDepth ?? 0,
              workingDirectory: options.workingDirectory ?? process.cwd(),
            },
          }),
    })
    const runtime = new RuntimeCore(adapter, toolRegistry, {
      skills: options.skills ?? [],
      projectInstructions: options.projectInstructions ?? null,
      requestAttemptLimit: options.requestAttemptLimit ?? 3,
      workingDirectory: options.workingDirectory ?? process.cwd(),
      ...(options.attachmentReader === undefined
        ? {}
        : { attachmentReader: options.attachmentReader }),
      ...(options.exchangeDelegate === undefined
        ? {}
        : { exchangeDelegate: options.exchangeDelegate }),
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
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
    }
    throw error
  }
}
