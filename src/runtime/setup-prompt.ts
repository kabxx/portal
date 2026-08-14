import { joinPromptSections } from '../shared/prompt-sections.ts'

export interface SetupSkill {
  name: string
  description: string
  manifestPath: string
}

export interface SetupPromptOptions {
  tools: string | null
  skills?: readonly SetupSkill[]
  projectInstructions?: string | null
  workingDirectory: string
  task?: string
}

export const TOOL_PROTOCOL_PROMPT = [
  '## Tool Protocol',
  '- Format: `<tool name="NAME">PAYLOAD</tool>`',
  '- Payload: JSON object for JSON tools; raw text for freeform tools',
  '- Limit: at most one tool call per assistant message',
  '- Position: the tool call must appear at the end of the assistant message',
  '- Results: returned in the next user message as a Tool Result',
].join('\n')

export const SETUP_INITIALIZATION_PROMPT = [
  '## Initialization',
  'Reply exactly: READY',
].join('\n')

export function buildSetupPrompt({
  tools,
  skills = [],
  projectInstructions = null,
  workingDirectory,
  task,
}: SetupPromptOptions): string {
  const toolSection =
    tools === null || tools.trim() === ''
      ? null
      : joinPromptSections([TOOL_PROTOCOL_PROMPT, `## Tools\n\n${tools}`])
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
