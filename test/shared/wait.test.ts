import test from 'node:test'
import assert from 'node:assert/strict'

import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import { waitAsync } from '../../src/shared/wait.ts'

test('waitAsync without a deadline waits until the predicate succeeds', async () => {
  let attempts = 0
  let timedOut = false

  await waitAsync(
    async () => {
      attempts += 1
      return attempts === 3
    },
    {
      timeoutMs: null,
      onPending: async () => {},
      onTimeout: async () => {
        timedOut = true
      },
    }
  )

  assert.equal(attempts, 3)
  assert.equal(timedOut, false)
})

test('waitAsync without a deadline remains abortable', async () => {
  const controller = new AbortController()
  const pending = waitAsync(async () => false, {
    timeoutMs: null,
    signal: controller.signal,
  })

  controller.abort(new PortalAbortError('cancel pending wait'))

  await assert.rejects(pending, /cancel pending wait/)
})

test('waitAsync treats zero as a finite timeout', async () => {
  let timedOut = false

  await waitAsync(async () => false, {
    timeoutMs: 0,
    onTimeout: async () => {
      timedOut = true
    },
  })

  assert.equal(timedOut, true)
})

test('waitAsync without a deadline still respects a custom stop condition', async () => {
  let checks = 0
  let timedOut = false

  await waitAsync(async () => false, {
    timeoutMs: null,
    continueIf: async () => {
      checks += 1
      return checks < 2
    },
    onPending: async () => {},
    onTimeout: async () => {
      timedOut = true
    },
  })

  assert.equal(checks, 2)
  assert.equal(timedOut, true)
})
