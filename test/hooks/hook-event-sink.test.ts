import test from 'node:test'
import assert from 'node:assert/strict'

import { HookEventBus } from '../../src/hooks/hook-event-sink.ts'
import type { HookExecutionEvent } from '../../src/hooks/hook-types.ts'

const event: HookExecutionEvent = {
  hookRunId: 'hook-1',
  phase: 'completed',
  event: 'tool.before',
  handler: 'audit',
  handlerType: 'command',
  occurredAt: 1,
}

test('HookEventBus emits to current subscribers and supports unsubscribe', () => {
  const bus = new HookEventBus()
  const received: string[] = []
  const unsubscribeFirst = bus.subscribe((value) => {
    received.push(`first:${value.hookRunId}`)
  })
  bus.subscribe((value) => {
    received.push(`second:${value.hookRunId}`)
  })

  bus.emit(event)
  unsubscribeFirst()
  unsubscribeFirst()
  bus.emit({ ...event, hookRunId: 'hook-2' })

  assert.deepEqual(received, ['first:hook-1', 'second:hook-1', 'second:hook-2'])
})
