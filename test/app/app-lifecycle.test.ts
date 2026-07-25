import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeLateBrowserLaunchAfterShutdown,
  closeWithTimeout,
  createIdempotentAsyncTask,
  stopMcpForegroundOperation,
  transitionLoginWaitWarning,
} from '../../src/app/app-lifecycle.ts'

test('login wait warning renders only when entering login wait', () => {
  assert.deepEqual(transitionLoginWaitWarning(false, true), {
    waitingForLogin: true,
    shouldRender: true,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, true), {
    waitingForLogin: true,
    shouldRender: false,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, false), {
    waitingForLogin: false,
    shouldRender: true,
  })
})

test('close timeout returns when a close operation hangs', async () => {
  await closeWithTimeout(async () => {
    await new Promise(() => {})
  }, 10)
})

test('idempotent async task runs concurrent and later calls once', async () => {
  let calls = 0
  const task = createIdempotentAsyncTask(async () => {
    calls += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
  })

  await Promise.all([task(), task(), task()])
  await task()

  assert.equal(calls, 1)
})

test('late browser launch closes after an earlier shutdown', async () => {
  const events: string[] = []
  const shutdown = createIdempotentAsyncTask(async () => {
    events.push('shutdown')
  })
  await shutdown()

  await closeLateBrowserLaunchAfterShutdown(
    { close: async () => void events.push('browser close') },
    shutdown,
    10
  )

  assert.deepEqual(events, ['shutdown', 'browser close'])
})

test('MCP foreground cancellation aborts and calls its stop target once', async () => {
  const controller = new AbortController()
  let stopCalls = 0
  const operation = {
    controller,
    stopTarget: {
      stopGeneration: async () => {
        stopCalls += 1
      },
    },
    done: Promise.resolve(),
    cancellation: null,
  }

  await Promise.all([
    stopMcpForegroundOperation(operation, 100),
    stopMcpForegroundOperation(operation, 100),
  ])

  assert.equal(controller.signal.aborted, true)
  assert.equal(stopCalls, 1)
})
