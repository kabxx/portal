import test from 'node:test'
import assert from 'node:assert/strict'

import { ThreadRegistry } from '../../src/threads/thread-registry.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

test('ThreadRegistry seeds title from the first user input', () => {
  const manager = new ThreadRegistry()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      conversationId: 'conv-1',
      conversationUrl: 'https://example.com/conv-1',
    }),
    createdAt: 1,
  })

  const turn = manager.beginTurn(
    thread.id,
    '   Build a landing page for the workspace with strong visual hierarchy   '
  )
  assert.ok(turn)

  manager.appendTurnItem(thread.id, turn.id, {
    kind: 'assistant_text',
    text: 'Drafted the initial concept and visual direction.',
    createdAt: 2,
  })
  manager.completeTurn(thread.id, turn.id, 'completed')

  const updatedThread = manager.getThread(thread.id)
  assert.ok(updatedThread)
  assert.equal(
    updatedThread.title,
    'Build a landing page for the workspace with s...'
  )
  assert.equal(updatedThread.turns.length, 1)
})

test('ThreadRegistry records tool results and errors without updating thread metadata beyond timestamp', () => {
  const manager = new ThreadRegistry()
  const thread = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const turn = manager.beginTurn(thread.id, 'inspect the repository')
  assert.ok(turn)

  manager.appendTurnItem(thread.id, turn.id, {
    kind: 'tool_result',
    toolName: 'run_command',
    outcome: 'success',
    result: { stdout: 'README.md\nsrc\npackage.json' },
    createdAt: 2,
  })
  assert.equal(manager.getThread(thread.id)?.updatedAt, 2)

  manager.appendTurnItem(thread.id, turn.id, {
    kind: 'error',
    text: 'Timed out while waiting for the provider.',
    createdAt: 3,
  })
  assert.equal(manager.getThread(thread.id)?.updatedAt, 3)
})

test('ThreadRegistry leaves no active thread after closing the active thread', () => {
  const manager = new ThreadRegistry()
  const first = manager.addThread({
    id: manager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  manager.addThread({
    id: manager.createThreadId(),
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })

  assert.ok(manager.removeThread(first.id))
  assert.equal(manager.getActiveThread()?.id, 't-2')

  assert.ok(manager.removeThread('t-2'))
  assert.equal(manager.getActiveThread(), null)
})
