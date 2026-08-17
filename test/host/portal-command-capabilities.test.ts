import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeWebProviderCapability,
  listWebProviderCapabilities,
} from '../../src/providers/web-provider-capabilities.ts'
import type { FirstPartyProviderId as ProviderId } from '../../src/providers/first-party-provider-id.ts'
import type { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import { ProviderAdapterUnsupportedError } from '../../src/providers/adapters/adapter-base.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'

async function listPortalCommandCapabilities(
  provider: ProviderId,
  runtime: RuntimeCore,
  signal: AbortSignal
) {
  return {
    provider,
    ...(await listWebProviderCapabilities(provider, runtime, signal)),
  }
}

async function executePortalCommandCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string,
  args: readonly string[],
  signal: AbortSignal
) {
  const outcome = await executeWebProviderCapability(
    provider,
    runtime,
    name,
    args,
    signal
  )
  return {
    status: outcome.status,
    title: '/thread capability',
    body: outcome.message,
    format: 'plain',
  }
}

test('action capability adapter lists, selects, clears, and maps terminal states', async () => {
  const selected: string[] = []
  let cleared = 0
  let selection: 'selected' | 'disabled' | 'unavailable' = 'selected'
  const adapter = Object.assign(createProviderAdapterStub(), {
    listActionCapabilities: async () => [
      { name: 'web_search', state: 'available' as const },
    ],
    selectActionCapability: async (name: string) => {
      selected.push(name)
      return selection
    },
    clearActionCapability: async () => {
      cleared += 1
    },
  })
  const runtime = createFakeRuntime({ adapter })
  const signal = new AbortController().signal

  assert.deepEqual(
    await listPortalCommandCapabilities('chatgpt', runtime, signal),
    {
      provider: 'chatgpt',
      capabilities: [{ name: 'web_search', state: 'available' }],
      usage: '/thread capability <capability>',
    }
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'chatgpt',
        runtime,
        'web_search',
        [],
        signal
      )
    ).status,
    'ok'
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'chatgpt',
        runtime,
        'missing',
        [],
        signal
      )
    ).status,
    'unknown-capability'
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'chatgpt',
        runtime,
        'none',
        [],
        signal
      )
    ).body,
    'chatgpt.none: cleared'
  )
  selection = 'disabled'
  assert.match(
    (
      await executePortalCommandCapability(
        'chatgpt',
        runtime,
        'web_search',
        [],
        signal
      )
    ).body,
    /disabled/
  )
  selection = 'unavailable'
  assert.match(
    (
      await executePortalCommandCapability(
        'chatgpt',
        runtime,
        'web_search',
        [],
        signal
      )
    ).body,
    /not available/
  )
  assert.deepEqual(selected, ['web_search', 'web_search', 'web_search'])
  assert.equal(cleared, 1)
})

test('toggle capability adapter filters availability and validates actions', async () => {
  const stateCalls: string[] = []
  const adapter = Object.assign(createProviderAdapterStub(), {
    hasToggleCapability: async (name: string) => name === 'thinking',
    getToggleState: async (name: string) => {
      stateCalls.push(`get:${name}`)
      return 'off' as const
    },
    setToggleState: async (name: string, state: 'on' | 'off') => {
      stateCalls.push(`set:${name}:${state}`)
      return state
    },
  })
  const runtime = createFakeRuntime({ adapter })
  const signal = new AbortController().signal

  assert.deepEqual(
    await listPortalCommandCapabilities('deepseek', runtime, signal),
    {
      provider: 'deepseek',
      capabilities: [{ name: 'thinking', state: 'off' }],
      usage: '/thread capability <capability> <on|off|status>',
    }
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'deepseek',
        runtime,
        'thinking',
        ['on'],
        signal
      )
    ).body,
    'deepseek.thinking: on'
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'deepseek',
        runtime,
        'thinking',
        ['status'],
        signal
      )
    ).body,
    'deepseek.thinking: off'
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'deepseek',
        runtime,
        'search',
        ['on'],
        signal
      )
    ).status,
    'unsupported-provider'
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'deepseek',
        runtime,
        'thinking',
        [],
        signal
      )
    ).status,
    'invalid-args'
  )
  assert.deepEqual(stateCalls, [
    'get:thinking',
    'set:thinking:on',
    'get:thinking',
  ])
})

test('Kimi unsupported toggles are hidden and command operations honor cancellation', async () => {
  const adapter = Object.assign(createProviderAdapterStub(), {
    hasToggleCapability: async () => true,
    getToggleState: async () => {
      throw new ProviderAdapterUnsupportedError('get search', 'unavailable')
    },
    setToggleState: async () => {
      throw new ProviderAdapterUnsupportedError('set search', 'unavailable')
    },
  })
  const runtime = createFakeRuntime({ adapter })
  const signal = new AbortController().signal

  assert.deepEqual(
    (await listPortalCommandCapabilities('kimi', runtime, signal)).capabilities,
    []
  )
  assert.equal(
    (
      await executePortalCommandCapability(
        'kimi',
        runtime,
        'search',
        ['on'],
        signal
      )
    ).status,
    'unsupported-provider'
  )

  const deferred =
    Promise.withResolvers<Array<{ name: string; state: 'available' }>>()
  const cancellableAdapter = Object.assign(createProviderAdapterStub(), {
    listActionCapabilities: async () => await deferred.promise,
    selectActionCapability: async () => 'selected' as const,
  })
  const cancellableRuntime = createFakeRuntime({
    adapter: cancellableAdapter,
  })
  const controller = new AbortController()
  const pending = listPortalCommandCapabilities(
    'chatgpt',
    cancellableRuntime,
    controller.signal
  )
  controller.abort(new Error('cancel capability'))
  await assert.rejects(pending, /cancel capability/)
  deferred.resolve([])
})
