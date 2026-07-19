import { stripVTControlCharacters } from 'node:util'

export interface ManualSkillSummary {
  readonly name: string
  readonly description: string
}

export function sanitizeSkillDescription(value: string): string {
  let plainText = ''
  for (const character of stripVTControlCharacters(value)) {
    const codePoint = character.codePointAt(0) ?? 0
    const isControlCharacter =
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    plainText += isControlCharacter ? ' ' : character
  }
  return plainText.replace(/\s+/g, ' ').trim()
}
