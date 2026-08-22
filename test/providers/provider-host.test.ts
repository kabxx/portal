import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'
import {
  providerContributionSpec,
  providerContributions,
  providerConversationUrlBindingSpec,
  providerConversationUrlBindings,
  providerEndpointBindingSpec,
  providerEndpointBindings,
  type ProviderCompletion,
  type ProviderEndpoint,
  type ProviderEvent,
  type ProviderEndpointFactory,
  type ProviderExchangeHandle,
} from '../../src/providers/provider-exchange.ts'
import {
  ProviderHost,
  ProviderHostError,
} from '../../src/providers/provider-host.ts'
import { promptSkillService } from '../../src/skills/skill-services.ts'
import type { AttachmentReader } from '../../src/attachments/attachment-contracts.ts'

const RESUME_BINDING = Object.freeze({
  agentMode: null,
  agentStartup: 'resume' as const,
})

function createHost(
  factory: ProviderEndpointFactory,
  resolveConversationUrl: (value: string) => string | null = () => null,
  attachmentReader?: AttachmentReader
): {
  readonly host: ProviderHost
  readonly root: ResourceScope
} {
  const registry = new ExtensionRegistry({
    generation: 'provider-test',
    policies: [],
  })
  registry.defineContribution(providerContributionSpec)
  registry.defineService(promptSkillService)
  registry.defineExecutableBinding(providerEndpointBindingSpec)
  registry.defineExecutableBinding(providerConversationUrlBindingSpec)
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
              aliases: [],
              models: [],
              capabilities: [],
            },
            endpointBindingId: 'test.provider.endpoint',
            conversationUrlBindingId: 'test.provider.conversation-url',
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
        api.bind(providerEndpointBindings, {
          id: 'test.provider.endpoint',
          targetId: 'test.provider',
          binding: factory,
        })
        api.bind(providerConversationUrlBindings, {
          id: 'test.provider.conversation-url',
          targetId: 'test.provider',
          binding: resolveConversationUrl,
        })
      },
    }
  )
  const root = new ResourceScope('provider-test-root')
  return {
    host: new ProviderHost({
      graph: registry.freeze(),
      parent: root,
      ...(attachmentReader === undefined ? {} : { attachmentReader }),
    }),
    root,
  }
}

test('ProviderHost resolves conversation URLs through the owning Provider binding', async (t) => {
  const { host, root } = createHost(
    async () => async () => ({
      events: (async function* () {})(),
      completion: Promise.resolve({
        status: 'completed',
        text: '',
        delivery: 'not-sent',
      }),
      cancel: () => undefined,
    }),
    (value) => (value === 'provider://conversation/1' ? value : null)
  )
  t.after(async () => await root.dispose())

  assert.deepEqual(host.resolveConversationUrl('provider://conversation/1'), {
    provider: 'test.provider',
    conversationUrl: 'provider://conversation/1',
  })
  assert.equal(host.resolveConversationUrl('provider://unknown'), null)
})

test('ProviderHost rejects session capability requests without a Provider session control', async (t) => {
  const { host, root } = createHost(async () => async () => ({
    events: (async function* (): AsyncGenerator<ProviderEvent> {})(),
    completion: Promise.resolve({
      status: 'completed',
      text: '',
      delivery: 'not-sent',
    }),
    cancel: () => undefined,
  }))
  t.after(async () => await root.dispose())
  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'preflight',
    RESUME_BINDING
  )

  await assert.rejects(
    binding.preflightInput('input'),
    /does not expose the requested session capability/
  )
})

test('ProviderHost exposes an explicit resumed binding to Provider plugins', async (t) => {
  let observedStartup: string | null = null
  const { host, root } = createHost(async (context) => {
    observedStartup = context.agentStartup
    assert.equal(
      await context.openAgentSession({ tools: null, textToolProtocol: null }),
      null
    )
    return async () => ({
      events: (async function* (): AsyncGenerator<ProviderEvent> {})(),
      completion: Promise.resolve<ProviderCompletion>({
        status: 'completed',
        text: '',
        delivery: 'not-sent',
      }),
      cancel: () => undefined,
    })
  })
  t.after(async () => await root.dispose())

  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'explicit-resume',
    RESUME_BINDING
  )
  assert.equal(observedStartup, 'resume')
  await binding.close()
})

test('ProviderHost rejects inconsistent Agent startup selections', async (t) => {
  let factoryCalls = 0
  const { host, root } = createHost(async () => {
    factoryCalls += 1
    throw new Error('must not run')
  })
  t.after(async () => await root.dispose())

  await assert.rejects(
    host.openBinding('test.provider', 'test.provider-package', 'invalid', {
      agentMode: 'agent',
      agentStartup: 'resume',
    }),
    /invalid Agent startup selection/
  )
  assert.equal(factoryCalls, 0)
})

test('ProviderHost checks Agent availability before invoking the endpoint factory', async (t) => {
  let factoryCalls = 0
  const { host, root } = createHost(async () => {
    factoryCalls += 1
    throw new Error('must not run')
  })
  t.after(async () => await root.dispose())

  await assert.rejects(
    host.openBinding(
      'test.provider',
      'test.provider-package',
      'missing-agent',
      {
        agentMode: 'agent',
        agentStartup: 'interactive',
      }
    ),
    /no Agent Host/
  )
  assert.equal(factoryCalls, 0)
})

test('ProviderHost waits for and closes a late endpoint after binding cancellation', async () => {
  const factoryStarted = Promise.withResolvers<void>()
  const endpointDeferred = Promise.withResolvers<ProviderEndpoint>()
  let closeCalls = 0
  const { host, root } = createHost(async () => {
    factoryStarted.resolve()
    return await endpointDeferred.promise
  })
  const opening = host.openBinding(
    'test.provider',
    'test.provider-package',
    '1',
    RESUME_BINDING
  )
  void opening.catch(() => undefined)
  await factoryStarted.promise
  const reason = new PortalAbortError('cancel Provider binding')
  const disposing = root.dispose({ reason })
  endpointDeferred.resolve(
    Object.assign(
      async () => ({
        events: (async function* () {})(),
        completion: Promise.resolve({
          status: 'completed' as const,
          text: '',
          delivery: 'not-sent' as const,
        }),
        cancel: () => undefined,
      }),
      {
        close: async () => {
          closeCalls += 1
        },
      }
    )
  )

  await assert.rejects(opening, /cancel Provider binding/)
  await disposing
  assert.equal(closeCalls, 1)
})

test('ProviderHost binding cancellation does not wait for a never-settling factory', async (t) => {
  const factoryStarted = Promise.withResolvers<void>()
  const endpointDeferred = Promise.withResolvers<ProviderEndpoint>()
  const { host, root } = createHost(async () => {
    factoryStarted.resolve()
    return await endpointDeferred.promise
  })
  t.after(async () => {
    endpointDeferred.resolve(
      Object.assign(
        async () => ({
          events: (async function* () {})(),
          completion: Promise.resolve({
            status: 'canceled' as const,
            message: 'test cleanup',
            delivery: 'unknown' as const,
          }),
          cancel: () => undefined,
        }),
        { close: async () => undefined }
      )
    )
    await root.dispose()
  })

  const opening = host.openBinding(
    'test.provider',
    'test.provider-package',
    'never-settles',
    RESUME_BINDING
  )
  void opening.catch(() => undefined)
  await factoryStarted.promise

  const disposing = root.dispose({
    reason: new PortalAbortError('cancel Provider binding'),
  })
  const outcome = await Promise.race([
    opening.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    ),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 100)
    }),
  ])
  assert.equal(outcome, 'rejected')

  endpointDeferred.resolve(
    Object.assign(
      async () => ({
        events: (async function* () {})(),
        completion: Promise.resolve({
          status: 'canceled' as const,
          message: 'test cleanup',
          delivery: 'unknown' as const,
        }),
        cancel: () => undefined,
      }),
      { close: async () => undefined }
    )
  )
  await disposing
})

test('ProviderHost request cancellation aborts binding creation and closes a late endpoint once', async (t) => {
  const factoryStarted = Promise.withResolvers<AbortSignal>()
  const endpointDeferred = Promise.withResolvers<ProviderEndpoint>()
  let closeCalls = 0
  const { host, root } = createHost(async (context) => {
    factoryStarted.resolve(context.signal)
    return await endpointDeferred.promise
  })
  t.after(async () => {
    endpointDeferred.resolve(
      Object.assign(
        async () => ({
          events: (async function* () {})(),
          completion: Promise.resolve({
            status: 'canceled' as const,
            message: 'late cleanup',
            delivery: 'unknown' as const,
          }),
          cancel: () => undefined,
        }),
        {
          close: async () => {
            closeCalls += 1
          },
        }
      )
    )
    await root.dispose().catch(() => undefined)
  })
  const controller = new AbortController()
  const opening = host.openBinding(
    'test.provider',
    'test.provider-package',
    'request-cancel',
    { ...RESUME_BINDING, signal: controller.signal }
  )
  void opening.catch(() => undefined)
  const providerSignal = await factoryStarted.promise

  controller.abort(new PortalAbortError('cancel request'))

  await assert.rejects(opening, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'AbortError')
    assert.match(error.message, /cancel request/)
    return true
  })
  assert.equal(providerSignal.aborted, true)

  endpointDeferred.resolve(
    Object.assign(
      async () => ({
        events: (async function* () {})(),
        completion: Promise.resolve({
          status: 'canceled' as const,
          message: 'late cleanup',
          delivery: 'unknown' as const,
        }),
        cancel: () => undefined,
      }),
      {
        close: async () => {
          closeCalls += 1
        },
      }
    )
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closeCalls, 1)
})

test('ProviderHost does not invoke a Provider factory for an already canceled request', async (t) => {
  let factoryCalls = 0
  const { host, root } = createHost(async () => {
    factoryCalls += 1
    throw new Error('Provider factory must not run.')
  })
  t.after(async () => await root.dispose().catch(() => undefined))
  const controller = new AbortController()
  controller.abort(new PortalAbortError('already canceled'))

  await assert.rejects(
    host.openBinding(
      'test.provider',
      'test.provider-package',
      'already-canceled',
      { ...RESUME_BINDING, signal: controller.signal }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      return true
    }
  )
  assert.equal(factoryCalls, 0)
})

test('ProviderHost detaches the request signal after binding creation', async (t) => {
  let endpointCloseCalls = 0
  const { host, root } = createHost(async () =>
    Object.assign(
      async () => ({
        events: (async function* () {})(),
        completion: Promise.resolve({
          status: 'completed' as const,
          text: '',
          delivery: 'not-sent' as const,
        }),
        cancel: () => undefined,
      }),
      {
        close: async () => {
          endpointCloseCalls += 1
        },
      }
    )
  )
  t.after(async () => await root.dispose())
  const controller = new AbortController()
  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'request-complete',
    { ...RESUME_BINDING, signal: controller.signal }
  )

  controller.abort(new PortalAbortError('late request cancellation'))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(binding.scope.state, 'open')
  assert.equal(endpointCloseCalls, 0)
  await binding.close()
  assert.equal(endpointCloseCalls, 1)
})

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
    '1',
    RESUME_BINDING
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
    '1',
    RESUME_BINDING
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
    host.openBinding('test.provider', 'other.owner', '1', RESUME_BINDING),
    ProviderHostError
  )
  assert.equal(factoryCalls, 0)
})

test('ProviderHost cancels exchange creation and disposes a late handle', async (t) => {
  let resolveEndpoint!: (handle: ProviderExchangeHandle) => void
  let cancelCalls = 0
  const { host, root } = createHost(async () => {
    return async (_input, _context) =>
      await new Promise<ProviderExchangeHandle>((resolve) => {
        resolveEndpoint = resolve
      })
  })
  t.after(async () => await root.dispose())

  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'creation-cancel',
    RESUME_BINDING
  )
  const controller = new AbortController()
  const exchange = binding.exchange(
    {
      exchangeId: 'exchange-creation-cancel',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'cancel creation' }],
      attachments: [],
    },
    controller.signal
  )
  controller.abort(new Error('cancel creation'))
  await assert.rejects(exchange, ProviderHostError)

  resolveEndpoint({
    events: (async function* (): AsyncGenerator<ProviderEvent> {})(),
    completion: Promise.reject<ProviderCompletion>(
      new Error('late creation completion failure')
    ),
    cancel: () => {
      cancelCalls += 1
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cancelCalls, 1)
})

test('ProviderHost releases attachments when exchange creation fails', async (t) => {
  const released: string[] = []
  const attachment = Object.freeze({
    id: 'attachment:abc',
    mediaType: 'image/png',
    sizeBytes: 3,
    sha256: 'abc',
  })
  const endpoint: ProviderEndpoint = async () => {
    throw new Error('exchange creation failed')
  }
  const { host, root } = createHost(
    async () => endpoint,
    () => null,
    {
      read: async () => new Uint8Array([1, 2, 3]),
      release: (ref) => {
        released.push(ref.id)
      },
    }
  )
  t.after(async () => await root.dispose())
  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'attachment-failure',
    RESUME_BINDING
  )

  await assert.rejects(
    binding.exchange({
      exchangeId: 'exchange-attachment-failure',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'fail' }],
      attachments: [attachment],
    }),
    /exchange creation failed/
  )
  assert.deepEqual(released, [attachment.id])
})

test('ProviderHost reports both exchange and cancellation cleanup failures', async (t) => {
  const { host, root } = createHost(async () => async () => ({
    events: (async function* (): AsyncGenerator<ProviderEvent> {})(),
    completion: Promise.reject<ProviderCompletion>(
      new Error('provider exchange failed')
    ),
    cancel: () => {
      throw new Error('provider cancellation failed')
    },
  }))
  t.after(async () => await root.dispose().catch(() => undefined))
  const binding = await host.openBinding(
    'test.provider',
    'test.provider-package',
    'cleanup-failure',
    RESUME_BINDING
  )
  const exchange = await binding.exchange({
    exchangeId: 'exchange-cleanup-failure',
    conversationId: 'conversation-1',
    messages: [{ role: 'user', content: 'fail' }],
    attachments: [],
  })

  await assert.rejects(exchange.completion, (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /provider exchange failed/)
    const cleanup: unknown = error.errors[1] as unknown
    assert.ok(cleanup instanceof AggregateError)
    assert.match(
      cleanup.errors
        .map((item) =>
          item instanceof Error ? `${item} ${String(item.cause)}` : String(item)
        )
        .join('\n'),
      /provider cancellation failed/
    )
    return true
  })
})
