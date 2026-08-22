import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  PORTAL_AGENT_PROMPT_ID,
  PORTAL_AGENT_PROMPT_PACKAGE_ID,
  PORTAL_CHAT_PROMPT_ID,
  PORTAL_CHAT_PROMPT_PACKAGE_ID,
  isPortalSetupPrompt,
} from '../prompts/portal-prompt-plugin.ts'
import {
  agentContributions,
  agentHistoryBindings,
  agentSessionBindings,
  type AgentMode,
  type AgentSessionFactory,
} from './agent-extension.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'

export const PORTAL_AGENT_PACKAGE_ID = 'portal.agent.default'
export const PORTAL_CHAT_AGENT_PACKAGE_ID = 'portal.agent.chat'
export const PORTAL_AGENT_ID = 'portal.agent.default'
export const PORTAL_CHAT_AGENT_ID = 'portal.agent.chat'

export function createPortalAgentRegistration(): PortalExtensionRegistration {
  return createAgentRegistration({
    packageId: PORTAL_AGENT_PACKAGE_ID,
    agentId: PORTAL_AGENT_ID,
    label: 'Portal Agent',
    mode: 'agent',
    promptId: PORTAL_AGENT_PROMPT_ID,
    promptPackageId: PORTAL_AGENT_PROMPT_PACKAGE_ID,
  })
}

export function createPortalChatAgentRegistration(): PortalExtensionRegistration {
  return createAgentRegistration({
    packageId: PORTAL_CHAT_AGENT_PACKAGE_ID,
    agentId: PORTAL_CHAT_AGENT_ID,
    label: 'Portal Chat',
    mode: 'chat',
    promptId: PORTAL_CHAT_PROMPT_ID,
    promptPackageId: PORTAL_CHAT_PROMPT_PACKAGE_ID,
  })
}

function createAgentRegistration(options: {
  readonly packageId: string
  readonly agentId: string
  readonly label: string
  readonly mode: AgentMode
  readonly promptId: string
  readonly promptPackageId: string
}): PortalExtensionRegistration {
  const bindingId = `${options.agentId}.session`
  const historyBindingId = `${options.agentId}.history`
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: options.packageId,
    version: '1.0.0',
    dependencies: Object.freeze([options.promptPackageId]),
    capabilities: Object.freeze([]),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.contribute(agentContributions, {
        id: options.agentId,
        value: {
          id: options.agentId,
          descriptor: { label: options.label, mode: options.mode },
          promptId: options.promptId,
          sessionBindingId: bindingId,
          historyBindingId,
        },
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(agentSessionBindings, {
        id: bindingId,
        targetId: options.agentId,
        binding: createPortalAgentSession,
      })
      api.bind(agentHistoryBindings, {
        id: historyBindingId,
        targetId: options.agentId,
        binding: classifyPortalAgentHistory,
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

const createPortalAgentSession: AgentSessionFactory = async ({
  request,
  prompt,
  signal,
}) => {
  let inlineState: 'pending' | 'preparing' | 'complete' =
    request.startup === 'inline' ? 'pending' : 'complete'
  const initialization =
    request.startup === 'interactive'
      ? Object.freeze({
          prompt: await prompt.render(undefined, signal),
        })
      : null
  return Object.freeze({
    initialization,
    previewInput: async (input: string, operationSignal: AbortSignal) => {
      throwIfAborted(operationSignal)
      if (inlineState === 'complete') return input
      const rendered = await prompt.render(input, operationSignal)
      throwIfAborted(operationSignal)
      return rendered
    },
    prepareInput: async (input: string, operationSignal: AbortSignal) => {
      throwIfAborted(operationSignal)
      if (inlineState === 'complete') return input
      if (inlineState === 'preparing') {
        throw new Error('Agent is already preparing its first input.')
      }
      inlineState = 'preparing'
      try {
        const rendered = await prompt.render(input, operationSignal)
        throwIfAborted(operationSignal)
        inlineState = 'complete'
        return rendered
      } catch (error) {
        inlineState = 'pending'
        throw error
      }
    },
  })
}

function classifyPortalAgentHistory(
  messages: readonly import('../providers/conversation-history.ts').ConversationHistoryMessage[]
): readonly number[] {
  const first = messages[0]
  if (first?.role !== 'user' || !isPortalSetupPrompt(first.text)) return []
  const hidden = [0]
  const nextUser = messages.findIndex(
    (message, index) => index > 0 && message.role === 'user'
  )
  const acknowledgement = messages.findIndex(
    (message, index) =>
      index > 0 &&
      (nextUser === -1 || index < nextUser) &&
      message.role === 'assistant'
  )
  if (acknowledgement !== -1) hidden.push(acknowledgement)
  return Object.freeze(hidden)
}
