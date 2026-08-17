import { z } from 'zod'

import type {
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../../extensions/extension-contracts.ts'
import { childConversationService } from '../../threads/child-conversation-service.ts'
import {
  toolContributions,
  toolHandlerBindings,
  type ToolResult,
} from '../tool-host.ts'

const spawnInput = z
  .object({
    prompt: z.string().trim().min(1),
    provider: z.string().trim().min(1).optional(),
  })
  .strict()

export const spawnContribution = Object.freeze({
  id: 'portal.tool.spawn',
  descriptor: Object.freeze({
    name: 'spawn',
    description: 'Run a self-contained child task and wait for its result.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        prompt: Object.freeze({ type: 'string' }),
        provider: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['prompt']),
    }),
  }),
  requiredCapabilities: Object.freeze([]),
  handlerBindingId: 'portal.tool.spawn.handler',
})

export function createSpawnPlugin(): {
  readonly descriptor: {
    readonly id: string
    readonly version: string
    readonly dependencies: readonly string[]
    readonly capabilities: readonly string[]
  }
  readonly module: ExtensionModule
} {
  return Object.freeze({
    descriptor: Object.freeze({
      id: 'portal.tool.spawn',
      version: '1.0.0',
      dependencies: Object.freeze([]),
      capabilities: Object.freeze([]),
    }),
    module: Object.freeze({
      register(api: ExtensionRegistrationApi): void {
        api.contribute(toolContributions, {
          id: spawnContribution.id,
          value: spawnContribution,
          requiredServices: Object.freeze([childConversationService]),
          requiredCapabilities: Object.freeze([]),
        })
        api.bind(toolHandlerBindings, {
          id: spawnContribution.handlerBindingId,
          targetId: spawnContribution.id,
          binding: async (input, context): Promise<ToolResult> => {
            const parsed = spawnInput.safeParse(input)
            if (!parsed.success) {
              return errorResult(
                parsed.error.issues[0]?.message ?? 'Invalid spawn input.'
              )
            }
            if (context.invocation === null) {
              return errorResult(
                'spawn requires a parent conversation context.'
              )
            }
            try {
              context.onProgress?.({ type: 'start', startedAt: Date.now() })
            } catch {
              // Progress is display-only.
            }
            const service = await context.services.get(childConversationService)
            const result = await service.run(
              {
                prompt: parsed.data.prompt,
                ...(parsed.data.provider === undefined
                  ? {}
                  : { providerId: parsed.data.provider }),
              },
              context.invocation,
              context.signal
            )
            if ('kind' in result) return errorResult(result.message)
            return {
              status: 'success',
              output: { ...result },
              displayText: [
                'Spawn completed.',
                `provider: ${result.provider}`,
                `conversation: ${result.conversationUrl}`,
              ].join('\n'),
            }
          },
        })
      },
    }),
  })
}

function errorResult(message: string): ToolResult {
  return { status: 'error', output: { message }, displayText: message }
}
