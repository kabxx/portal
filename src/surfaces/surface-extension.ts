import { z } from 'zod'

import type {
  ContributionSpec,
  ExecutableBindingSpec,
  ResourceScopeRegistration,
  ServiceAccessor,
  ServiceRef,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'
import type { SurfacePortActions } from './surface-port.ts'
import type { ConversationHistoryMessage } from '../providers/conversation-history.ts'
import type {
  CommandCompletionSnapshot,
  CommandDescriptor,
} from '../cli-commands/core/command-contracts.ts'
import type { CommandSessionRuntime } from '../cli-commands/core/command-runtime.ts'
import type {
  CommandKeybindingService,
  CommandMcpService,
  CommandOutputService,
} from '../cli-commands/core/command-services.ts'

export type SurfaceKind = 'interactive' | 'batch' | 'listener'
export type SurfaceSessionIntent = 'interactive' | 'batch' | 'automation'

export interface SurfaceContribution {
  readonly id: string
  readonly label: string
  readonly kind: SurfaceKind
  readonly sessionIntent: SurfaceSessionIntent
  readonly activationBindingId: string
}

export interface SurfaceFeatureContribution {
  readonly id: string
  readonly targetSurfaceId: string
  readonly activationBindingId: string
}

export interface ActiveSurfaceFeature {
  readonly id: string
  readonly owner: string
  readonly api: unknown
}

export interface SurfaceFeatureSet {
  list(): readonly ActiveSurfaceFeature[]
  get(featureId: string): ActiveSurfaceFeature | null
}

export interface SurfaceHostSnapshot {
  readonly generation: string
  readonly cwd: string
  readonly dataDirectory: string
  readonly configPath: string
}

export type SurfaceThreadLifecycleEvent =
  | {
      readonly type: 'provision.started'
      readonly threadId: string
      readonly source: string
      readonly stage: 'resolving'
    }
  | {
      readonly type: 'provision.warning'
      readonly threadId: string
      readonly source: string
      readonly title: string
      readonly lines: readonly string[]
    }
  | {
      readonly type: 'thread.ready'
      readonly threadId: string
      readonly source: string
      readonly origin: 'new' | 'resumed'
      readonly provider: string
      readonly conversationUrl: string
    }
  | {
      readonly type: 'thread.history'
      readonly threadId: string
      readonly source: string
      readonly history: {
        readonly messages: readonly ConversationHistoryMessage[]
        readonly complete: boolean
        readonly warning: string | null
      }
    }
  | {
      readonly type: 'thread.closed'
      readonly threadId: string
      readonly reason: string
    }
  | {
      readonly type: 'provision.finished'
      readonly threadId: string
      readonly source: string
      readonly status: 'failed' | 'cancelled'
      readonly stage: string
      readonly message: string
    }

export type SurfaceHostEvent =
  | {
      readonly type: 'host.status'
      readonly status: 'ready' | 'stopping' | 'stopped' | 'failed'
      readonly message?: string
    }
  | {
      readonly type: 'runtime.disconnected'
      readonly cleanupVerified: boolean
    }
  | {
      readonly type: 'thread.lifecycle'
      readonly event: SurfaceThreadLifecycleEvent
    }
  | {
      readonly type: 'thread.cleanup_failed'
      readonly threadId: string
    }

export interface SurfaceEventSource {
  subscribe(
    listener: (event: SurfaceHostEvent) => void | Promise<void>
  ): () => void
}

export interface SurfaceCommandPort {
  openSession(resourceId: string): CommandSessionRuntime
  catalog(): readonly CommandDescriptor[]
  completionSnapshot(): CommandCompletionSnapshot
  bindPresentation(services: {
    readonly output: CommandOutputService
    readonly mcp?: CommandMcpService
    readonly keybindings: CommandKeybindingService
    readonly setThreadBusy?: (threadId: string, busy: boolean) => void
  }): void
}

export interface SurfaceKernelBinding {
  readonly port: SurfacePortActions
  readonly events: SurfaceEventSource
  readonly commands: SurfaceCommandPort
  readonly snapshot: SurfaceHostSnapshot
  requestStop(surfaceId: string, reason?: unknown): void | Promise<void>
}

export interface SurfaceActivationContext {
  readonly surfaceId: string
  readonly signal: AbortSignal
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
  readonly port: SurfacePortActions
  readonly events: SurfaceEventSource
  readonly commands: SurfaceCommandPort
  readonly host: SurfaceHostSnapshot
  readonly features: SurfaceFeatureSet
  requestStop(reason?: unknown): void | Promise<void>
}

export interface SurfaceFeatureActivationContext {
  readonly featureId: string
  readonly surfaceId: string
  readonly signal: AbortSignal
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
  readonly port: SurfacePortActions
  readonly events: SurfaceEventSource
  readonly commands: SurfaceCommandPort
  readonly host: SurfaceHostSnapshot
  requestStop(reason?: unknown): void | Promise<void>
}

export interface SurfaceInstance {
  readonly done: Promise<void>
  readonly api?: unknown
  close(reason?: unknown): void | Promise<void>
}

export type SurfaceActivator = (
  input: unknown,
  context: SurfaceActivationContext
) => SurfaceInstance | Promise<SurfaceInstance>

export type SurfaceFeatureActivator = (
  context: SurfaceFeatureActivationContext
) => unknown

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)
const surfaceContributionSchema = z
  .object({
    id: stableId,
    label: z.string().trim().min(1),
    kind: z.enum(['interactive', 'batch', 'listener']),
    sessionIntent: z.enum(['interactive', 'batch', 'automation']),
    activationBindingId: stableId,
  })
  .strict()

const surfaceFeatureContributionSchema = z
  .object({
    id: stableId,
    targetSurfaceId: stableId,
    activationBindingId: stableId,
  })
  .strict()

export const surfaceContributions = createContributionRef<SurfaceContribution>({
  id: 'surfaces.collect',
  version: 1,
})

export const surfaceActivationBindings =
  createExecutableBindingRef<SurfaceActivator>({
    id: 'surfaces.activators',
    version: 1,
    kind: 'surface-activator',
    targetContribution: surfaceContributions,
  })

export const surfaceFeatureContributions =
  createContributionRef<SurfaceFeatureContribution>({
    id: 'surface.features.collect',
    version: 1,
  })

export const surfaceFeatureActivationBindings =
  createExecutableBindingRef<SurfaceFeatureActivator>({
    id: 'surface.features.activators',
    version: 1,
    kind: 'surface-feature-activator',
    targetContribution: surfaceFeatureContributions,
  })

export const surfaceContributionSpec: ContributionSpec<SurfaceContribution> =
  Object.freeze({
    ref: surfaceContributions,
    schema: Object.freeze({
      parse(value: unknown): SurfaceContribution {
        const parsed = surfaceContributionSchema.parse(value)
        return Object.freeze({ ...parsed })
      },
    }),
    identityOf: (value: SurfaceContribution) => value.id,
    conflictKeyOf: (value: SurfaceContribution) => value.id,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([]),
    allowedCapabilities: Object.freeze([]),
  })

export const surfaceActivationBindingSpec: ExecutableBindingSpec<SurfaceActivator> =
  Object.freeze({
    ref: surfaceActivationBindings,
    targetContribution: surfaceContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: SurfaceActivator) {
      if (typeof binding !== 'function') {
        throw new TypeError('Surface activator binding must be a function.')
      }
      return binding
    },
  })

export const surfaceFeatureActivationBindingSpec: ExecutableBindingSpec<SurfaceFeatureActivator> =
  Object.freeze({
    ref: surfaceFeatureActivationBindings,
    targetContribution: surfaceFeatureContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: SurfaceFeatureActivator) {
      if (typeof binding !== 'function') {
        throw new TypeError(
          'Surface feature activator binding must be a function.'
        )
      }
      return binding
    },
  })

export function defineSurfaceHost(
  registry: ExtensionRegistry,
  options: {
    readonly allowedFeatureServices?: readonly ServiceRef<unknown>[]
  } = {}
): void {
  registry.defineContribution(surfaceContributionSpec)
  registry.defineExecutableBinding(surfaceActivationBindingSpec)
  const featureSpec: ContributionSpec<SurfaceFeatureContribution> =
    Object.freeze({
      ref: surfaceFeatureContributions,
      schema: Object.freeze({
        parse(value: unknown): SurfaceFeatureContribution {
          return Object.freeze(surfaceFeatureContributionSchema.parse(value))
        },
      }),
      identityOf: (value: SurfaceFeatureContribution) => value.id,
      conflictKeyOf: (value: SurfaceFeatureContribution) =>
        `${value.targetSurfaceId}:${value.id}`,
      maxPerConflictKey: 1,
      selection: 'all',
      ordering: 'dependency-edges',
      allowedServices: Object.freeze([
        ...(options.allowedFeatureServices ?? []),
      ]),
      allowedCapabilities: Object.freeze([]),
    })
  registry.defineContribution(featureSpec)
  registry.defineExecutableBinding(surfaceFeatureActivationBindingSpec)
}
