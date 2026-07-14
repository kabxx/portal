import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHookSnapshot,
  parseHooksConfig,
} from '../../src/hooks/hook-config.ts'
import { HookCatalog } from '../../src/hooks/hook-catalog.ts'
import { HookDispatcher } from '../../src/hooks/hook-dispatcher.ts'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

test('ThreadManager emits each lifecycle Hook once with one turn snapshot', async () => {
  const events: string[] = []
  const dispatcher = new HookDispatcher({
    execute: async (handler, event) => {
      events.push(event.event)
      return event.event === 'tool.before'
        ? JSON.stringify({ action: 'allow' })
        : '{}'
    },
  })
  const config = parseHooksConfig({
    enabled: true,
    handlers: [
      {
        name: 'observe',
        type: 'prompt',
        events: [
          'thread.ready',
          'thread.closed',
          'turn.started',
          'turn.completed',
          'turn.failed',
          'turn.cancelled',
        ],
        prompt: 'Observe.',
      },
    ],
  })
  const catalog = new HookCatalog(
    'unused-config.yaml',
    createHookSnapshot(config)
  )
  const manager = new ThreadManager(catalog, dispatcher)
  const thread = manager.addThread({
    id: 't-hook-lifecycle',
    provider: 'chatgpt',
    runtime: createFakeRuntime({ assistantText: 'done' }),
    createdAt: Date.now(),
  })

  await manager.submitThreadInput(thread.id, 'run')
  await manager.closeThread(thread.id)

  assert.deepEqual(events, [
    'thread.ready',
    'turn.started',
    'turn.completed',
    'thread.closed',
  ])
})
