import { randomUUID } from 'node:crypto'

import type { ProviderHost } from '../providers/provider-host.ts'
import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import type { PortalRuntimeSettings } from '../runtime/runtime-settings.ts'
import type {
  ChildConversationParent,
  ChildConversationRequest,
  ChildConversationResult,
  ChildConversationService,
} from './child-conversation-service.ts'
import type { ConversationHost, ConversationItem } from './conversation-host.ts'

export function inheritSpawnModelSelection(
  parentProvider: string,
  spawnProvider: string,
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

export function createWebChildConversationService(options: {
  readonly providers: ProviderHost
  readonly conversations: ConversationHost
  readonly settings: PortalRuntimeSettings
  readonly generation: string
  readonly workingDirectory: string
}): ChildConversationService {
  return Object.freeze({
    run: async (
      request: ChildConversationRequest,
      parent: ChildConversationParent,
      signal: AbortSignal
    ): Promise<ChildConversationResult> => {
      const childSpawnDepth = nextSpawnDepth(
        parent.spawnDepth,
        options.settings.spawnDepthLimit
      )
      if (childSpawnDepth === null) {
        return {
          kind: 'error',
          message: `SPAWN_DEPTH_LIMIT_REACHED: spawn depth ${parent.spawnDepth} reached the configured limit ${options.settings.spawnDepthLimit}`,
        }
      }
      const parentProvider = options.providers.resolveProviderId(
        parent.providerId
      )
      if (parentProvider === null) {
        return {
          kind: 'error',
          message: `Unsupported parent provider: ${parent.providerId}`,
        }
      }
      const spawnProvider = options.providers.resolveProviderId(
        request.providerId ?? parentProvider
      )
      if (spawnProvider === null) {
        return {
          kind: 'error',
          message: `Unsupported spawn provider: ${request.providerId}`,
        }
      }
      const threadId = `spawn-${randomUUID()}`
      try {
        await options.conversations.open({
          threadId,
          providerId: spawnProvider,
          providerOwnerId: options.providers.ownerOf(spawnProvider),
          conversationId: threadId,
          selectionRevision: options.generation,
          model: inheritSpawnModelSelection(
            parentProvider,
            spawnProvider,
            parent.model
          ),
          setupMode: 'full',
          workingDirectory: parent.workingDirectory,
          spawnDepth: childSpawnDepth,
        })
        const thread = await options.conversations.send(
          threadId,
          request.prompt,
          {
            signal,
            invocation: {
              providerId: spawnProvider,
              model: inheritSpawnModelSelection(
                parentProvider,
                spawnProvider,
                parent.model
              ),
              spawnDepth: childSpawnDepth,
              workingDirectory: parent.workingDirectory,
            },
          }
        )
        const turn = thread.turns.at(-1)
        if (turn === undefined || turn.status !== 'completed') {
          return {
            kind: 'error',
            message: failureMessage(turn?.items ?? []),
          }
        }
        const output = [...turn.items]
          .reverse()
          .find(
            (
              item
            ): item is Extract<
              ConversationItem,
              { readonly kind: 'assistant' }
            > => item.kind === 'assistant'
          )?.text
        const identity = options.conversations.identity(threadId)
        return {
          provider: spawnProvider,
          conversationUrl:
            identity?.conversationUrl ??
            `portal://provider/${encodeURIComponent(spawnProvider)}/${encodeURIComponent(threadId)}`,
          output: output ?? '',
        }
      } finally {
        await options.conversations.close(threadId, 'child-complete')
      }
    },
  })
}

function failureMessage(items: readonly ConversationItem[]): string {
  return (
    [...items]
      .reverse()
      .find(
        (item): item is Extract<ConversationItem, { readonly kind: 'error' }> =>
          item.kind === 'error'
      )?.message ?? 'Child conversation failed.'
  )
}
