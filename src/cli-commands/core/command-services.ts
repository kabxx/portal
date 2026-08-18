import type { ServiceRef } from '../../extensions/extension-contracts.ts'
import { createServiceRef } from '../../extensions/extension-contracts.ts'
import { pluginManagementService } from '../../extensions/plugin-management-service.ts'
import type {
  CommandCompletionSnapshot,
  CommandDescriptor,
  CommandMessageFormat,
  CommandMessageLevel,
} from './command-contracts.ts'

export interface CommandOutputMessage {
  readonly level: CommandMessageLevel
  readonly title: string
  readonly body: string | readonly string[]
  readonly format?: CommandMessageFormat
  readonly threadId?: string
}

export type CommandNavigationEvent =
  | { readonly kind: 'show-home' }
  | { readonly kind: 'show-thread'; readonly threadId: string }
  | { readonly kind: 'remove-thread'; readonly threadId: string }

export interface CommandOutputService {
  write(message: CommandOutputMessage): void
  navigate(event: CommandNavigationEvent): void
}

export interface CommandCatalogService {
  list(): readonly CommandDescriptor[]
}

export interface CommandThreadSummary {
  readonly id: string
  readonly provider: string
  readonly title: string | null
  readonly turnCount: number
  readonly conversationUrl: string
  readonly active: boolean
}

export interface CommandThreadHistoryEntry {
  readonly id: number
  readonly provider: string
  readonly title: string | null
  readonly createdAt: string
  readonly lastUsedAt: string
  readonly conversationUrl: string
}

export interface CommandProviderCapabilityState {
  readonly name: string
  readonly state: string
}

export interface CommandProviderCapabilityResult {
  readonly status:
    | 'ok'
    | 'invalid-args'
    | 'unknown-capability'
    | 'unsupported-provider'
    | 'no-active-thread'
  readonly title: string
  readonly body: string
  readonly format: CommandMessageFormat
}

export interface CommandThreadService {
  listAgentModes(): readonly ('agent' | 'chat')[]
  create(input: {
    readonly provider: string
    readonly modelKey: string | null
    readonly optionKey: string | null
    readonly mode: 'agent' | 'chat'
    readonly signal: AbortSignal
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly message: string
        readonly lifecycleFailure?: boolean
      }
  >
  list(): readonly CommandThreadSummary[]
  history(
    limitInput: string | null,
    signal: AbortSignal
  ): Promise<
    | {
        readonly ok: true
        readonly entries: readonly CommandThreadHistoryEntry[]
      }
    | { readonly ok: false; readonly message: string }
  >
  resume(
    target: string,
    signal: AbortSignal
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >
  reloadActive(signal: AbortSignal): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false
        readonly message: string
        readonly threadId?: string
      }
  >
  switchTo(threadId: string): boolean
  status(): CommandThreadSummary | null
  close(
    threadId: string | null,
    signal: AbortSignal
  ): Promise<
    | {
        readonly ok: true
        readonly threadId: string
        readonly wasActive: boolean
      }
    | {
        readonly ok: false
        readonly message: string
        readonly removedThreadId?: string
      }
  >
  detach(): string | null
  listCapabilities(signal: AbortSignal): Promise<
    | {
        readonly ok: true
        readonly provider: string
        readonly capabilities: readonly CommandProviderCapabilityState[]
        readonly usage: string
      }
    | { readonly ok: false; readonly message: string }
  >
  executeCapability(
    name: string,
    args: readonly string[],
    signal: AbortSignal
  ): Promise<CommandProviderCapabilityResult>
}

export interface CommandProviderService {
  list(): readonly string[]
  resolve(value: string): string | null
  completionSnapshot(): CommandCompletionSnapshot
}

export interface CommandSkillService {
  add(
    source: string,
    options: { readonly registryUrl?: string; readonly signal: AbortSignal }
  ): Promise<CommandSkillAddResult>
  list(signal: AbortSignal): Promise<CommandSkillListResult>
  enable(name: string, signal: AbortSignal): Promise<boolean>
  disable(name: string, signal: AbortSignal): Promise<boolean>
  remove(
    name: string,
    signal: AbortSignal
  ): Promise<{
    readonly removed: boolean
    readonly warnings: readonly string[]
  }>
}

export interface CommandSkillAddResult {
  readonly skills: readonly {
    readonly name: string
    readonly directory: string
  }[]
  readonly warnings: readonly string[]
}

export interface CommandSkillListResult {
  readonly skills: readonly {
    readonly name: string
    readonly enabled: boolean
  }[]
  readonly issues: readonly {
    readonly directory: string
    readonly message: string
  }[]
}

export interface CommandMcpStatus {
  readonly running: boolean
  readonly address: string | null
  readonly auth: boolean
}

export interface CommandMcpService {
  start(signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
  status(): CommandMcpStatus
}

export interface CommandJobSnapshot {
  readonly id: string
  readonly pid: number | null
  readonly state: string
  readonly startedAt: number
  readonly shell: string
  readonly cwd: string
  readonly command: string
}

export interface CommandJobService {
  list(): readonly CommandJobSnapshot[]
  stop(
    id: string,
    signal: AbortSignal
  ): Promise<'stopped' | 'not-found' | 'timeout'>
}

export interface CommandKeybindingService {
  reset(signal: AbortSignal): Promise<void>
}

export const commandOutputService = createServiceRef<CommandOutputService>({
  id: 'portal.commands.output',
  version: 1,
  scope: 'portal',
})

export const commandCatalogService = createServiceRef<CommandCatalogService>({
  id: 'portal.commands.catalog',
  version: 1,
  scope: 'portal',
})

export const commandThreadService = createServiceRef<CommandThreadService>({
  id: 'portal.commands.threads',
  version: 1,
  scope: 'portal',
})

export const commandProviderService = createServiceRef<CommandProviderService>({
  id: 'portal.commands.providers',
  version: 1,
  scope: 'portal',
})

export const commandSkillService = createServiceRef<CommandSkillService>({
  id: 'portal.commands.skills',
  version: 1,
  scope: 'portal',
})

export const commandMcpService = createServiceRef<CommandMcpService>({
  id: 'portal.commands.mcp',
  version: 1,
  scope: 'portal',
})

export const commandJobService = createServiceRef<CommandJobService>({
  id: 'portal.commands.jobs',
  version: 1,
  scope: 'portal',
})

export const commandKeybindingService =
  createServiceRef<CommandKeybindingService>({
    id: 'portal.commands.keybindings',
    version: 1,
    scope: 'portal',
  })

export const commandServiceRefs: readonly ServiceRef<unknown>[] = Object.freeze(
  [
    commandOutputService,
    commandCatalogService,
    commandThreadService,
    commandProviderService,
    commandSkillService,
    commandMcpService,
    commandJobService,
    commandKeybindingService,
    pluginManagementService,
  ]
)

export const portalCommandCapabilities = Object.freeze([
  'portal.command.thread.read',
  'portal.command.thread.manage',
  'portal.command.provider.capability.manage',
  'portal.command.job.read',
  'portal.command.job.manage',
  'portal.command.keybinding.manage',
])

export const commandCapabilities = Object.freeze([
  ...portalCommandCapabilities,
  'portal.command.mcp.manage',
  'portal.command.skill.read',
  'portal.command.skill.manage',
  'portal.command.plugin.read',
  'portal.command.plugin.manage',
])

export interface CommandServiceBundle {
  readonly output: CommandOutputService
  readonly catalog: CommandCatalogService
  readonly threads: CommandThreadService
  readonly providers: CommandProviderService
  readonly mcp?: CommandMcpService
  readonly keybindings: CommandKeybindingService
}

/**
 * Host-private late binding for portal-scoped command ports. The extension
 * graph captures the factories at freeze time; the surface supplies the
 * narrow implementations after its own resources are ready.
 */
export class CommandServiceHost {
  #bundle: CommandServiceBundle | null = null

  public bind(bundle: CommandServiceBundle): void {
    if (this.#bundle !== null) {
      throw new Error('Command services are already bound.')
    }
    this.#bundle = bundle
  }

  public get(ref: ServiceRef<unknown>): unknown {
    const bundle = this.#bundle
    if (bundle === null) {
      throw new Error('Command services are not bound.')
    }
    if (ref === commandOutputService) return bundle.output
    if (ref === commandCatalogService) return bundle.catalog
    if (ref === commandThreadService) return bundle.threads
    if (ref === commandProviderService) return bundle.providers
    if (ref === commandMcpService) {
      if (bundle.mcp === undefined) {
        throw new Error('The Portal MCP command service is not available.')
      }
      return bundle.mcp
    }
    if (ref === commandKeybindingService) return bundle.keybindings
    throw new Error(`Unknown command service: ${ref.id}`)
  }
}
