import type { ProviderAdapter } from '../../src/providers/adapters/adapter-base.ts'
import type { ChildConversationParent } from '../../src/threads/child-conversation-service.ts'
import type {
  ToolConstructor,
  ToolServices,
} from '../../src/tools/core/tool-definition.ts'
import { ToolRegistry } from '../../src/tools/core/tool-registry.ts'
import type { TextToolProtocol } from '../../src/tools/core/text-tool-protocol.ts'
import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ServiceContainer } from '../../src/extensions/service-container.ts'
import { ExtensionResourceScope } from '../../src/extensions/scope-registration.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import {
  defineToolHost,
  ToolHost,
  toolContributions,
  toolHandlerBindings,
} from '../../src/tools/tool-host.ts'

interface TestToolHostOptions {
  readonly services?: ToolServices
  readonly hiddenToolNames?: readonly string[]
  readonly protocol?: TextToolProtocol | null
  readonly invocation?: ChildConversationParent
}

/** Adapts legacy test Tool classes into real graph contributions. */
export function createTestToolHost(
  adapter: ProviderAdapter,
  constructors: readonly ToolConstructor[],
  options: TestToolHostOptions = {}
): ToolHost {
  const registry = new ExtensionRegistry({
    generation: 'test-tools',
    policies: Object.freeze([]),
  })
  defineToolHost(registry)

  for (const [index, ToolClass] of constructors.entries()) {
    const tool = new ToolClass(adapter, options.services)
    const extensionId = `test.tool.${index}.${tool.name}`
    const contributionId = `${extensionId}.contribution`
    const handlerId = `${extensionId}.handler`
    const inputSchema = isRecord(tool.metadata.inputSchema)
      ? tool.metadata.inputSchema
      : Object.freeze({ type: 'object' })
    registry.register(
      {
        id: extensionId,
        version: '1.0.0',
        dependencies: Object.freeze([]),
        capabilities: Object.freeze([]),
      },
      {
        register(api): void {
          api.contribute(toolContributions, {
            id: contributionId,
            value: {
              id: contributionId,
              descriptor: {
                name: tool.name,
                description: tool.metadata.description,
                inputFormat: tool.inputFormat,
                inputSchema,
              },
              requiredCapabilities: Object.freeze([]),
              handlerBindingId: handlerId,
            },
            requiredServices: Object.freeze([]),
            requiredCapabilities: Object.freeze([]),
          })
          api.bind(toolHandlerBindings, {
            id: handlerId,
            targetId: contributionId,
            binding: async (input, context) => {
              const output = await tool.call(input, {
                signal: context.signal,
                ...(context.onProgress === undefined
                  ? {}
                  : { onProgress: context.onProgress }),
              })
              return {
                status: output.outcome ?? 'success',
                output: output.result,
                displayText: output.displayText,
              }
            },
          })
        },
      }
    )
  }

  const graph = registry.freeze()
  const root = new ResourceScope('test-tool-root')
  const portal = new ExtensionResourceScope('portal', 'test-tools', root)
  return new ToolHost({
    graph,
    parent: portal,
    services: new ServiceContainer(graph.servicePlan),
  })
}

export function createTestToolRegistry(
  adapter: ProviderAdapter,
  constructors: readonly ToolConstructor[],
  options: TestToolHostOptions = {}
): ToolRegistry {
  const host = createTestToolHost(adapter, constructors, options)
  return new ToolRegistry(adapter, {
    toolHost: host,
    ...(options.hiddenToolNames === undefined
      ? {}
      : { hiddenToolNames: options.hiddenToolNames }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    ...(options.invocation === undefined
      ? {}
      : { invocation: options.invocation }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
