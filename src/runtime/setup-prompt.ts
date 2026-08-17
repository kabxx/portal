import { joinPromptSections } from '../shared/prompt-sections.ts'
import {
  DEFAULT_TEXT_TOOL_PROTOCOL,
  type TextToolProtocol,
} from '../tools/core/text-tool-protocol.ts'

export interface SetupSkill {
  name: string
  description: string
  manifestPath: string
}

export interface SetupPromptOptions {
  tools: string | null
  textToolProtocol?: TextToolProtocol
  skills?: readonly SetupSkill[]
  projectInstructions?: string | null
  workingDirectory: string
  task?: string
}

export const TOOL_PROTOCOL_PROMPT = DEFAULT_TEXT_TOOL_PROTOCOL.prompt

export const SETUP_INITIALIZATION_PROMPT = [
  '## Initialization',
  'Reply exactly: READY',
].join('\n')

export function buildSetupPrompt({
  tools,
  textToolProtocol = DEFAULT_TEXT_TOOL_PROTOCOL,
  skills = [],
  projectInstructions = null,
  workingDirectory,
  task,
}: SetupPromptOptions): string {
  const toolSection =
    tools === null || tools.trim() === ''
      ? null
      : joinPromptSections([
          textToolProtocol.prompt,
          `## ${textToolProtocol.catalogHeading}\n\n${tools}`,
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
  const finalSection =
    task === undefined ? SETUP_INITIALIZATION_PROMPT : `## Task\n\n${task}`

  return joinPromptSections([
    '# Portal Agent',
    toolSection,
    skillSection,
    instructionSection,
    `## Runtime\nWorking directory: ${JSON.stringify(workingDirectory)}`,
    finalSection,
  ])
}

export function buildSetupHandshakePrompt(
  workingDirectory = process.cwd()
): string {
  return buildSetupPrompt({ tools: null, workingDirectory })
}

export function isPortalSetupPrompt(value: string): boolean {
  const normalized = value.trim()
  return (
    normalized.startsWith('# Portal Agent\n\n') &&
    normalized.endsWith(SETUP_INITIALIZATION_PROMPT)
  )
}
