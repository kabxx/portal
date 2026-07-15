import assert from 'node:assert/strict'
import test from 'node:test'

import { McpMessageOperationStore } from '../../src/mcp-server/mcp-message-operations.ts'
import type { ThreadOperationHandle } from '../../src/threads/thread-operation-coordinator.ts'

function createHandle(cancel: () => Promise<boolean>): ThreadOperationHandle {
  return {
    threadId: 't-1',
    phase: 'running',
    startedAt: Date.now(),
    done: Promise.resolve(),
    cancel,
  }
}

test('message operation completes and wait returns the assistant result', async () => {
  const store = new McpMessageOperationStore()
  const operation = store.begin('t-1')
  const wait = store.wait(
    operation.operationId,
    1_000,
    new AbortController().signal
  )

  store.complete(operation.operationId, 'done')

  assert.deepEqual(await wait, {
    operationId: operation.operationId,
    threadId: 't-1',
    status: 'completed',
    assistant: 'done',
  })
})

test('message operation wait returns running after its bounded timeout', async () => {
  const store = new McpMessageOperationStore()
  const operation = store.begin('t-1')

  assert.deepEqual(
    await store.wait(operation.operationId, 1, new AbortController().signal),
    operation
  )
})

test('message operation uses its owned handle for cancellation', async () => {
  const store = new McpMessageOperationStore()
  const operation = store.begin('t-1')
  let cancelCalls = 0
  store.attachHandle(
    operation.operationId,
    createHandle(async () => {
      cancelCalls += 1
      store.cancelled(operation.operationId)
      return true
    })
  )

  assert.deepEqual(await store.cancel(operation.operationId), {
    operationId: operation.operationId,
    threadId: 't-1',
    status: 'cancelled',
  })
  assert.equal(cancelCalls, 1)
})

test('message operation capacity never evicts running operations', () => {
  const store = new McpMessageOperationStore({ maxEntries: 2 })
  store.begin('t-1')
  store.begin('t-2')

  assert.throws(() => store.begin('t-3'), /Too many running/)
})

test('message operation capacity evicts the oldest terminal operation', () => {
  const store = new McpMessageOperationStore({ maxEntries: 2 })
  const first = store.begin('t-1')
  store.complete(first.operationId, 'first')
  const second = store.begin('t-2')
  store.complete(second.operationId, 'second')

  const third = store.begin('t-3')

  assert.throws(() => store.get(first.operationId), /Unknown MCP message/)
  assert.equal(store.get(second.operationId).status, 'completed')
  assert.equal(third.status, 'running')
})

test('message operation terminal records expire after the configured TTL', async () => {
  const store = new McpMessageOperationStore({ terminalTtlMs: 1 })
  const operation = store.begin('t-1')
  store.fail(operation.operationId, 'failed')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))

  assert.throws(() => store.get(operation.operationId), /Unknown MCP message/)
})

test('message operation store cancels running handles on stop', async () => {
  const store = new McpMessageOperationStore()
  const operation = store.begin('t-1')
  let cancelled = false
  store.attachHandle(
    operation.operationId,
    createHandle(async () => {
      cancelled = true
      return true
    })
  )

  await store.stopAll()

  assert.equal(cancelled, true)
  assert.throws(() => store.get(operation.operationId), /Unknown MCP message/)
})
