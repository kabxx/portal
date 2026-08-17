import { z } from 'zod'

import type {
  ContributionSpec,
  ExecutableBindingSpec,
  ServiceAccessor,
  ResourceScopeRegistration,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type { TextToolProtocol } from '../tools/core/text-tool-protocol.ts'
import { promptSkillService } from '../skills/skill-services.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'

export interface PromptRenderRequest {
  readonly tools: string | null
  readonly textToolProtocol: TextToolProtocol | null
  readonly workingDirectory: string
}

export interface PromptSession {
  render(task?: string): Promise<string>
  close?(reason?: unknown): void | Promise<void>
}

export interface PromptRendererContext {
  readonly request: PromptRenderRequest
  readonly signal: AbortSignal
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
}

export type PromptRendererFactory = (
  context: PromptRendererContext
) => PromptSession | Promise<PromptSession>

export interface PromptContribution {
  readonly id: string
  readonly descriptor: { readonly label: string }
  readonly rendererBindingId: string
}

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)

const promptContributionSchema = z
  .object({
    id: stableId,
    descriptor: z.object({ label: z.string().trim().min(1) }).strict(),
    rendererBindingId: stableId,
  })
  .strict()

export const promptContributions = createContributionRef<PromptContribution>({
  id: 'prompts.collect',
  version: 1,
})

export const promptRendererBindings =
  createExecutableBindingRef<PromptRendererFactory>({
    id: 'prompts.renderers',
    version: 1,
    kind: 'prompt-renderer',
    targetContribution: promptContributions,
  })

export function createPromptContributionSpec(): ContributionSpec<PromptContribution> {
  return Object.freeze({
    ref: promptContributions,
    schema: Object.freeze({
      parse(value: unknown): PromptContribution {
        const parsed = promptContributionSchema.parse(value)
        return Object.freeze({
          id: parsed.id,
          descriptor: Object.freeze({ ...parsed.descriptor }),
          rendererBindingId: parsed.rendererBindingId,
        })
      },
    }),
    identityOf: (value: PromptContribution) => value.id,
    conflictKeyOf: (value: PromptContribution) => value.id,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([promptSkillService]),
    allowedCapabilities: Object.freeze([]),
  })
}

export const promptContributionSpec = createPromptContributionSpec()

export const promptRendererBindingSpec: ExecutableBindingSpec<PromptRendererFactory> =
  Object.freeze({
    ref: promptRendererBindings,
    targetContribution: promptContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: PromptRendererFactory) {
      if (typeof binding !== 'function') {
        throw new TypeError('Prompt renderer binding must be a function.')
      }
      return binding
    },
  })

export function definePromptHost(registry: ExtensionRegistry): void {
  registry.defineService(promptSkillService)
  registry.defineContribution(promptContributionSpec)
  registry.defineExecutableBinding(promptRendererBindingSpec)
}
