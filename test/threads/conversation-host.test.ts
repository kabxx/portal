import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import {
  defineProviderHost,
  providerContributions,
  providerEndpointBindings,
} from '../../src/providers/provider-exchange.ts'
import { ProviderHost } from '../../src/providers/provider-host.ts'
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
            descriptor: { label: 'Test Provider', capabilities: [] },
            endpointBindingId: 'test.provider.endpoint',
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
  const providerHost = new ProviderHost({ graph, parent: root })
  const toolHost = new ToolHost({ graph, parent: root })
  const conversations = new ConversationHost({ providerHost, toolHost, root })
  t.after(async () => await root.dispose())

  const thread = await conversations.open({
    providerId: 'test.provider',
    providerOwnerId: 'test.conversation-package',
    conversationId: 'remote-1',
    selectionRevision: 'selection-1',
  })
  const result = await conversations.send(thread.id, 'hello')

  assert.equal(exchangeCount, 2)
  assert.deepEqual(
    secondLegMessages.map((message) => message.role),
    ['user', 'tool']
  )
  assert.equal(result.turns[0]?.status, 'completed')
  assert.deepEqual(
    result.turns[0]?.items.map((item) => item.kind),
    ['user', 'tool.request', 'tool.result', 'assistant']
  )
})
