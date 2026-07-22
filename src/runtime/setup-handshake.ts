export type RuntimeSetupMode = 'full' | 'handshake' | 'skip'

export const SETUP_HANDSHAKE_PROMPT = [
  '# Setup Handshake',
  '- This message initializes the runtime only.',
  '- Reply with READY when initialization is complete.',
].join('\n')

export function hasReadyHandshakeToken(response: string): boolean {
  return /\bREADY\b/i.test(response)
}
