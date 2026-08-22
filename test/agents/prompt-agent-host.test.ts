import assert from 'node:assert/strict'
import test from 'node:test'

import { PortalDomainRuntime } from '../../src/host/portal-domain-runtime.ts'
import { ExtensionResourceScope } from '../../src/extensions/scope-registration.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { createSkillPluginRegistration } from '../../src/skills/skill-plugin.ts'
import type { PromptSkillService } from '../../src/skills/skill-services.ts'
import {
  createPortalAgentPromptRegistration,
  createPortalChatPromptRegistration,
  buildPortalChatPrompt,
  PORTAL_AGENT_PROMPT_ID,
  PORTAL_AGENT_PROMPT_PACKAGE_ID,
} from '../../src/prompts/portal-prompt-plugin.ts'
import {
  createPortalAgentRegistration,
  createPortalChatAgentRegistration,
} from '../../src/agents/portal-agent-plugin.ts'
import {
  agentContributions,
  agentHistoryBindings,
  agentSessionBindings,
  type AgentSession,
  type AgentSessionFactory,
} from '../../src/agents/agent-extension.ts'
import { PORTAL_ACTION_PROTOCOL } from '../../src/providers/portal-action-protocol.ts'
import {
  promptContributions,
  promptRendererBindings,
  type PromptRendererFactory,
} from '../../src/prompts/prompt-extension.ts'
import type { ExtensionRegistrationApi } from '../../src/extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../../src/extensions/portal-hooks.ts'

function createRuntime() {
  const root = new ResourceScope('prompt-agent-test')
  const scope = new ExtensionResourceScope('portal', 'prompt-agent-test', root)
  const skills: PromptSkillService = {
    snapshot: async () => ({
      skills: Object.freeze([
        {
          name: 'review',
          description: 'Review changes.',
          manifestPath: 'C:\\skills\\review\\SKILL.md',
        },
      ]),
      projectInstructions: 'Keep changes focused.',
    }),
    add: async () => ({ skills: [], warnings: [] }),
    list: async () => ({ skills: [], issues: [] }),
    enable: async () => true,
    disable: async () => true,
    remove: async () => ({ removed: true, warnings: [] }),
  }
  const runtime = new PortalDomainRuntime({
    extensions: [
      createSkillPluginRegistration({ service: skills }),
      createPortalAgentPromptRegistration(),
      createPortalChatPromptRegistration(),
      createPortalAgentRegistration(),
      createPortalChatAgentRegistration(),
    ],
    parentScope: scope,
  })
  return { root, runtime }
}

test('PromptHost and AgentHost resolve graph sessions with immutable snapshots', async (t) => {
  const { root, runtime } = createRuntime()
  t.after(async () => await root.dispose())

  assert.deepEqual(
    runtime.prompts
      .list()
      .map(({ id }) => id)
      .sort(),
    ['portal.prompt.agent', 'portal.prompt.chat']
  )
  assert.deepEqual(
    runtime.agents
      .list()
      .map(({ id }) => id)
      .sort(),
    ['portal.agent.chat', 'portal.agent.default']
  )

  const agent = await runtime.agents.open({
    mode: 'agent',
    startup: 'interactive',
    tools: '### run_command',
    textToolProtocol: PORTAL_ACTION_PROTOCOL,
    workingDirectory: 'C:\\workspace',
  })
  assert.match(agent.initialization?.prompt ?? '', /## Portal Action Protocol/)
  assert.match(agent.initialization?.prompt ?? '', /## Skills/)
  assert.match(agent.initialization?.prompt ?? '', /## Project Instructions/)
  assert.deepEqual(Object.keys(agent.initialization ?? {}), ['prompt'])
  await agent.close?.()

  const chat = await runtime.agents.open({
    mode: 'chat',
    startup: 'interactive',
    tools: '### run_command',
    textToolProtocol: PORTAL_ACTION_PROTOCOL,
    workingDirectory: 'C:\\workspace',
  })
  assert.doesNotMatch(chat.initialization?.prompt ?? '', /## Actions|## Skills/)
  assert.match(chat.initialization?.prompt ?? '', /Reply exactly: READY/)
  await chat.close?.()
})

test('inline Agent policy renders only the first task through its Prompt', async (t) => {
  const { root, runtime } = createRuntime()
  t.after(async () => await root.dispose())

  const agent = await runtime.agents.open({
    mode: 'agent',
    startup: 'inline',
    tools: null,
    textToolProtocol: null,
    workingDirectory: '/workspace',
  })
  assert.equal(agent.initialization, null)
  assert.match(await agent.previewInput('first'), /## Task\n\nfirst/)
  assert.match(await agent.prepareInput('first'), /## Task\n\nfirst/)
  assert.equal(await agent.prepareInput('second'), 'second')
  await agent.close?.()
})

test('AgentHost applies plugin-owned history projection before Surfaces render it', async (t) => {
  const { root, runtime } = createRuntime()
  t.after(async () => await root.dispose())
  const projected = runtime.agents.projectHistory([
    {
      id: 'setup',
      parentId: null,
      role: 'user',
      text: buildPortalChatPrompt('/workspace'),
      format: 'plain',
      createdAt: 1,
    },
    {
      id: 'setup-response',
      parentId: 'setup',
      role: 'assistant',
      text: 'I have loaded the setup instructions.',
      format: 'markdown',
      createdAt: 2,
    },
    {
      id: 'question',
      parentId: 'setup-response',
      role: 'user',
      text: 'Hello.',
      format: 'plain',
      createdAt: 3,
    },
  ])
  assert.deepEqual(
    projected.map(({ id }) => id),
    ['question']
  )
})

test('AgentHost rejects a session without the required initialization contract', async (t) => {
  const root = new ResourceScope('invalid-agent-session-test')
  const scope = new ExtensionResourceScope('portal', 'invalid-agent', root)
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration(),
      {
        descriptor: {
          id: 'test.invalid-agent',
          version: '1.0.0',
          dependencies: ['test.prompt'],
          capabilities: [],
        },
        module: {
          register(api) {
            api.contribute(agentContributions, {
              id: 'test.invalid-agent',
              value: {
                id: 'test.invalid-agent',
                descriptor: { label: 'Invalid Agent', mode: 'agent' },
                promptId: 'test.prompt',
                sessionBindingId: 'test.invalid-agent.session',
                historyBindingId: 'test.invalid-agent.history',
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.bind(agentSessionBindings, {
              id: 'test.invalid-agent.session',
              targetId: 'test.invalid-agent',
              binding: async () => {
                const validShape: AgentSession = {
                  initialization: null,
                  previewInput: async (input: string) => input,
                  prepareInput: async (input: string) => input,
                }
                return new Proxy(validShape, {
                  has: (target, property) =>
                    property === 'initialization'
                      ? false
                      : Reflect.has(target, property),
                })
              },
            })
            api.bind(agentHistoryBindings, {
              id: 'test.invalid-agent.history',
              targetId: 'test.invalid-agent',
              binding: () => [],
            })
          },
        },
      },
    ],
    parentScope: scope,
  })
  t.after(async () => await root.dispose())

  await assert.rejects(
    runtime.agents.open({
      mode: 'agent',
      startup: 'interactive',
      tools: null,
      textToolProtocol: null,
      workingDirectory: '/workspace',
    }),
    /did not return a valid session/
  )
})

test('Portal Agent keeps inline setup pending when Prompt rendering fails', async (t) => {
  const root = new ResourceScope('inline-prompt-failure-test')
  const scope = new ExtensionResourceScope('portal', 'inline-failure', root)
  let renderCalls = 0
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration({
        packageId: PORTAL_AGENT_PROMPT_PACKAGE_ID,
        promptId: PORTAL_AGENT_PROMPT_ID,
        render: async (task?: string) => {
          renderCalls += 1
          if (renderCalls === 1) throw new Error('prompt render failed')
          return task ?? 'setup'
        },
      }),
      createPortalAgentRegistration(),
    ],
    parentScope: scope,
  })
  t.after(async () => await root.dispose())

  const agent = await runtime.agents.open({
    mode: 'agent',
    startup: 'inline',
    tools: null,
    textToolProtocol: null,
    workingDirectory: '/workspace',
  })
  await assert.rejects(agent.prepareInput('first'), /prompt render failed/)
  assert.equal(await agent.prepareInput('second'), 'second')
  assert.equal(renderCalls, 2)
  await agent.close?.()
})

test('Portal Agent rejects concurrent first-input preparation', async (t) => {
  const root = new ResourceScope('inline-concurrency-test')
  const scope = new ExtensionResourceScope('portal', 'inline-concurrency', root)
  const renderStarted = Promise.withResolvers<void>()
  const releaseRender = Promise.withResolvers<void>()
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration({
        packageId: PORTAL_AGENT_PROMPT_PACKAGE_ID,
        promptId: PORTAL_AGENT_PROMPT_ID,
        render: async (task?: string) => {
          renderStarted.resolve()
          await releaseRender.promise
          return `setup:${task ?? ''}`
        },
      }),
      createPortalAgentRegistration(),
    ],
    parentScope: scope,
  })
  t.after(async () => await root.dispose())
  const agent = await runtime.agents.open({
    mode: 'agent',
    startup: 'inline',
    tools: null,
    textToolProtocol: null,
    workingDirectory: '/workspace',
  })

  const first = agent.prepareInput('first')
  await renderStarted.promise
  await assert.rejects(
    agent.prepareInput('second'),
    /already preparing its first input/
  )
  releaseRender.resolve()
  assert.equal(await first, 'setup:first')
  assert.equal(await agent.prepareInput('third'), 'third')
  await agent.close?.()
})

test('Agent input preparation is canceled even when a Prompt renderer does not settle', async (t) => {
  const root = new ResourceScope('agent-prompt-cancel-test')
  const scope = new ExtensionResourceScope('portal', 'agent-cancel', root)
  const renderStarted = Promise.withResolvers<void>()
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration({
        packageId: PORTAL_AGENT_PROMPT_PACKAGE_ID,
        promptId: PORTAL_AGENT_PROMPT_ID,
        render: async () => {
          renderStarted.resolve()
          return await new Promise<string>(() => undefined)
        },
      }),
      createPortalAgentRegistration(),
    ],
    parentScope: scope,
  })
  const controller = new AbortController()
  t.after(async () => await root.dispose())

  const agent = await runtime.agents.open(
    {
      mode: 'agent',
      startup: 'inline',
      tools: null,
      textToolProtocol: null,
      workingDirectory: '/workspace',
    },
    scope,
    controller.signal
  )
  const preparing = agent.prepareInput('first')
  await renderStarted.promise
  controller.abort(new Error('cancel Prompt rendering'))

  await assert.rejects(preparing, /cancel Prompt rendering/)
  await agent.close?.()
})

test('PromptHost returns on cancellation and closes a late renderer session', async () => {
  const root = new ResourceScope('late-prompt-test')
  const scope = new ExtensionResourceScope('portal', 'late-prompt', root)
  const started = Promise.withResolvers<void>()
  const late =
    Promise.withResolvers<
      import('../../src/prompts/prompt-extension.ts').PromptSession
    >()
  let closeCalls = 0
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration({
        factory: async () => {
          started.resolve()
          return await late.promise
        },
      }),
    ],
    parentScope: scope,
  })
  const controller = new AbortController()
  const opening = runtime.prompts.open(
    'test.prompt',
    { tools: null, textToolProtocol: null, workingDirectory: '/workspace' },
    scope,
    controller.signal
  )
  await started.promise
  controller.abort(new Error('cancel Prompt factory'))

  await assert.rejects(opening, /cancel Prompt factory/)
  late.resolve({
    render: async () => 'late',
    close: () => {
      closeCalls += 1
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closeCalls, 1)
  await root.dispose()
})

test('AgentHost returns on cancellation and reports late session cleanup at shutdown', async () => {
  const root = new ResourceScope('late-agent-test')
  const scope = new ExtensionResourceScope('portal', 'late-agent', root)
  const started = Promise.withResolvers<void>()
  const late = Promise.withResolvers<AgentSession>()
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration(),
      createTestAgentRegistration(async () => {
        started.resolve()
        return await late.promise
      }),
    ],
    parentScope: scope,
  })
  const controller = new AbortController()
  const opening = runtime.agents.open(
    {
      mode: 'agent',
      startup: 'interactive',
      tools: null,
      textToolProtocol: null,
      workingDirectory: '/workspace',
    },
    scope,
    controller.signal
  )
  await started.promise
  controller.abort(new Error('cancel Agent factory'))

  await assert.rejects(opening, /cancel Agent factory/)
  late.resolve({
    initialization: null,
    previewInput: async (input) => input,
    prepareInput: async (input) => input,
    close: () => {
      throw new Error('late Agent close failed')
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(root.dispose(), (error: unknown) => {
    assert.match(errorMessages(error), /late Agent close failed/)
    return true
  })
})

test('AgentHost closes the Agent session before its Prompt session', async () => {
  const root = new ResourceScope('agent-close-order-test')
  const scope = new ExtensionResourceScope('portal', 'close-order', root)
  const closed: string[] = []
  const runtime = new PortalDomainRuntime({
    extensions: [
      createTestPromptRegistration({
        factory: async () => ({
          render: async () => 'prompt',
          close: () => {
            closed.push('prompt')
          },
        }),
      }),
      createTestAgentRegistration(async () => ({
        initialization: null,
        previewInput: async (input) => input,
        prepareInput: async (input) => input,
        close: () => {
          closed.push('agent')
        },
      })),
    ],
    parentScope: scope,
  })
  const session = await runtime.agents.open({
    mode: 'agent',
    startup: 'interactive',
    tools: null,
    textToolProtocol: null,
    workingDirectory: '/workspace',
  })

  await session.close?.()
  assert.deepEqual(closed, ['agent', 'prompt'])
  await root.dispose()
})

function createTestPromptRegistration(
  options: {
    readonly packageId?: string
    readonly promptId?: string
    readonly render?: (task?: string) => string | Promise<string>
    readonly factory?: PromptRendererFactory
  } = {}
): PortalExtensionRegistration {
  const packageId = options.packageId ?? 'test.prompt'
  const promptId = options.promptId ?? 'test.prompt'
  const bindingId = `${promptId}.renderer`
  return {
    descriptor: {
      id: packageId,
      version: '1.0.0',
      dependencies: [],
      capabilities: [],
    },
    module: {
      register(api: ExtensionRegistrationApi) {
        api.contribute(promptContributions, {
          id: promptId,
          value: {
            id: promptId,
            descriptor: { label: 'Test Prompt' },
            rendererBindingId: bindingId,
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
        api.bind(promptRendererBindings, {
          id: bindingId,
          targetId: promptId,
          binding:
            options.factory ??
            (async () => ({
              render: async (task?: string) =>
                await (options.render?.(task) ?? task ?? 'prompt'),
            })),
        })
      },
    },
  }
}

function createTestAgentRegistration(
  factory: AgentSessionFactory
): PortalExtensionRegistration {
  return {
    descriptor: {
      id: 'test.agent',
      version: '1.0.0',
      dependencies: ['test.prompt'],
      capabilities: [],
    },
    module: {
      register(api) {
        api.contribute(agentContributions, {
          id: 'test.agent',
          value: {
            id: 'test.agent',
            descriptor: { label: 'Test Agent', mode: 'agent' },
            promptId: 'test.prompt',
            sessionBindingId: 'test.agent.session',
            historyBindingId: 'test.agent.history',
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
        api.bind(agentSessionBindings, {
          id: 'test.agent.session',
          targetId: 'test.agent',
          binding: factory,
        })
        api.bind(agentHistoryBindings, {
          id: 'test.agent.history',
          targetId: 'test.agent',
          binding: () => [],
        })
      },
    },
  }
}

function errorMessages(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(errorMessages)].join('\n')
  }
  if (error instanceof Error) {
    return [error.message, errorMessages(error.cause)].join('\n')
  }
  return typeof error === 'string' ? error : ''
}
