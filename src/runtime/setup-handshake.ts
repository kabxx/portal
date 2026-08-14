import { buildSetupHandshakePrompt } from './setup-prompt.ts'

export type RuntimeSetupMode = 'full' | 'handshake' | 'skip'

export const SETUP_HANDSHAKE_PROMPT = buildSetupHandshakePrompt()

export function hasReadyHandshakeToken(response: string): boolean {
  return /\bREADY\b/i.test(response)
}
