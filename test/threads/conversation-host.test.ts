import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ServiceContainer } from '../../src/extensions/service-container.ts'
import { ExtensionResourceScope } from '../../src/extensions/scope-registration.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import {
  defineProviderHost,
  providerContributions,
  providerConversationUrlBindings,
  providerEndpointBindings,
} from '../../src/providers/provider-exchange.ts'
import {
  ProviderHost,
  type ProviderBinding,
} from '../../src/providers/provider-host.ts'
import { ConversationHost } from '../../src/threads/conversation-host.ts'
import {
  defineToolHost,
  toolContributions,
  toolHandlerBindings,
  ToolHost,
} from '../../src/tools/tool-host.ts'

test('ConversationHost owns the commit and promotes a Provider Tool request into the next leg', async (t) => {
  let exchangeCount = 0
  let secondLegMessages: readonly {
    readonly role: string
    readonly content: string
  }[] = []
  const registry = new ExtensionRegistry({
    generation: 'conversation-test',
    policies: [],
  })
  defineProviderHost(registry)
  defineToolHost(registry)
  registry.register(
    {
      id: 'test.conversation-package',
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
          binding: async () => async (input, _context) => {
            exchangeCount += 1
            if (exchangeCount === 2) secondLegMessages = input.messages
            const tool = exchangeCount === 1
            return {
              events: (async function* () {
                if (tool) {
                  yield {
                    type: 'tool.request' as const,
                    toolCallId: 'call-1',
                    name: 'echo_tool',
                    input: { value: 'from provider' },
                  }
                }
              })(),
              completion: Promise.resolve(
                tool
                  ? {
                      status: 'completed' as const,
                      text: '',
                      delivery: 'sent' as const,
                    }
                  : {
                      status: 'completed' as const,
                      text: 'final answer',
                      delivery: 'sent' as const,
                    }
              ),
              cancel: () => undefined,
            }
          },
        })
        api.bind(providerConversationUrlBindings, {
          id: 'test.provider.conversation-url',
          targetId: 'test.provider',
          binding: () => null,
        })
        api.contribute(toolContributions, {
          id: 'test.echo-tool',
          value: {
            id: 'test.echo-tool',
            descriptor: {
              name: 'echo_tool',
              description: 'Echo',
              inputSchema: {},
            },
            requiredCapabilities: [],
            handlerBindingId: 'test.echo-tool.handler',
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
        api.bind(toolHandlerBindings, {
          id: 'test.echo-tool.handler',
          targetId: 'test.echo-tool',
          binding: async (input) => ({ status: 'success', output: { input } }),
        })
      },
    }
  )
  const graph = registry.freeze()
  const root = new ResourceScope('conversation-test-root')
  const portalScope = new ExtensionResourceScope(
    'portal',
    'conversation-test',
    root
  )
  const providerHost = new ProviderHost({ graph, parent: root })
  const toolHost = new ToolHost({
    graph,
    parent: portalScope,
    services: new ServiceContainer(graph.servicePlan),
  })
  const conversations = new ConversationHost({ providerHost, toolHost, root })
  t.after(async () => await root.dispose())

  const thread = await conversations.open({
    providerId: 'test.provider',
    providerOwnerId: 'test.conversation-package',
    conversationId: 'remote-1',
    selectionRevision: 'selection-1',
    agentMode: null,
    agentStartup: 'resume',
  })
  const result = await conversations.send(thread.id, 'hello')

  assert.equal(exchangeCount, 2)
  assert.deepEqual(
    secondLegMessages.map((message) => message.role),
    ['user', 'assistant', 'tool']
  )
  assert.equal(result.turns[0]?.status, 'completed')
  assert.deepEqual(
    result.turns[0]?.items.map((item) => item.kind),
    ['user', 'assistant', 'tool.request', 'tool.result', 'assistant']
  )
})

test('ConversationHost reports both generation stop and Provider close failures', async (t) => {
  const root = new ResourceScope('conversation-close-test')
  t.after(async () => await root.dispose().catch(() => undefined))
  const exchangeStarted = Promise.withResolvers<void>()
  const eventStream = Promise.withResolvers<void>()
  const completion =
    Promise.withResolvers<
      import('../../src/providers/provider-exchange.ts').ProviderCompletion
    >()
  const binding: ProviderBinding = {
    providerId: 'test.provider',
    capabilities: [],
    scope: root.createChild('provider-binding'),
    conversationId: 'remote-close',
    conversationUrl: null,
    preflightInput: async () => ({ status: 'unknown' }),
    restore: async () => undefined,
    loadHistory: async () => ({ messages: [], complete: false, warning: null }),
    onUnexpectedClose: () => () => {},
    listCapabilities: async () => ({ capabilities: [], usage: '' }),
    executeCapability: async () => ({
      status: 'unsupported-provider',
      message: 'unsupported',
    }),
    exchange: async () => {
      exchangeStarted.resolve()
      return {
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                await eventStream.promise
                return { value: undefined, done: true as const }
              },
            }
          },
        },
        completion: completion.promise,
        cancel: () => {
          throw new Error('generation stop failed')
        },
      }
    },
    close: async () => {
      throw new Error('Provider close failed')
    },
  }
  const providerHost = {
    openBinding: async () => binding,
  }
  const conversations = new ConversationHost({
    // Focused structural fakes exercise only ConversationHost ownership here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    providerHost: providerHost as unknown as ProviderHost,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    toolHost: {} as unknown as ToolHost,
    root,
  })
  const thread = await conversations.open({
    providerId: 'test.provider',
    providerOwnerId: 'test.provider-package',
    selectionRevision: 'close-failure',
    agentMode: null,
    agentStartup: 'resume',
  })
  const sending = conversations.send(thread.id, 'wait')
  await exchangeStarted.promise

  await assert.rejects(conversations.close(thread.id), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /generation stop failed/)
    assert.match(String(error.errors[1]), /Provider close failed/)
    return true
  })

  eventStream.resolve()
  completion.resolve({
    status: 'canceled',
    message: 'closed',
    delivery: 'unknown',
  })
  await sending
})

test('ConversationHost reports Provider cancellation failure to the sender', async (t) => {
  const root = new ResourceScope('conversation-cancel-test')
  t.after(async () => await root.dispose().catch(() => undefined))
  const exchangeStarted = Promise.withResolvers<void>()
  const binding: ProviderBinding = {
    providerId: 'test.provider',
    capabilities: [],
    scope: root.createChild('provider-binding'),
    conversationId: 'remote-cancel',
    conversationUrl: null,
    preflightInput: async () => ({ status: 'unknown' }),
    restore: async () => undefined,
    loadHistory: async () => ({ messages: [], complete: false, warning: null }),
    onUnexpectedClose: () => () => {},
    listCapabilities: async () => ({ capabilities: [], usage: '' }),
    executeCapability: async () => ({
      status: 'unsupported-provider',
      message: 'unsupported',
    }),
    exchange: async () => {
      exchangeStarted.resolve()
      return {
        events: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => await new Promise(() => undefined),
            }
          },
        },
        completion: new Promise(() => undefined),
        cancel: () => {
          throw new Error('Provider cancellation failed')
        },
      }
    },
    close: async () => undefined,
  }
  const conversations = new ConversationHost({
    // Focused structural fakes exercise only ConversationHost ownership here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    providerHost: {
      openBinding: async () => binding,
    } as unknown as ProviderHost,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    toolHost: {} as unknown as ToolHost,
    root,
  })
  const thread = await conversations.open({
    providerId: 'test.provider',
    providerOwnerId: 'test.provider-package',
    selectionRevision: 'cancel-failure',
    agentMode: null,
    agentStartup: 'resume',
  })
  const controller = new AbortController()
  const sending = conversations.send(thread.id, 'wait', {
    signal: controller.signal,
  })
  await exchangeStarted.promise

  controller.abort(new Error('user canceled'))

  await assert.rejects(sending, /Provider cancellation failed/)
  assert.equal(conversations.get(thread.id)?.turns[0]?.status, 'canceled')
})
