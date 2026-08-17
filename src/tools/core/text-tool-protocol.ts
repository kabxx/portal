export interface TextToolProtocol {
  readonly id: string
  readonly displayName: string
  readonly catalogHeading: string
  readonly tagName: string
  readonly prompt: string
  readonly resultHeading: string
  readonly resultField: string
}

export const DEFAULT_TEXT_TOOL_PROTOCOL: TextToolProtocol = Object.freeze({
  id: 'tool-xml',
  displayName: 'Tool',
  catalogHeading: 'Tools',
  tagName: 'tool',
  prompt: [
    '## Tool Protocol',
    '- Format: `<tool name="NAME">PAYLOAD</tool>`',
    '- Payload: JSON object for JSON tools; raw text for freeform tools',
    '- Limit: at most one tool call per assistant message',
    '- Position: the tool call must appear at the end of the assistant message',
    '- Results: returned in the next user message as a Tool Result',
  ].join('\n'),
  resultHeading: '### Tool Result ###',
  resultField: 'tool',
})
