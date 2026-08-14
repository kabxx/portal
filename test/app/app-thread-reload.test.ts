import assert from 'node:assert/strict'
import test from 'node:test'

import { startThreadReload } from '../../src/app/app-thread-reload.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import type { ThreadLifecycleService } from '../../src/threads/thread-lifecycle-service.ts'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import type { ThreadOperationContext } from '../../src/threads/thread-operation-coordinator.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'

test('startThreadReload restores the thread and clears its busy state', async () => {
  const adapter = createProviderAdapterStub()
  let restoreCalls = 0
  Object.assign(adapter, {
    restore: async () => {
      restoreCalls += 1
    },
  })
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter }),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(threadManager)
  ui.showThreadTimeline(thread.id)
  const lifecycle = createLifecycleStub()

  const result = startThreadReload(thread.id, {
    threadManager,
    threadLifecycle: lifecycle,
    ui,
  })

  assert.equal(result.accepted, true)
  if (!result.accepted) return
  await result.operation.done
  assert.equal(restoreCalls, 1)
  assert.equal(ui.getState().busy, false)
  assert.equal(ui.getState().timeline.at(-1)?.body, 'Provider page reloaded.')
})

test('startThreadReload reports missing and busy threads', () => {
  const threadManager = new ThreadManager()
  const ui = new TerminalController()
  assert.deepEqual(
    startThreadReload('missing', {
      threadManager,
      threadLifecycle: createLifecycleStub(),
      ui,
    }),
    { accepted: false, reason: 'not_found' }
  )

  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const busyLifecycle = {
    startOperation: () => ({ accepted: false, reason: 'running' }),
  } as unknown as ThreadLifecycleService
  assert.deepEqual(
    startThreadReload(thread.id, {
      threadManager,
      threadLifecycle: busyLifecycle,
      ui,
    }),
    { accepted: false, reason: 'busy' }
  )
})

function createLifecycleStub(): ThreadLifecycleService {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    startOperation: (
      threadId: string,
      runner: (context: ThreadOperationContext) => Promise<void>
    ) => {
      const done = runner({
        signal: new AbortController().signal,
        setStopTarget: () => {},
      })
      return {
        accepted: true as const,
        operation: {
          threadId,
          phase: 'running' as const,
          startedAt: Date.now(),
          done,
          cancel: async () => false,
        },
      }
    },
  } as unknown as ThreadLifecycleService
}
