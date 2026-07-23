import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalizeConversationUrl,
  ConversationAlreadyClaimedError,
  ConversationReservationError,
  InvalidConversationUrlError,
  ThreadRemovalStateError,
  ThreadRuntimeRegistry,
  ThreadStateTransitionError,
} from '../../src/threads/thread-runtime-registry.ts'

test('ThreadRuntimeRegistry reserves canonical URLs for one provisioning operation', () => {
  const registry = new ThreadRuntimeRegistry<object>()
  const canonical = registry.reserveConversationUrl(
    'operation-1',
    'HTTPS://Example.COM/c/one/#section'
  )

  assert.equal(canonical, 'https://example.com/c/one')
  assert.throws(
    () =>
      registry.reserveConversationUrl(
        'operation-2',
        'https://example.com/c/one/'
      ),
    ConversationReservationError
  )
  assert.equal(registry.releaseConversationUrl('operation-2', canonical), false)
  assert.equal(registry.releaseConversationUrl('operation-1', canonical), true)
})

test('ThreadRuntimeRegistry commits runtime and URL claim in one synchronous step', () => {
  const registry = new ThreadRuntimeRegistry<{ name: string }>()
  const runtime = { name: 'runtime-1' }
  registry.reserveConversationUrl('operation-1', 'https://chatgpt.com/c/one/')

  const snapshot = registry.commitPrepared({
    id: 't-1',
    reservationOwnerId: 'operation-1',
    provider: 'chatgpt',
    runtime,
    origin: 'resumed',
    source: 'api',
    conversationId: 'one',
    conversationUrl: 'https://chatgpt.com/c/one#latest',
    history: { status: 'complete' },
    createdAt: 10,
  })

  assert.equal(snapshot.conversationUrl, 'https://chatgpt.com/c/one')
  assert.equal(registry.get('t-1')?.runtime, runtime)
  assert.equal(
    registry.getThreadIdByConversationUrl('https://chatgpt.com/c/one/'),
    't-1'
  )
  assert.deepEqual(
    registry.list().map(({ snapshot: thread }) => thread.id),
    ['t-1']
  )
})

test('ThreadRuntimeRegistry releases stale reservations after a redirected commit', () => {
  const registry = new ThreadRuntimeRegistry<object>()
  registry.reserveConversationUrl(
    'operation-1',
    'https://chatgpt.com/c/before-redirect'
  )

  registry.commitPrepared({
    id: 't-1',
    reservationOwnerId: 'operation-1',
    provider: 'chatgpt',
    runtime: {},
    origin: 'resumed',
    source: 'api',
    conversationUrl: 'https://chatgpt.com/c/after-redirect',
  })

  assert.doesNotThrow(() =>
    registry.reserveConversationUrl(
      'operation-2',
      'https://chatgpt.com/c/before-redirect'
    )
  )
})

test('ThreadRuntimeRegistry rejects duplicate claims and releases a closed URL', () => {
  const registry = new ThreadRuntimeRegistry<object>()
  registry.commitPrepared({
    id: 't-1',
    provider: 'gemini',
    runtime: {},
    origin: 'new',
    source: 'tui',
    conversationUrl: 'https://gemini.google.com/app/one',
  })

  assert.throws(
    () =>
      registry.commitPrepared({
        id: 't-2',
        provider: 'gemini',
        runtime: {},
        origin: 'resumed',
        source: 'mcp',
        conversationUrl: 'https://gemini.google.com/app/one/',
      }),
    ConversationAlreadyClaimedError
  )

  assert.throws(() => registry.remove('t-1'), ThreadRemovalStateError)
  registry.setState('t-1', 'closing')
  const removed = registry.remove('t-1')
  assert.equal(removed?.snapshot.state, 'closed')
  assert.equal(
    registry.getThreadIdByConversationUrl('https://gemini.google.com/app/one'),
    null
  )

  assert.doesNotThrow(() =>
    registry.commitPrepared({
      id: 't-2',
      provider: 'gemini',
      runtime: {},
      origin: 'resumed',
      source: 'mcp',
      conversationUrl: 'https://gemini.google.com/app/one',
    })
  )
})

test('ThreadRuntimeRegistry validates URLs and does not expose mutable snapshots', () => {
  const registry = new ThreadRuntimeRegistry<object>()
  assert.equal(canonicalizeConversationUrl('file:///tmp/conversation'), null)
  assert.throws(
    () => registry.reserveConversationUrl('operation-1', 'not a URL'),
    InvalidConversationUrlError
  )

  registry.commitPrepared({
    id: 't-1',
    provider: 'qwen',
    runtime: {},
    origin: 'new',
    source: 'system',
    history: {
      status: 'incomplete',
      reasonCode: 'partial',
      message: 'partial',
    },
    createdAt: 1,
  })
  const snapshot = registry.getSnapshot('t-1')
  assert.ok(snapshot)
  snapshot.state = 'closed'
  assert.equal(registry.getSnapshot('t-1')?.state, 'idle')
})

test('ThreadRuntimeRegistry enforces registered thread state transitions', () => {
  const registry = new ThreadRuntimeRegistry<object>()
  registry.commitPrepared({
    id: 't-1',
    provider: 'glm',
    runtime: {},
    origin: 'new',
    source: 'tui',
  })

  assert.equal(registry.setState('t-1', 'running')?.state, 'running')
  assert.equal(registry.setState('t-1', 'cancelling')?.state, 'cancelling')
  assert.equal(registry.setState('t-1', 'idle')?.state, 'idle')
  assert.throws(
    () => registry.setState('t-1', 'closed'),
    ThreadStateTransitionError
  )
})
