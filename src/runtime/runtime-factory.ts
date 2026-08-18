import type {
  ProviderAdapter,
  ProviderAdapterOptions,
} from '../providers/adapters/adapter-base.ts'
import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import { ToolRegistry } from '../tools/core/tool-registry.ts'
import { type RuntimeCoreOptions } from './runtime-core.ts'
import { WebProviderTextRuntime } from '../providers/web-provider-text-runtime.ts'
import { throwIfAborted } from './runtime-cancellation.ts'
import type { TextToolProtocol } from '../tools/core/text-tool-protocol.ts'
import type { ToolRuntimeService } from '../tools/tool-runtime-service.ts'
import type { AttachmentReader } from '../attachments/attachment-contracts.ts'
import type { AgentSession } from '../agents/agent-extension.ts'

export interface RuntimeFactoryOptions extends ProviderAdapterOptions {
  toolHost: ToolRuntimeService
  createAgentSession: (request: {
    readonly tools: string | null
    readonly textToolProtocol: TextToolProtocol | null
  }) => Promise<AgentSession | null>
  allowedTools?: readonly string[] | null
  advertiseSpawnTool?: boolean
  requestAttemptLimit?: number
  workingDirectory?: string
  textToolProtocol?: TextToolProtocol | null
  providerId?: string
  currentSpawnDepth?: number
  attachmentReader?: AttachmentReader
  onClose?: RuntimeCoreOptions['onClose']
}

/** The caller owns the adapter until this function returns a RuntimeCore. */
export async function createRuntimeFromAdapter(
  adapter: ProviderAdapter,
  options: RuntimeFactoryOptions
): Promise<WebProviderTextRuntime> {
  const { signal } = options
  let agentSession: AgentSession | null = null
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
      ...(options.textToolProtocol === undefined
        ? {}
        : { protocol: options.textToolProtocol }),
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
    throwIfAborted(signal)
    if (options.model !== null) {
      await adapter.changeModel(options.model)
    }
    throwIfAborted(signal)
    agentSession = await options.createAgentSession({
      tools: toolRegistry.prompt.trim() === '' ? null : toolRegistry.prompt,
      textToolProtocol:
        options.textToolProtocol === undefined
          ? toolRegistry.protocol
          : options.textToolProtocol,
    })
    throwIfAborted(signal)
    const runtime = new WebProviderTextRuntime(adapter, toolRegistry, {
      agentSession,
      requestAttemptLimit: options.requestAttemptLimit ?? 3,
      ...(options.attachmentReader === undefined
        ? {}
        : { attachmentReader: options.attachmentReader }),
      ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    })
    await runtime.init({ signal })
    throwIfAborted(signal)
    return runtime
  } catch (error) {
    if (agentSession !== null) {
      try {
        await agentSession.close?.(error)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Agent session initialization and cleanup both failed.',
          { cause: cleanupError }
        )
      }
    }
    if (isProviderAdapterError(error) && error.kind === 'auth') {
      error.adapter = adapter
    }
    throw error
  }
}
