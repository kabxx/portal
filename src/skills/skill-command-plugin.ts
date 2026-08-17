import { skillCommandDefinition } from '../cli-commands/builtin-commands.ts'
import {
  commandOutputService,
  commandSkillService,
  type CommandSkillService,
} from '../cli-commands/core/command-services.ts'
import {
  commandContributions,
  commandHandlerBindings,
} from '../cli-commands/core/command-plan.ts'
import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  PORTAL_SKILLS_PACKAGE_ID,
  promptSkillService,
} from './skill-services.ts'

export const PORTAL_SKILL_COMMAND_PACKAGE_ID = 'portal.command.skills'

export const portalSkillCommandDescriptor: ExtensionDescriptor = Object.freeze({
  id: PORTAL_SKILL_COMMAND_PACKAGE_ID,
  version: '1.0.0',
  dependencies: Object.freeze(['portal.commands', PORTAL_SKILLS_PACKAGE_ID]),
  capabilities: Object.freeze([
    'portal.command.skill.read',
    'portal.command.skill.manage',
  ]),
})

export function createSkillCommandRegistration(): PortalExtensionRegistration {
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.provide(commandSkillService, {
        dependencies: Object.freeze([promptSkillService]),
        create: async ({ services }) => {
          const service: CommandSkillService =
            await services.get(promptSkillService)
          return service
        },
      })
      api.contribute(commandContributions, {
        id: skillCommandDefinition.contribution.id,
        value: skillCommandDefinition.contribution,
        requiredServices: Object.freeze([
          commandOutputService,
          commandSkillService,
        ]),
        requiredCapabilities: skillCommandDefinition.requiredCapabilities,
      })
      api.bind(commandHandlerBindings, {
        id: `${skillCommandDefinition.contribution.id}.handler`,
        targetId: skillCommandDefinition.contribution.id,
        binding: skillCommandDefinition.handler,
      })
    },
  })
  return Object.freeze({ descriptor: portalSkillCommandDescriptor, module })
}
