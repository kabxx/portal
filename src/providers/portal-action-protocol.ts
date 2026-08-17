import type { TextToolProtocol } from '../tools/core/text-tool-protocol.ts'

export const PORTAL_ACTION_PROTOCOL_PROMPT = [
  '## Portal Action Protocol',
  '- Use the exact, complete format <action name="NAME">PAYLOAD</action>.',
  '- The payload is a JSON object for JSON actions and raw text for freeform actions.',
  '- Each assistant message may contain at most one action call as its final content.',
  '- Action results are returned in the next user message.',
].join('\n')

export const PORTAL_ACTION_PROTOCOL: TextToolProtocol = Object.freeze({
  id: 'portal-action-xml',
  displayName: 'Action',
  catalogHeading: 'Actions',
  tagName: 'action',
  prompt: PORTAL_ACTION_PROTOCOL_PROMPT,
  resultHeading: '### Action Result ###',
  resultField: 'action',
})
