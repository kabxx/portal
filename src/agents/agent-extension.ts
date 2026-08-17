import { z } from 'zod'

import type {
  Capability,
  ContributionSpec,
  ExecutableBindingSpec,
  ResourceScopeRegistration,
  ServiceAccessor,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type {
  PromptRenderRequest,
  PromptSession,
} from '../prompts/prompt-extension.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'
import type { ConversationHistoryMessage } from '../providers/conversation-history.ts'

export const AGENT_MODES = ['agent', 'chat'] as const
export type AgentMode = (typeof AGENT_MODES)[number]

export const AGENT_STARTUPS = ['interactive', 'inline', 'resume'] as const
export type AgentStartup = (typeof AGENT_STARTUPS)[number]

export interface AgentInitialization {
  readonly prompt: string
  accepts(response: string): boolean
}

export interface AgentSession {
  readonly initialization: AgentInitialization | null
  previewInput(input: string): Promise<string>
  prepareInput(input: string): Promise<string>
  close?(reason?: unknown): void | Promise<void>
}

export interface AgentSessionRequest extends PromptRenderRequest {
  readonly mode: AgentMode
  readonly startup: AgentStartup
}

export interface AgentSessionFactoryContext {
  readonly request: AgentSessionRequest
  readonly prompt: PromptSession
  readonly signal: AbortSignal
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
}

export type AgentSessionFactory = (
  context: AgentSessionFactoryContext
) => AgentSession | Promise<AgentSession>

export type AgentHistoryClassifier = (
  messages: readonly ConversationHistoryMessage[]
) => readonly number[]

export interface AgentContribution {
  readonly id: string
  readonly descriptor: {
    readonly label: string
    readonly mode: AgentMode
  }
  readonly promptId: string
  readonly sessionBindingId: string
  readonly historyBindingId: string
}

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)
const agentContributionSchema = z
  .object({
    id: stableId,
    descriptor: z
      .object({
        label: z.string().trim().min(1),
        mode: z.enum(AGENT_MODES),
      })
      .strict(),
    promptId: stableId,
    sessionBindingId: stableId,
    historyBindingId: stableId,
  })
  .strict()

export const agentContributions = createContributionRef<AgentContribution>({
  id: 'agents.collect',
  version: 1,
})

export const agentSessionBindings =
  createExecutableBindingRef<AgentSessionFactory>({
    id: 'agents.sessions',
    version: 1,
    kind: 'agent-session',
    targetContribution: agentContributions,
  })

export const agentHistoryBindings =
  createExecutableBindingRef<AgentHistoryClassifier>({
    id: 'agents.history-classifiers',
    version: 1,
    kind: 'agent-history-classifier',
    targetContribution: agentContributions,
  })

export function createAgentContributionSpec(): ContributionSpec<AgentContribution> {
  return Object.freeze({
    ref: agentContributions,
    schema: Object.freeze({
      parse(value: unknown): AgentContribution {
        const parsed = agentContributionSchema.parse(value)
        return Object.freeze({
          id: parsed.id,
          descriptor: Object.freeze({ ...parsed.descriptor }),
          promptId: parsed.promptId,
          sessionBindingId: parsed.sessionBindingId,
          historyBindingId: parsed.historyBindingId,
        })
      },
    }),
    identityOf: (value: AgentContribution) => value.id,
    conflictKeyOf: (value: AgentContribution) => value.descriptor.mode,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([]),
    allowedCapabilities: Object.freeze([] as Capability[]),
  })
}

export const agentContributionSpec = createAgentContributionSpec()

export const agentSessionBindingSpec: ExecutableBindingSpec<AgentSessionFactory> =
  Object.freeze({
    ref: agentSessionBindings,
    targetContribution: agentContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: AgentSessionFactory) {
      if (typeof binding !== 'function') {
        throw new TypeError('Agent session binding must be a function.')
      }
      return binding
    },
  })

export const agentHistoryBindingSpec: ExecutableBindingSpec<AgentHistoryClassifier> =
  Object.freeze({
    ref: agentHistoryBindings,
    targetContribution: agentContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: AgentHistoryClassifier) {
      if (typeof binding !== 'function') {
        throw new TypeError('Agent history binding must be a function.')
      }
      return binding
    },
  })

export function defineAgentHost(registry: ExtensionRegistry): void {
  registry.defineContribution(agentContributionSpec)
  registry.defineExecutableBinding(agentSessionBindingSpec)
  registry.defineExecutableBinding(agentHistoryBindingSpec)
}
