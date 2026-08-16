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

export class PortalDomainRuntime {
  public readonly lifecycle: PortalHookRuntime
  public readonly commands: CommandHost
  public readonly graph: ResolvedExtensionGraph

  public constructor(options: {
    readonly extensions: readonly PortalExtensionRegistration[]
    readonly generation?: string
    readonly clock?: HookRuntimeClock
    readonly traceSink?: HookTraceSink
  }) {
    const clock = options.clock ?? systemPortalClock
    const registry = new ExtensionRegistry({
      generation: options.generation ?? 'portal-domain-v1',
      policies: canonicalHookPolicies,
    })
    registry.defineHook(portalBeforeStartSpec)
    registry.defineHook(portalReadySpec)
    registry.defineHook(portalBeforeStopSpec)
    registry.defineHook(portalStoppedSpec)
    defineCommandHost(registry)
    for (const extension of options.extensions) {
      registry.register(extension.descriptor, extension.module)
    }
    this.graph = registry.freeze()
    const services = new ServiceContainer(this.graph.servicePlan, { clock })
    this.lifecycle = new PortalHookRuntime({
      graph: this.graph,
      services,
      clock,
      ...(options.traceSink === undefined
        ? {}
        : { traceSink: options.traceSink }),
    })
    this.commands = new CommandHost(this.graph, services, clock)
    Object.freeze(this)
  }
}

const systemPortalClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void) => {
    const timer = setTimeout(callback, delayMs)
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})
