import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import { portalWorkspaceService } from '../extensions/portal-workspace-service.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  createPromptSkillService,
  PORTAL_SKILLS_PACKAGE_ID,
  promptSkillService,
  type PromptSkillService,
} from './skill-services.ts'

export const portalSkillsDescriptor: ExtensionDescriptor = Object.freeze({
  id: PORTAL_SKILLS_PACKAGE_ID,
  version: '1.0.0',
  dependencies: Object.freeze([]),
  capabilities: Object.freeze([]),
})

export function createSkillPluginRegistration(
  options: {
    readonly service?: PromptSkillService
  } = {}
): PortalExtensionRegistration {
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.provide(promptSkillService, {
        dependencies:
          options.service === undefined
            ? Object.freeze([portalWorkspaceService])
            : Object.freeze([]),
        create: async ({ services }) =>
          options.service ??
          (await createPromptSkillService(
            await services.get(portalWorkspaceService)
          )),
      })
    },
  })
  return Object.freeze({ descriptor: portalSkillsDescriptor, module })
}
