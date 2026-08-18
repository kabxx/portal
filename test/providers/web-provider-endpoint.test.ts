import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserContext } from 'playwright'

import { PORTAL_ACTION_PROTOCOL } from '../../src/providers/portal-action-protocol.ts'
import {
  createWebProviderEndpoint,
  decodeWebProviderResponse,
} from '../../src/providers/web-provider-endpoint.ts'
import {
  createBrowserContextStub,
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'
import { createTestToolRegistry } from '../helpers/tool-host.ts'
import {
  ProviderAdapter,
  ProviderAdapterError,
  type AbortOptions,
} from '../../src/providers/adapters/adapter-base.ts'
import type { ProviderEndpointFactory } from '../../src/providers/provider-exchange.ts'
import type { ProviderEndpointContext } from '../../src/providers/provider-exchange.ts'
import type { ServiceAccessor } from '../../src/extensions/extension-contracts.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { createTestToolHost } from '../helpers/tool-host.ts'

class StreamingAdapter extends ProviderAdapter {
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<string>()
  readonly snapshots: string[] = []

  public get conversationId(): string | null {
    return 'conversation-1'
  }

  public get conversationUrl(): string {
    return 'https://example.com/conversation-1'
  }

  public async restore(): Promise<void> {}

  public async isLoggedIn(): Promise<boolean> {
    return true
  }

  public async changeModel(): Promise<void> {}

  public async attachText(): Promise<void> {}

  public async attachFile(): Promise<void> {}

  public async attachImage(): Promise<void> {}

  public async submit(_options?: AbortOptions): Promise<string> {
    this.started.resolve()
    return await this.release.promise
  }

  public publishSnapshot(text: string): void {
    this.snapshots.push(text)
    void this.emitSubmitText(text)
  }
}

function endpointContext(
  signal: AbortSignal
): Parameters<ProviderEndpointFactory>[0] {
  return {
    providerId: 'chatgpt',
    agentMode: null,
    agentStartup: 'resume',
    scope: { name: 'test-exchange', signal },
    signal,
    readAttachment: async () => new Uint8Array(),
    services: {
      get: async () => {
        throw new Error('Unexpected service lookup in endpoint test.')
      },
    } satisfies ServiceAccessor,
    conversationUrl: null,
    model: null,
    workingDirectory: process.cwd(),
    spawnDepth: 0,
    sessionKey: null,
    emit: () => undefined,
    openAgentSession: async () => null,
  }
}

function exchangeContext(
  signal: AbortSignal,
  exchangeId: string
): ProviderEndpointContext {
  return {
    exchangeId,
    signal,
    scope: { name: `test:${exchangeId}`, signal },
    readAttachment: async () => new Uint8Array(),
  }
}

test('web Provider forwards reporter snapshots before submission completion', async () => {
  const adapter = new StreamingAdapter(createBrowserContextStub())
  const root = new ResourceScope('endpoint-test')
  const tools = createTestToolHost(adapter, [])
  const runtime = createFakeRuntime({ adapter })
  const endpoint = await createWebProviderEndpoint(
    'chatgpt',
    endpointContext(root.signal),
    {
      // The custom adapter factory does not use this browser value.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      context: createBrowserContextStub() as unknown as BrowserContext,
      tools,
      createAdapter: async () => adapter,
      createRuntime: async () => runtime,
    }
  )

  const handle = await endpoint(
    {
      exchangeId: 'exchange-1',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'hello' }],
      attachments: [],
    },
    exchangeContext(root.signal, 'exchange-1')
  )
  const iterator = handle.events[Symbol.asyncIterator]()
  await adapter.started.promise

  const firstEvent = iterator.next()
  adapter.publishSnapshot('partial')
  assert.deepEqual(await firstEvent, {
    done: false,
    value: { type: 'text.delta', text: 'partial' },
  })

  let completed = false
  void handle.completion.then(() => {
    completed = true
  })
  await Promise.resolve()
  assert.equal(completed, false)

  adapter.publishSnapshot('partial response')
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text.delta', text: 'partial response' },
  })
  adapter.release.resolve('partial response')

  assert.deepEqual(await handle.completion, {
    status: 'completed',
    text: 'partial response',
    delivery: 'sent',
  })
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })
  await endpoint.close?.()
  await root.dispose()
})

test('web Provider resets a partial stream before a retry attempt', async () => {
  const adapter = new StreamingAdapter(createBrowserContextStub())
  const staleTextReporters: Array<(message: string) => void | Promise<void>> =
    []
  const setTextReporter = adapter.setSubmitTextReporter.bind(adapter)
  adapter.setSubmitTextReporter = (reporter) => {
    if (reporter !== null) staleTextReporters.push(reporter)
    setTextReporter(reporter)
  }
  let attempts = 0
  adapter.submit = async function submit(
    _options?: AbortOptions
  ): Promise<string> {
    attempts += 1
    this.started.resolve()
    if (attempts === 1) {
      this.publishSnapshot('old response')
      throw new ProviderAdapterError('submit', 'retry', {
        kind: 'transient',
        recovery: 'retry',
        retryable: true,
        maxAttempts: 2,
      })
    }
    if (staleTextReporters[0] !== undefined) {
      await staleTextReporters[0]('late old response')
    }
    this.publishSnapshot('new response')
    return 'new response'
  }
  const root = new ResourceScope('endpoint-retry-test')
  const endpoint = await createWebProviderEndpoint(
    'chatgpt',
    endpointContext(root.signal),
    {
      // The custom adapter factory does not use this browser value.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      context: createBrowserContextStub() as unknown as BrowserContext,
      tools: createTestToolHost(adapter, []),
      createAdapter: async () => adapter,
      createRuntime: async () => createFakeRuntime({ adapter }),
    }
  )
  const handle = await endpoint(
    {
      exchangeId: 'exchange-retry',
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'hello' }],
      attachments: [],
    },
    exchangeContext(root.signal, 'exchange-retry')
  )
  const events: unknown[] = []
  for await (const event of handle.events) events.push(event)
  assert.deepEqual(events, [
    { type: 'text.delta', text: 'old response' },
    { type: 'text.reset' },
    { type: 'text.delta', text: 'new response' },
  ])
  assert.equal((await handle.completion).status, 'completed')
  await endpoint.close?.()
  await root.dispose()
})

test('web Provider rejects an Action without a name instead of creating an unknown Tool request', async () => {
  const adapter = createProviderAdapterStub()
  const tools = createTestToolRegistry(adapter, [], {
    protocol: PORTAL_ACTION_PROTOCOL,
  })

  await assert.rejects(
    decodeWebProviderResponse(
      '<action>{"value":"input"}</action>',
      'exchange-1',
      tools
    ),
    /invalid Action payload/
  )
})
