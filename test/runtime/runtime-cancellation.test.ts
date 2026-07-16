import assert from 'node:assert/strict'
import test from 'node:test'

import {
  abortable,
  getAbortError,
  PortalAbortError,
  toError,
} from '../../src/runtime/runtime-cancellation.ts'

test('toError preserves Error instances and describes non-Error reasons', () => {
  const original = new Error('original')
  assert.equal(toError(original, 'fallback'), original)

  const fromString = toError('failed as text', 'fallback')
  assert.equal(fromString.message, 'failed as text')
  assert.equal(fromString.cause, 'failed as text')

  const fromNull = toError(null, 'fallback')
  assert.equal(fromNull.message, 'fallback')
  assert.equal(fromNull.cause, null)
})

test('getAbortError preserves portal cancellations and normalizes Error reasons', () => {
  const portalError = new PortalAbortError('already normalized')
  const portalController = new AbortController()
  portalController.abort(portalError)
  assert.equal(getAbortError(portalController.signal), portalError)

  const errorController = new AbortController()
  errorController.abort(new Error('cancelled externally'))
  const normalized = getAbortError(errorController.signal)
  assert.ok(normalized instanceof PortalAbortError)
  assert.equal(normalized.message, 'cancelled externally')
})

test('abortable converts non-Error rejections with and without a signal', async () => {
  const controller = new AbortController()
  const results = [
    // Intentionally models a third-party Promise that rejects with a string.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    abortable(Promise.reject('string rejection')),
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    abortable(Promise.reject('string rejection'), controller.signal),
  ]

  for (const result of results) {
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'string rejection')
      assert.equal(error.cause, 'string rejection')
      return true
    })
  }
})
