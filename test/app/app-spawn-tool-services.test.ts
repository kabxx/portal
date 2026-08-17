import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWebChildConversationService,
  inheritSpawnModelSelection,
  nextSpawnDepth,
} from '../../src/threads/web-child-conversation-service.ts'
import { createPortalRuntimeSettings } from '../../src/runtime/runtime-settings.ts'
import type { ProviderHost } from '../../src/providers/provider-host.ts'
import type { ConversationHost } from '../../src/threads/conversation-host.ts'

test('spawn model selection inherits only within the same provider', () => {
  const model = { key: '3.1-pro', option: 'extended' }

  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', model), model)
  assert.equal(inheritSpawnModelSelection('gemini', 'deepseek', model), null)
  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', null), null)
})

test('nextSpawnDepth allows configured child levels and rejects the next one', () => {
  assert.equal(nextSpawnDepth(0, 0), null)
  assert.equal(nextSpawnDepth(0, 1), 1)
  assert.equal(nextSpawnDepth(4, 5), 5)
  assert.equal(nextSpawnDepth(5, 5), null)
})

test('spawn depth rejection occurs before Provider graph side effects', async () => {
  let providerCalls = 0
  const settings = createPortalRuntimeSettings()
  settings.spawnDepthLimit = 5
  const service = createWebChildConversationService({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    providers: {
      resolveProviderId: () => {
        providerCalls += 1
        return 'chatgpt'
      },
    } as unknown as ProviderHost,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    conversations: {} as ConversationHost,
    settings,
    generation: 'test-generation',
    workingDirectory: process.cwd(),
  })

  const result = await service.run(
    { prompt: 'must not run' },
    {
      providerId: 'chatgpt',
      model: null,
      spawnDepth: 5,
      workingDirectory: process.cwd(),
    },
    new AbortController().signal
  )

  assert.deepEqual(result, {
    kind: 'error',
    message:
      'SPAWN_DEPTH_LIMIT_REACHED: spawn depth 5 reached the configured limit 5',
  })
  assert.equal(providerCalls, 0)
})
