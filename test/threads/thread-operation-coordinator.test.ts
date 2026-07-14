import test from 'node:test'
import assert from 'node:assert/strict'

import { ThreadOperationCoordinator } from '../../src/threads/thread-operation-coordinator.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

test('coordinator allows different threads but rejects a second turn in the same thread', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const firstDone = deferred()
  const secondDone = deferred()

  const first = coordinator.tryStart('a', null, async () => {
    await firstDone.promise
  })
  const duplicate = coordinator.tryStart('a', null, async () => {})
  const second = coordinator.tryStart('b', null, async () => {
    await secondDone.promise
  })

  assert.equal(first.accepted, true)
  assert.deepEqual(duplicate, { accepted: false, reason: 'running' })
  assert.equal(second.accepted, true)
  assert.deepEqual(
    coordinator
      .list()
      .map(({ threadId }) => threadId)
      .sort(),
    ['a', 'b']
  )

  firstDone.resolve()
  secondDone.resolve()
  if (first.accepted && second.accepted) {
    await Promise.all([first.operation.done, second.operation.done])
  }
  assert.deepEqual(coordinator.list(), [])
})

test('coordinator cancellation aborts and stops only the selected thread', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const stopped: string[] = []
  const signals = new Map<string, AbortSignal>()

  for (const threadId of ['a', 'b']) {
    coordinator.tryStart(
      threadId,
      {
        stopGeneration: async () => {
          stopped.push(threadId)
        },
      },
      async ({ signal }) => {
        signals.set(threadId, signal)
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    )
  }

  await new Promise<void>((resolve) => setImmediate(resolve))
  await coordinator.cancel('a')

  assert.equal(signals.get('a')?.aborted, true)
  assert.equal(signals.get('b')?.aborted, false)
  assert.deepEqual(stopped, ['a'])
  assert.equal(coordinator.get('a'), null)
  assert.equal(coordinator.get('b')?.phase, 'running')

  await coordinator.cancel('b')
})

test('coordinator close blocks new work, waits for cancellation, then closes', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const events: string[] = []
  coordinator.tryStart('a', null, async ({ signal }) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          events.push('settled')
          resolve()
        },
        { once: true }
      )
    })
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  await coordinator.close('a', async () => {
    events.push('closed')
    assert.deepEqual(
      coordinator.tryStart('a', null, async () => {}),
      {
        accepted: false,
        reason: 'closing',
      }
    )
  })

  assert.deepEqual(events, ['settled', 'closed'])
  assert.equal(coordinator.get('a'), null)
})

test('coordinator reuses an in-flight close for the same thread', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const closeDone = deferred()
  let closeCalls = 0

  const first = coordinator.close('a', async () => {
    closeCalls += 1
    await closeDone.promise
    return 'closed'
  })
  const second = coordinator.close('a', async () => {
    closeCalls += 1
    return 'duplicate'
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closeCalls, 1)
  assert.deepEqual(
    coordinator.tryStart('a', null, async () => {}),
    {
      accepted: false,
      reason: 'closing',
    }
  )

  closeDone.resolve()
  assert.equal(await first, 'closed')
  assert.equal(await second, 'closed')
  assert.equal(closeCalls, 1)
})

test('coordinator shares cancellation and keeps closing as the strongest phase', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const stopDone = deferred()
  let stopCalls = 0
  coordinator.tryStart(
    'a',
    {
      stopGeneration: async () => {
        stopCalls += 1
        await stopDone.promise
      },
    },
    async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  const close = coordinator.close('a', async () => true)
  const cancel = coordinator.cancel('a')
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(stopCalls, 1)
  assert.equal(coordinator.get('a')?.phase, 'closing')
  stopDone.resolve()
  await Promise.all([close, cancel])
})

test('coordinator bounds cancellation waits without releasing a stuck operation', async () => {
  const coordinator = new ThreadOperationCoordinator(10)
  const never = new Promise<void>(() => {})
  let stopCalls = 0
  coordinator.tryStart(
    'a',
    {
      stopGeneration: async () => {
        stopCalls += 1
        await never
      },
    },
    async () => {
      await never
    }
  )

  await coordinator.cancel('a')

  assert.equal(stopCalls, 1)
  assert.equal(coordinator.get('a')?.phase, 'cancelling')
  assert.deepEqual(
    coordinator.tryStart('a', null, async () => {}),
    {
      accepted: false,
      reason: 'running',
    }
  )
})

test('coordinator cleans up rejected detached operations', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const result = coordinator.tryStart('a', null, async () => {
    throw new Error('failure')
  })

  assert.equal(result.accepted, true)
  if (result.accepted) {
    await assert.rejects(result.operation.done, /failure/)
  }
  assert.equal(coordinator.get('a'), null)
})

test('coordinator has no global thread limit and cancelAll settles every operation', async () => {
  const coordinator = new ThreadOperationCoordinator()
  const started: string[] = []

  for (let index = 0; index < 12; index += 1) {
    const threadId = `t-${index}`
    const result = coordinator.tryStart(threadId, null, async ({ signal }) => {
      started.push(threadId)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })
    assert.equal(result.accepted, true)
  }

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(started.length, 12)
  assert.equal(coordinator.list().length, 12)

  await coordinator.cancelAll()
  assert.deepEqual(coordinator.list(), [])
})
