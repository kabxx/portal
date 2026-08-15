import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ResourceCleanupError,
  ResourceCleanupTimeoutError,
  ResourceScope,
  ResourceScopeClosedError,
  ResourceScopeDisposalError,
} from '../../src/shared/resource-scope.ts'

test('ResourceScope disposes children first and resources in reverse order', async () => {
  const order: string[] = []
  const root = new ResourceScope('root')
  root.defer('root-first', () => {
    order.push('root-first')
  })
  const child = root.createChild('child')
  child.defer('child-first', () => {
    order.push('child-first')
  })
  child.defer('child-second', () => {
    order.push('child-second')
  })
  root.defer('root-second', () => {
    order.push('root-second')
  })

  await root.dispose()
  await root.dispose()

  assert.deepEqual(order, [
    'child-second',
    'child-first',
    'root-second',
    'root-first',
  ])
  assert.equal(root.state, 'disposed')
  assert.equal(child.state, 'disposed')
})

test('ResourceScope propagates aborts to children before cleanup', async () => {
  const root = new ResourceScope('root')
  const child = root.createChild('child')
  let sawAbort = false
  child.signal.addEventListener('abort', () => {
    sawAbort = true
  })
  child.defer('assert-abort', () => {
    assert.equal(child.signal.aborted, true)
  })

  await root.dispose({ reason: new Error('shutdown') })

  assert.equal(sawAbort, true)
  assert.match(String(child.signal.reason), /shutdown/)
})

test('ResourceScope executes all cleanup entries and aggregates failures', async () => {
  const order: string[] = []
  const scope = new ResourceScope('root')
  scope.defer('first', () => {
    order.push('first')
  })
  scope.defer('broken', () => {
    order.push('broken')
    throw new Error('cleanup failed')
  })
  scope.defer('last', () => {
    order.push('last')
  })

  let error: unknown
  try {
    await scope.dispose()
  } catch (caught) {
    error = caught
  }

  assert(error instanceof ResourceScopeDisposalError)
  assert.deepEqual(order, ['last', 'broken', 'first'])
  assert.equal(error.errors.length, 1)
  assert(error.errors[0] instanceof ResourceCleanupError)
  assert.match(String(error.errors[0].cause), /cleanup failed/)
})

test('ResourceScope bounds cleanup and continues after a timeout', async () => {
  const order: string[] = []
  const scope = new ResourceScope('root', { cleanupTimeoutMs: 20 })
  scope.defer('after-timeout', () => {
    order.push('after-timeout')
  })
  scope.defer('stalled', async ({ signal }) => {
    order.push('stalled')
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })

  let error: unknown
  try {
    await scope.dispose()
  } catch (caught) {
    error = caught
  }

  assert(error instanceof ResourceScopeDisposalError)
  assert.deepEqual(order, ['stalled', 'after-timeout'])
  assert(
    error.errors.some((item) => item instanceof ResourceCleanupTimeoutError)
  )
})

test('ResourceScope rejects a synchronous disposer that crosses its deadline', async () => {
  const scope = new ResourceScope('root')
  scope.defer('blocking', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  })

  let error: unknown
  try {
    await scope.dispose({ timeoutMs: 5 })
  } catch (caught) {
    error = caught
  }

  assert(error instanceof ResourceScopeDisposalError)
  assert(
    error.errors.some((item) => item instanceof ResourceCleanupTimeoutError)
  )
})

test('parent disposal applies its shorter deadline to an active child disposal', async () => {
  const root = new ResourceScope('root')
  const child = root.createChild('child')
  const disposerStarted = Promise.withResolvers<void>()
  const releaseDisposer = Promise.withResolvers<void>()
  child.defer('slow child cleanup', async () => {
    disposerStarted.resolve()
    await releaseDisposer.promise
  })
  const childDisposal = child.dispose({ timeoutMs: 200 })
  await disposerStarted.promise

  const startedAt = Date.now()
  await assert.rejects(
    root.dispose({ timeoutMs: 20 }),
    ResourceScopeDisposalError
  )
  assert(
    Date.now() - startedAt < 100,
    'Parent disposal waited for the child cleanup timeout.'
  )
  releaseDisposer.resolve()
  await childDisposal
})

test('ResourceScope closes a resource that arrives after disposal starts', async () => {
  const scope = new ResourceScope('root', { cleanupTimeoutMs: 100 })
  const pendingResource = Promise.withResolvers<{ id: string }>()
  const disposed: string[] = []
  const acquisition = scope.acquire(
    'late-resource',
    () => pendingResource.promise,
    (resource) => {
      disposed.push(resource.id)
    }
  )

  await Promise.resolve()
  const closing = scope.dispose()
  assert.equal(scope.signal.aborted, true)
  pendingResource.resolve({ id: 'late' })

  await closing
  await assert.rejects(acquisition, ResourceScopeClosedError)
  assert.deepEqual(disposed, ['late'])
})

test('ResourceScope does not dispose a failed acquisition', async () => {
  const scope = new ResourceScope('root')
  let disposed = false

  await assert.rejects(
    scope.acquire(
      'failed-resource',
      () => {
        throw new Error('factory failed')
      },
      () => {
        disposed = true
      }
    ),
    /factory failed/
  )
  await scope.dispose()

  assert.equal(disposed, false)
})

test('ResourceRegistration disposes once before its owning scope', async () => {
  const scope = new ResourceScope('root')
  let calls = 0
  const registration = scope.defer('resource', () => {
    calls += 1
  })

  await registration.dispose()
  await registration.dispose()
  await scope.dispose()

  assert.equal(registration.disposed, true)
  assert.equal(calls, 1)
})

test('ResourceScope rejects registrations after disposal begins', async () => {
  const scope = new ResourceScope('root')
  await scope.dispose()

  assert.throws(() => scope.defer('late', () => {}), ResourceScopeClosedError)
  assert.throws(() => scope.createChild('late'), ResourceScopeClosedError)
})

test('ResourceScope validates an acquisition before starting its factory', async () => {
  const scope = new ResourceScope('root')
  let factoryCalled = false

  await assert.rejects(
    scope.acquire(
      '   ',
      () => {
        factoryCalled = true
        return 'resource'
      },
      () => {}
    ),
    /label must not be empty/
  )

  assert.equal(factoryCalled, false)
  await scope.dispose()
})
