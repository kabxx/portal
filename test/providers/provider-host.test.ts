import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import {
  providerContributionSpec,
  providerContributions,
  providerEndpointBindingSpec,
  providerEndpointBindings,
  type ProviderCompletion,
  type ProviderEvent,
  type ProviderEndpointFactory,
} from '../../src/providers/provider-exchange.ts'
import {
  ProviderHost,
  ProviderHostError,
} from '../../src/providers/provider-host.ts'

function createHost(factory: ProviderEndpointFactory): {
  readonly host: ProviderHost
  readonly root: ResourceScope
} {
  const registry = new ExtensionRegistry({
    generation: 'provider-test',
    policies: [],
  })
  registry.defineContribution(providerContributionSpec)
  registry.defineExecutableBinding(providerEndpointBindingSpec)
  registry.register(
    {
      id: 'test.provider-package',
      version: '1.0.0',
      dependencies: [],
      capabilities: [],
    },
    {
      register(api) {
        api.contribute(providerContributions, {
          id: 'test.provider',
          value: {
            id: 'test.provider',
            descriptor: {
              label: 'Test Provider',
              capabilities: [],
            },
            endpointBindingId: 'test.provider.endpoint',
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
        api.bind(providerEndpointBindings, {
          id: 'test.provider.endpoint',
          targetId: 'test.provider',
          binding: factory,
        })
      },
    }
  )
  const root = new ResourceScope('provider-test-root')
  return {
    host: new ProviderHost({ graph: registry.freeze(), parent: root }),
    root,
  }
}

test('ProviderHost binds one owner endpoint and closes an exchange after provider completion', async (t) => {
  const events: ProviderEvent[] = []
  const { host, root } = createHost(async () => async () => ({
    events: (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'status', message: 'started' }
      yield { type: 'text.delta', text: 'hello' }
    })(),
    completion: Promise.resolve<ProviderCompletion>({
      status: 'completed',
      text: 'hello',
      delivery: 'sent',
    }),
    cancel: () => undefined,
  }))
  t.after(async () => await root.dispose())

  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    '1'
  )
  const exchange = await binding.exchange({
    exchangeId: 'exchange-1',
    conversationId: 'conversation-1',
    messages: [{ role: 'user', content: 'hello' }],
    attachments: [],
  })
  for await (const event of exchange.events) events.push(event)
  const completion = await exchange.completion

  assert.deepEqual(events, [
    { type: 'status', message: 'started' },
    { type: 'text.delta', text: 'hello' },
  ])
  assert.equal(completion.status, 'completed')
  assert.equal(binding.scope.state, 'open')
})

test('ProviderHost cancellation revokes exchange scope and observes a late completion', async (t) => {
  let cancelCalls = 0
  let resolveCompletion!: (completion: ProviderCompletion) => void
  const completion = new Promise<ProviderCompletion>((resolve) => {
    resolveCompletion = resolve
  })
  const { host, root } = createHost(async () => async () => ({
    events: (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'status', message: 'waiting' }
      await new Promise<void>(() => undefined)
    })(),
    completion,
    cancel: () => {
      cancelCalls += 1
    },
  }))
  t.after(async () => await root.dispose())

  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    '1'
  )
  const exchange = await binding.exchange({
    exchangeId: 'exchange-cancel',
    conversationId: 'conversation-1',
    messages: [{ role: 'user', content: 'cancel me' }],
    attachments: [],
  })
  await exchange.cancel(new Error('user canceled'))
  assert.equal(binding.scope.state, 'open')
  assert.equal(cancelCalls, 1)

  resolveCompletion({
    status: 'canceled',
    message: 'provider settled after cancellation',
    delivery: 'unknown',
  })
  assert.equal((await exchange.completion).status, 'canceled')
})

test('ProviderHost rejects binding ownership mismatches before invoking plugin code', async (t) => {
  let factoryCalls = 0
  const { host, root } = createHost(async () => {
    factoryCalls += 1
    throw new Error('must not run')
  })
  t.after(async () => await root.dispose())

  await assert.rejects(
    host.openBinding('test.provider', 'other.owner', '1'),
    ProviderHostError
  )
  assert.equal(factoryCalls, 0)
})
