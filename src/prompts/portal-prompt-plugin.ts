import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import { joinPromptSections } from '../shared/prompt-sections.ts'
import {
  PORTAL_SKILLS_PACKAGE_ID,
  promptSkillService,
  type PromptSkillMetadata,
} from '../skills/skill-services.ts'
import {
  promptContributions,
  promptRendererBindings,
  type PromptRenderRequest,
  type PromptRendererFactory,
} from './prompt-extension.ts'

export const PORTAL_AGENT_PROMPT_PACKAGE_ID = 'portal.prompt.agent'
export const PORTAL_CHAT_PROMPT_PACKAGE_ID = 'portal.prompt.chat'
export const PORTAL_AGENT_PROMPT_ID = 'portal.prompt.agent'
export const PORTAL_CHAT_PROMPT_ID = 'portal.prompt.chat'
export const PORTAL_PROMPT_HEADING = '# Portal Prompt'

export const PORTAL_INITIALIZATION_PROMPT = [
  '## Initialization',
  'Reply exactly: READY',
].join('\n')

export function createPortalAgentPromptRegistration(): PortalExtensionRegistration {
  return createPromptRegistration({
    packageId: PORTAL_AGENT_PROMPT_PACKAGE_ID,
    promptId: PORTAL_AGENT_PROMPT_ID,
    label: 'Portal Agent Prompt',
    dependencies: [PORTAL_SKILLS_PACKAGE_ID],
    requiredServices: [promptSkillService],
    renderer: async ({ request, services, signal }) => {
      const snapshot = await (
        await services.get(promptSkillService)
      ).snapshot(signal)
      return Object.freeze({
        render: async (task?: string) =>
          buildPortalAgentPrompt({
            request,
            skills: snapshot.skills,
            projectInstructions: snapshot.projectInstructions,
            ...(task === undefined ? {} : { task }),
          }),
      })
    },
  })
}

export function createPortalChatPromptRegistration(): PortalExtensionRegistration {
  return createPromptRegistration({
    packageId: PORTAL_CHAT_PROMPT_PACKAGE_ID,
    promptId: PORTAL_CHAT_PROMPT_ID,
    label: 'Portal Chat Handshake',
    dependencies: [],
    requiredServices: [],
    renderer: ({ request }) =>
      Object.freeze({
        render: async (task?: string) =>
          buildPortalChatPrompt(request.workingDirectory, task),
      }),
  })
}

function createPromptRegistration(options: {
  readonly packageId: string
  readonly promptId: string
  readonly label: string
  readonly dependencies: readonly string[]
  readonly requiredServices: readonly (typeof promptSkillService)[]
  readonly renderer: PromptRendererFactory
}): PortalExtensionRegistration {
  const bindingId = `${options.promptId}.renderer`
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: options.packageId,
    version: '1.0.0',
    dependencies: Object.freeze([...options.dependencies]),
    capabilities: Object.freeze([]),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.contribute(promptContributions, {
        id: options.promptId,
        value: {
          id: options.promptId,
          descriptor: { label: options.label },
          rendererBindingId: bindingId,
        },
        requiredServices: Object.freeze([...options.requiredServices]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(promptRendererBindings, {
        id: bindingId,
        targetId: options.promptId,
        binding: options.renderer,
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

export function buildPortalAgentPrompt(options: {
  readonly request: PromptRenderRequest
  readonly skills?: readonly PromptSkillMetadata[]
  readonly projectInstructions?: string | null
  readonly task?: string
}): string {
  const skills = options.skills ?? []
  const projectInstructions = options.projectInstructions ?? null
  const { request, task } = options
  const toolSection =
    request.tools === null || request.tools.trim() === ''
      ? null
      : request.textToolProtocol === null
        ? null
        : joinPromptSections([
            request.textToolProtocol.prompt,
            `## ${request.textToolProtocol.catalogHeading}\n\n${request.tools}`,
          ])
  const skillSection =
    skills.length === 0
      ? null
      : [
          '## Skills',
          ...skills.map(({ name, description, manifestPath }) =>
            [
              `### ${name}`,
              `Description: ${description}`,
              `Path: ${JSON.stringify(manifestPath)}`,
            ].join('\n')
          ),
        ].join('\n\n')
  const instructionSection =
    projectInstructions === null || projectInstructions.trim() === ''
      ? null
      : `## Project Instructions\n\n${projectInstructions}`
  return joinPromptSections([
    PORTAL_PROMPT_HEADING,
    toolSection,
    skillSection,
    instructionSection,
    runtimeSection(request.workingDirectory),
    task === undefined ? PORTAL_INITIALIZATION_PROMPT : taskSection(task),
  ])
}

export function buildPortalChatPrompt(
  workingDirectory: string,
  task?: string
): string {
  return joinPromptSections([
    PORTAL_PROMPT_HEADING,
    runtimeSection(workingDirectory),
    task === undefined ? PORTAL_INITIALIZATION_PROMPT : taskSection(task),
  ])
}

export function isPortalSetupPrompt(value: string): boolean {
  const normalized = value.trim()
  return (
    normalized.startsWith(`${PORTAL_PROMPT_HEADING}\n\n`) &&
    normalized.endsWith(PORTAL_INITIALIZATION_PROMPT)
  )
}

function runtimeSection(workingDirectory: string): string {
  return `## Runtime\nWorking directory: ${JSON.stringify(workingDirectory)}`
}

function taskSection(task: string): string {
  return `## Task\n\n${task}`
}
