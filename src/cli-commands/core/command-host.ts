import type { HookRuntimeClock } from '../../extensions/extension-contracts.ts'
import type { ExtensionResourceScope } from '../../extensions/scope-registration.ts'
import type { ResolvedExtensionGraph } from '../../extensions/extension-registry.ts'
import { ExtensionRegistry } from '../../extensions/extension-registry.ts'
import {
  CommandRuntime,
  type CommandSessionRuntime,
} from './command-runtime.ts'
import type { CommandDescriptor } from './command-contracts.ts'
import {
  commandContributionSpec,
  commandHandlerBindingSpec,
} from './command-plan.ts'
import { commandServiceRefs } from './command-services.ts'
import type { ServiceContainer } from '../../extensions/service-container.ts'

export function defineCommandHost(registry: ExtensionRegistry): void {
  for (const service of commandServiceRefs) registry.defineService(service)
  registry.defineContribution(commandContributionSpec)
  registry.defineExecutableBinding(commandHandlerBindingSpec)
}

export class CommandHost {
  readonly #runtime: CommandRuntime

  public constructor(
    graph: ResolvedExtensionGraph,
    services: ServiceContainer,
    clock: HookRuntimeClock
  ) {
    this.#runtime = new CommandRuntime(graph, {
      clock,
      serviceContainer: services,
    })
  }

  public openSession(
    parent: ExtensionResourceScope,
    resourceId: string
  ): CommandSessionRuntime {
    return this.#runtime.openSession(parent, resourceId)
  }

  public catalog(): readonly CommandDescriptor[] {
    return this.#runtime.plan.catalog
  }
}
