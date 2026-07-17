import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ThreadAlreadyRunningError,
  ThreadCloseCleanupError,
  ThreadManager,
} from '../../src/threads/thread-manager.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import {
  type TurnRecord,
  ThreadRegistry,
} from '../../src/threads/thread-registry.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

function getRecordedTurn(
  manager: ThreadManager,
  threadId: string,
  turnId: string
): TurnRecord {
  const registry: unknown = Reflect.get(manager, 'threads')
  assert.ok(registry instanceof ThreadRegistry)
  const turn = registry.getTurn(threadId, turnId)
  assert.ok(turn)
  return turn
}

test('ThreadManager creates threads with thread-first APIs', () => {
  const manager = new ThreadManager()

  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      conversationId: 'g-1',
      conversationUrl: 'https://example.com/g-1',
    }),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({
      conversationId: 'g-2',
      conversationUrl: 'https://example.com/g-2',
    }),
    createdAt: 2,
  })

  assert.equal(manager.listThreads().length, 2)
  assert.equal(manager.getActiveThread()?.id, second.id)
  assert.equal(first.provider, 'gemini')
  assert.equal(second.provider, 'deepseek')
})

test('ThreadManager submitThreadInput records turn metadata and resumeLastThread switches to newest thread', async () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      assistantText: 'Here is the first response.',
    }),
    createdAt: 1,
  })
  const second = manager.addThread({
    id: manager.createThreadId(),
    provider: 'deepseek',
    runtime: createFakeRuntime({
      assistantText: 'Second thread response.',
    }),
    createdAt: 2,
  })

  await manager.submitThreadInput(first.id, 'Summarize the current plan.')
  const firstThread = manager.getThread(first.id)
  assert.ok(firstThread)
  assert.equal(firstThread.turnCount, 1)

  manager.switchThread(first.id)
  const resumed = manager.resumeLastThread()
  assert.ok(resumed)
  assert.equal(resumed.id, second.id)
})

test('ThreadManager submitThreadInput throws on failure', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      submitUserInput: async () => {
        throw new Error('submit failed')
      },
    }),
    createdAt: 1,
  })

  const items: string[] = []
  await assert.rejects(
    manager.submitThreadInput(thread.id, 'Trigger a failure.', {
      onTurnItem: (item) => {
        items.push(item.kind === 'error' ? item.text : item.kind)
      },
    }),
    /submit failed/
  )
  assert.deepEqual(items, ['Error: submit failed'])
})

test('ThreadManager submitThreadInput records cancelled turns without error items', async () => {
  const manager = new ThreadManager()
  const controller = new AbortController()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      submitUserInput: async (_input, handlers) => {
        controller.abort(new PortalAbortError('cancelled in test'))
        throw (
          handlers?.signal?.reason ?? new Error('missing cancellation signal')
        )
      },
    }),
    createdAt: 1,
  })

  await assert.rejects(
    manager.submitThreadInput(thread.id, 'Cancel this.', {
      signal: controller.signal,
    }),
    PortalAbortError
  )

  const recordedTurn = getRecordedTurn(manager, thread.id, 'turn1')
  assert.equal(recordedTurn.status, 'canceled')
  assert.deepEqual(
    recordedTurn.items.map((item) => item.kind),
    ['user_text']
  )
})

test('ThreadManager does not create a turn for an already cancelled input', async () => {
  const manager = new ThreadManager()
  const controller = new AbortController()
  let submitted = false
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      submitUserInput: async () => {
        submitted = true
        return 'unexpected'
      },
    }),
    createdAt: 1,
  })
  controller.abort(new PortalAbortError('cancelled before submit'))

  await assert.rejects(
    manager.submitThreadInput(thread.id, 'Do not submit this.', {
      signal: controller.signal,
    }),
    PortalAbortError
  )

  assert.equal(submitted, false)
  assert.equal(manager.getThread(thread.id)?.turnCount, 0)
  assert.equal(manager.getThread(thread.id)?.title, null)
  assert.equal(manager.isThreadRunning(thread.id), false)
})

test('ThreadManager submitThreadInput preserves status warnings emitted during submit', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'doubao',
    runtime: createFakeRuntime({
      submitUserInput: async (_input, handlers) => {
        await handlers?.onStatus?.(
          'Doubao submit has not started a provider request yet.'
        )
        await handlers?.onAssistantText?.('Recovered and returned a response.')
        return 'Recovered and returned a response.'
      },
    }),
    createdAt: 1,
  })

  await manager.submitThreadInput(thread.id, 'retry this request later')

  const updatedThread = manager.getThread(thread.id)
  assert.ok(updatedThread)
  assert.equal(updatedThread.turnCount, 1)
  const recordedTurn = getRecordedTurn(manager, thread.id, 'turn1')
  const turnItems = recordedTurn.items.map((item) => item.kind)
  assert.deepEqual(turnItems, ['user_text', 'status', 'assistant_text'])
})

test('ThreadManager forwards manual skill selection without persisting it as a turn item', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      submitUserInput: async (_input, handlers) => {
        await handlers?.onManualSkill?.('manual-skill')
        await handlers?.onAssistantText?.('Ready for the task.')
        return 'Ready for the task.'
      },
    }),
    createdAt: 1,
  })
  const selected: string[] = []

  await manager.submitThreadInput(thread.id, '$manual-skill', {
    onManualSkill: async (name) => {
      selected.push(name)
    },
  })

  assert.deepEqual(selected, ['manual-skill'])
  const turn = getRecordedTurn(manager, thread.id, 'turn1')
  assert.deepEqual(
    turn.items.map((item) => item.kind),
    ['user_text', 'assistant_text']
  )
})

test('ThreadManager preserves full tool content and optional display text', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      submitUserInput: async (_input, handlers) => {
        await handlers?.onToolResult?.(
          {
            outcome: 'success',
            result: { instructions: 'FULL SKILL CONTENT' },
            displayText: 'Loaded skill: pdf-processing',
          },
          { tool: 'load_skill', params: { name: 'pdf-processing' } }
        )
        return 'done'
      },
    }),
    createdAt: 1,
  })

  await manager.submitThreadInput(thread.id, 'load the skill')

  const turn = getRecordedTurn(manager, thread.id, 'turn1')
  const toolResult = turn.items[1]
  assert.ok(toolResult)
  assert.deepEqual(toolResult, {
    kind: 'tool_result',
    toolName: 'load_skill',
    outcome: 'success',
    result: { instructions: 'FULL SKILL CONTENT' },
    displayText: 'Loaded skill: pdf-processing',
    createdAt: toolResult.createdAt,
  })
})

test('ThreadManager forwards tool progress without persisting it as a turn item', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime({
      submitUserInput: async (_input, handlers) => {
        handlers?.onToolProgress?.(
          { type: 'start', startedAt: 1 },
          { tool: 'run_command', params: {} },
          'tool-call-1'
        )
        handlers?.onToolProgress?.(
          { type: 'output', stream: 'stdout', text: 'working\n' },
          { tool: 'run_command', params: {} },
          'tool-call-1'
        )
        await handlers?.onToolResult?.(
          {
            outcome: 'success',
            result: { exitCode: 0 },
            displayText: 'exitCode: 0',
          },
          { tool: 'run_command', params: {} }
        )
        return 'done'
      },
    }),
    createdAt: 1,
  })
  const progress: string[] = []

  await manager.submitThreadInput(thread.id, 'run command', {
    onToolProgress: (event, _toolCall, toolCallId) => {
      progress.push(`${toolCallId}:${event.type}`)
    },
  })

  assert.deepEqual(progress, ['tool-call-1:start', 'tool-call-1:output'])
  const turn = getRecordedTurn(manager, thread.id, 'turn1')
  assert.deepEqual(
    turn.items.map((item) => item.kind),
    ['user_text', 'tool_result']
  )
})

test('ThreadManager rejects concurrent turns in the same thread', async () => {
  let release!: () => void
  const running = new Promise<void>((resolve) => {
    release = resolve
  })
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: 't-concurrent',
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      submitUserInput: async () => {
        await running
        return 'done'
      },
    }),
    createdAt: Date.now(),
  })

  const first = manager.submitThreadInput(thread.id, 'first')
  await assert.rejects(
    manager.submitThreadInput(thread.id, 'second'),
    ThreadAlreadyRunningError
  )
  assert.equal(manager.isThreadRunning(thread.id), true)

  release()
  await first
  assert.equal(manager.isThreadRunning(thread.id), false)
})

test('ThreadManager forwards unexpected page close and unsubscribes before close', async () => {
  let emitPageClose = () => {}
  const manager = new ThreadManager()
  const observed: string[] = []
  manager.onThreadPageClosed(() => {
    throw new Error('listener failed')
  })
  manager.onThreadPageClosed((threadId) => {
    observed.push(threadId)
  })
  const thread = manager.addThread({
    id: 't-page-close',
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      onUnexpectedPageClose: (listener) => {
        emitPageClose = listener
        return () => {
          emitPageClose = () => {}
        }
      },
      close: async () => {
        emitPageClose()
      },
    }),
    createdAt: 1,
  })

  emitPageClose()
  assert.deepEqual(observed, [thread.id])
  observed.length = 0

  await manager.closeThread(thread.id)
  assert.deepEqual(observed, [])
})

test('ThreadManager deduplicates concurrent closes', async () => {
  let releaseClose!: () => void
  const closeBlocked = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  let closeCalls = 0
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: 't-concurrent-close',
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      close: async () => {
        closeCalls += 1
        await closeBlocked
      },
    }),
    createdAt: 1,
  })

  const first = manager.closeThread(thread.id)
  const second = manager.closeThread(thread.id)
  releaseClose()

  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(closeCalls, 1)
  assert.equal(manager.getThread(thread.id), null)
})

test('ThreadManager removes a closed thread when runtime cleanup fails', async () => {
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: 't-close-failure',
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      close: async () => {
        throw new Error('cleanup failed')
      },
    }),
    createdAt: 1,
  })

  await assert.rejects(manager.closeThread(thread.id), (error: unknown) => {
    assert.ok(error instanceof ThreadCloseCleanupError)
    assert.equal(error.threadId, thread.id)
    assert.equal(error.cleanupErrors.length, 1)
    assert.match(String(error.cleanupErrors[0]), /cleanup failed/)
    return true
  })
  assert.equal(manager.getThread(thread.id), null)
})
