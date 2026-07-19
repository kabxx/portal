import type { ManualSkillSummary } from '../skills/manual-skill-summary.ts'
import type { InputHint } from './input-hints.ts'

export function resolveSkillHints(
  value: string,
  skills: readonly ManualSkillSummary[]
): readonly InputHint[] {
  const match = value.match(/^\$([^\s]*)$/)
  if (match === null) {
    return []
  }

  const prefix = match[1] ?? ''
  return skills
    .filter(({ name }) => name.startsWith(prefix))
    .map(({ name, description }) => ({
      usage: `$${name}`,
      description,
      kind: 'skill' as const,
      completion: `$${name} `,
    }))
}
