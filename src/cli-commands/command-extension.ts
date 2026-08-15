import type {
  Capability,
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
  ServiceRef,
  ServiceFactory,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  commandCapabilities,
  commandCatalogService,
  commandJobService,
  commandKeybindingService,
  commandMcpService,
  commandOutputService,
  commandProviderService,
  commandServiceRefs,
  commandSkillService,
  commandThreadService,
  CommandServiceHost,
} from './core/command-services.ts'
import type {
  CommandContribution,
  CommandHandler,
} from './core/command-contracts.ts'
import {
  commandContributions,
  commandHandlerBindings,
} from './core/command-plan.ts'

export interface BuiltinCommandDefinition {
  readonly contribution: CommandContribution
  readonly handler: CommandHandler
  readonly requiredServices: readonly (typeof commandServiceRefs)[number][]
  readonly requiredCapabilities: readonly Capability[]
}

export const portalCommandsDescriptor: ExtensionDescriptor = Object.freeze({
  id: 'portal.commands',
  version: '1.0.0',
  dependencies: Object.freeze([]),
  capabilities: commandCapabilities,
})

export function createPortalCommandsRegistration(
  serviceHost: CommandServiceHost,
  definitions: readonly BuiltinCommandDefinition[]
): PortalExtensionRegistration {
  const module: ExtensionModule = {
    register(api: ExtensionRegistrationApi): void {
      provideService(api, commandOutputService, serviceHost)
      provideService(api, commandCatalogService, serviceHost)
      provideService(api, commandThreadService, serviceHost)
      provideService(api, commandProviderService, serviceHost)
      provideService(api, commandSkillService, serviceHost)
      provideService(api, commandMcpService, serviceHost)
      provideService(api, commandJobService, serviceHost)
      provideService(api, commandKeybindingService, serviceHost)

      for (const [index, definition] of definitions.entries()) {
        const previous = definitions[index - 1]
        api.contribute(commandContributions, {
          id: definition.contribution.id,
          value: definition.contribution,
          requiredServices: definition.requiredServices,
          requiredCapabilities: definition.requiredCapabilities,
          ...(previous === undefined
            ? {}
            : { after: [previous.contribution.id] }),
        })
        api.bind(commandHandlerBindings, {
          id: `${definition.contribution.id}.handler`,
          targetId: definition.contribution.id,
          binding: definition.handler,
        })
      }
    },
  }
  return Object.freeze({
    descriptor: portalCommandsDescriptor,
    module,
  })
}

function provideService<Service>(
  api: ExtensionRegistrationApi,
  ref: ServiceRef<Service>,
  host: CommandServiceHost
): void {
  const factory: ServiceFactory<Service> = {
    dependencies: Object.freeze([]),
    create: async () => {
      // ServiceRef identity was checked by the registry before this generic
      // service factory was captured.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return host.get(ref) as Service
    },
  }
  api.provide(ref, factory)
}
