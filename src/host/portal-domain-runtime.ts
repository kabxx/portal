import type {
  HookRuntimeClock,
  HookTraceSink,
} from '../extensions/extension-contracts.ts'
import {
  ExtensionRegistry,
  type ResolvedExtensionGraph,
} from '../extensions/extension-registry.ts'
import { canonicalHookPolicies } from '../extensions/hook-policies.ts'
import { ServiceContainer } from '../extensions/service-container.ts'
import {
  PortalHookRuntime,
  portalBeforeStartSpec,
  portalReadySpec,
  portalBeforeStopSpec,
  portalStoppedSpec,
  type PortalExtensionRegistration,
} from '../extensions/portal-hooks.ts'
import {
  CommandHost,
  defineCommandHost,
} from '../cli-commands/core/command-host.ts'
import { commandJobService } from '../cli-commands/core/command-services.ts'
import { defineProviderHost } from '../providers/provider-exchange.ts'
import { defineToolHost, ToolHost } from '../tools/tool-host.ts'
import { ProviderHost } from '../providers/provider-host.ts'
import { ConversationHost } from '../threads/conversation-host.ts'
import type { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import {
  attachmentStoreService,
  type AttachmentReader,
} from '../attachments/attachment-contracts.ts'
import { portalWorkspaceService } from '../extensions/portal-workspace-service.ts'
import { defineSurfaceHost } from '../surfaces/surface-extension.ts'
import { SurfaceHost } from '../surfaces/surface-host.ts'
import { portalBrowserSessionService } from '../platform/browser-session-service.ts'
import { toolRuntimeService } from '../tools/tool-runtime-service.ts'

export class PortalDomainRuntime {
  readonly #portalScope: ExtensionResourceScope
  readonly #services: ServiceContainer

  public readonly lifecycle: PortalHookRuntime
  public readonly commands: CommandHost
  public readonly graph: ResolvedExtensionGraph
  public readonly providers: ProviderHost
  public readonly tools: ToolHost
  public readonly conversations: ConversationHost
  public readonly surfaces: SurfaceHost

  public constructor(options: {
    readonly extensions: readonly PortalExtensionRegistration[]
    readonly generation?: string
    readonly clock?: HookRuntimeClock
    readonly traceSink?: HookTraceSink
    readonly parentScope: ExtensionResourceScope
  }) {
    const clock = options.clock ?? systemPortalClock
    this.#portalScope = options.parentScope
    const registry = new ExtensionRegistry({
      generation: options.generation ?? 'portal-domain-v1',
      policies: canonicalHookPolicies,
    })
    registry.defineHook(portalBeforeStartSpec)
    registry.defineHook(portalReadySpec)
    registry.defineHook(portalBeforeStopSpec)
    registry.defineHook(portalStoppedSpec)
    defineCommandHost(registry)
    defineProviderHost(registry, {
      allowedServices: Object.freeze([
        portalBrowserSessionService,
        toolRuntimeService,
      ]),
    })
    defineToolHost(registry)
    registry.defineService(portalWorkspaceService)
    defineSurfaceHost(registry, {
      allowedFeatureServices: Object.freeze([commandJobService]),
    })
    for (const extension of options.extensions) {
      registry.register(extension.descriptor, extension.module)
    }
    this.graph = registry.freeze()
    const services = new ServiceContainer(this.graph.servicePlan, { clock })
    this.#services = services
    this.lifecycle = new PortalHookRuntime({
      graph: this.graph,
      services,
      clock,
      ...(options.traceSink === undefined
        ? {}
        : { traceSink: options.traceSink }),
    })
    this.commands = new CommandHost(this.graph, services, clock)
    this.providers = new ProviderHost({
      graph: this.graph,
      parent: options.parentScope.resourceScope,
      services,
      serviceScope: options.parentScope,
    })
    this.tools = new ToolHost({
      graph: this.graph,
      parent: options.parentScope,
      services,
    })
    this.conversations = new ConversationHost({
      providerHost: this.providers,
      toolHost: this.tools,
      root: options.parentScope.resourceScope,
    })
    this.surfaces = new SurfaceHost({
      graph: this.graph,
      parent: options.parentScope,
      services,
    })
    Object.freeze(this)
  }

  public async resolveAttachmentReader(): Promise<AttachmentReader | null> {
    if (!this.graph.servicePlan.providers.has(attachmentStoreService.key)) {
      return null
    }
    const accessor = this.#services.createAccessor({
      scope: this.#portalScope,
      allowedServices: Object.freeze([attachmentStoreService]),
      signal: this.#portalScope.resourceScope.signal,
      deadline: Number.POSITIVE_INFINITY,
    })
    return await accessor.get(attachmentStoreService)
  }
}

const systemPortalClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void) => {
    const timer = setTimeout(callback, delayMs)
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})
