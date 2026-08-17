import path from 'node:path'

import type { CommandSkillService } from '../cli-commands/core/command-services.ts'
import { createServiceRef } from '../extensions/extension-contracts.ts'
import type { PortalWorkspaceContext } from '../extensions/portal-workspace-service.ts'
import { loadProjectInstructions } from '../instructions/project-instructions.ts'
import { abortable, throwIfAborted } from '../runtime/runtime-cancellation.ts'
import type { SetupSkill } from '../runtime/setup-prompt.ts'
import { SkillLibrary } from './skill-library.ts'

export const PORTAL_SKILLS_PACKAGE_ID = 'portal.skills'

export interface PromptSkillSnapshot {
  readonly skills: readonly SetupSkill[]
  readonly projectInstructions: string | null
}

export interface PromptSkillService extends CommandSkillService {
  snapshot(signal: AbortSignal): Promise<PromptSkillSnapshot>
}

export const promptSkillService = createServiceRef<PromptSkillService>({
  id: 'portal.prompt.skills',
  version: 1,
  scope: 'portal',
})

export async function createPromptSkillService(
  workspace: PortalWorkspaceContext
): Promise<PromptSkillService> {
  const library = new SkillLibrary({
    skillsDirectory: path.join(workspace.dataDirectory, 'skills'),
    tempDirectory: path.join(workspace.dataDirectory, 'temp', 'skill-install'),
    registryPath: path.join(workspace.dataDirectory, 'state', 'skills.json'),
  })
  await library.initialize()
  const projectInstructions = await loadProjectInstructions({
    cwd: workspace.cwd,
    enabled: workspace.projectInstructionsEnabled,
  })

  const service: PromptSkillService = Object.freeze({
    snapshot: async (signal: AbortSignal) => {
      throwIfAborted(signal)
      const catalog = await abortable(library.createCatalogSnapshot(), signal)
      return Object.freeze({
        skills: Object.freeze([...catalog.setupSkills]),
        projectInstructions: projectInstructions.prompt,
      })
    },
    add: async (
      source: string,
      options: { readonly registryUrl?: string; readonly signal: AbortSignal }
    ) =>
      await abortable(
        library.add(source, {
          ...(options.registryUrl === undefined
            ? {}
            : { registryUrl: options.registryUrl }),
          signal: options.signal,
        }),
        options.signal
      ),
    list: async (signal: AbortSignal) =>
      await abortable(library.list(), signal),
    enable: async (name: string, signal: AbortSignal) =>
      await abortable(library.enable(name), signal),
    disable: async (name: string, signal: AbortSignal) =>
      await abortable(library.disable(name), signal),
    remove: async (name: string, signal: AbortSignal) =>
      await abortable(library.remove(name), signal),
  })
  return service
}
