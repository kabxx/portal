export type RuntimeSetupMode = 'full' | 'handshake' | 'skip'

export const SETUP_HANDSHAKE_PROMPT = [
  '# Setup Handshake',
  'Reply with exactly: READY',
].join('\n')

export function hasReadyHandshakeToken(response: string): boolean {
  return /\bREADY\b/i.test(response)
}
