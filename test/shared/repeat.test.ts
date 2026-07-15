import test from 'node:test'
import assert from 'node:assert/strict'

import { repeatAsync } from '../../src/shared/repeat.ts'

test('repeatAsync uses the default three-attempt policy', async () => {
  let value = 0
  const repeatedAttempts: number[] = []

  const results = await repeatAsync(async () => (value += 1), {
    onRepeat: async (attempt) => {
      repeatedAttempts.push(attempt)
    },
  })

  assert.deepEqual(results, [1, 2, 3])
  assert.deepEqual(repeatedAttempts, [1, 2, 3])
})

test('repeatAsync evaluates repeatIf before each attempt', async () => {
  const evaluatedAttempts: number[] = []
  let calls = 0

  const results = await repeatAsync(async () => (calls += 1), {
    repeatIf: async (attempt) => {
      evaluatedAttempts.push(attempt)
      return attempt < 2
    },
    onRepeat: async () => {},
  })

  assert.deepEqual(results, [1, 2])
  assert.deepEqual(evaluatedAttempts, [0, 1, 2])
})

test('repeatAsync can stop before invoking the operation', async () => {
  let called = false

  const results = await repeatAsync(
    async () => {
      called = true
      return 'unexpected'
    },
    { repeatIf: async () => false }
  )

  assert.deepEqual(results, [])
  assert.equal(called, false)
})
