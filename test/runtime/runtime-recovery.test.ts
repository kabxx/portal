import test from 'node:test'
import assert from 'node:assert/strict'

import { ProviderAdapterError } from '../../src/providers/adapters/adapter-base.ts'
import {
  buildRuntimeRecoveryPlan,
  tryRestoreRuntimeForRecovery,
} from '../../src/runtime/runtime-recovery.ts'

test('buildRuntimeRecoveryPlan marks auth errors as login-required and retryable', () => {
  const plan = buildRuntimeRecoveryPlan(
    new ProviderAdapterError('restore', 'Gemini is not logged in.', {
      kind: 'auth',
      recovery: 'none',
      retryable: false,
      maxAttempts: 1,
    }),
    {
      provider: 'gemini',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-1',
    }
  )

  assert.equal(plan.requiresLogin, true)
  assert.equal(plan.canRetry, true)
  assert.equal(plan.showFallbackError, false)
  assert.match(plan.lines.join('\n'), /Complete login/)
})

test('buildRuntimeRecoveryPlan marks transient adapter errors as retryable', () => {
  const plan = buildRuntimeRecoveryPlan(
    new ProviderAdapterError('submit', 'Temporary page issue.', {
      kind: 'transient',
      recovery: 'restore',
      retryable: true,
      maxAttempts: 2,
    }),
    {
      provider: 'chatgpt',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-2',
    }
  )

  assert.equal(plan.requiresLogin, false)
  assert.equal(plan.canRetry, true)
  assert.equal(plan.showFallbackError, false)
  assert.match(
    plan.lines.join('\n'),
    /Retrying the same request is usually safe/
  )
})

test('tryRestoreRuntimeForRecovery does not restore authentication errors', async () => {
  let restoreCalls = 0

  await tryRestoreRuntimeForRecovery(
    new ProviderAdapterError('submit', 'ChatGPT is not logged in.', {
      kind: 'auth',
      recovery: 'restore',
    }),
    async () => {
      restoreCalls += 1
    }
  )

  assert.equal(restoreCalls, 0)
})

test('buildRuntimeRecoveryPlan keeps non-retryable UI errors as thread errors', () => {
  const plan = buildRuntimeRecoveryPlan(
    new ProviderAdapterError(
      'selectCapability',
      'Doubao action bar state is unavailable.',
      {
        kind: 'ui',
        recovery: 'none',
        retryable: false,
        maxAttempts: 1,
        detailCode: 'doubao_action_bar_store_missing',
      }
    ),
    {
      provider: 'doubao',
      browserProfileDir: 'C:\\profiles\\chrome',
      threadId: 't-1',
    }
  )

  assert.equal(plan.title, 'thread error')
  assert.equal(plan.canRetry, false)
  assert.equal(plan.requiresLogin, false)
  assert.equal(plan.showFallbackError, true)
  assert.match(plan.lines.join('\n'), /request did not complete/)
})
