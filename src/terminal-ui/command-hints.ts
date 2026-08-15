import type { CommandCompletionSnapshot } from '../cli-commands/core/command-contracts.ts'
import type { CommandSessionRuntime } from '../cli-commands/core/command-runtime.ts'
import type { InputHint } from './input-hints.ts'

export function resolveCommandHints(
  value: string,
  session: CommandSessionRuntime,
  completionSnapshot?: CommandCompletionSnapshot
): readonly InputHint[] {
  if (value.includes('\n')) return []
  return toInputHints(session.analyze(value, completionSnapshot).hints)
}

export function completeSlashCommand(
  value: string,
  session: CommandSessionRuntime,
  completionSnapshot?: CommandCompletionSnapshot
): string {
  if (value.includes('\n')) return value
  return session.analyze(value, completionSnapshot).completion ?? value
}

export function resolveInputSyntaxHighlight(
  value: string,
  session: CommandSessionRuntime
): {
  readonly start: number
  readonly end: number
  readonly kind: 'command'
} | null {
  const spans = session.analyze(value).syntaxSpans
  const first = spans[0]
  const last = spans.at(-1)
  return first === undefined || last === undefined
    ? null
    : { start: first.start, end: last.end, kind: 'command' }
}

export function resolveInputHintGroup(
  value: string,
  session: CommandSessionRuntime,
  completionSnapshot?: CommandCompletionSnapshot
): { readonly title: 'commands'; readonly hints: readonly InputHint[] } | null {
  const hints = resolveCommandHints(value, session, completionSnapshot)
  return hints.length === 0 ? null : { title: 'commands', hints }
}

export function resolveSubmittedInputValue(
  value: string,
  selectedHintCompletion: string | null,
  session: CommandSessionRuntime,
  completionSnapshot?: CommandCompletionSnapshot
): string {
  const analysis = session.analyze(value, completionSnapshot)
  const completions = analysis.hints.flatMap(({ completion }) =>
    completion !== undefined && completion !== value ? [completion] : []
  )
  if (
    selectedHintCompletion !== null &&
    completions.includes(selectedHintCompletion)
  ) {
    return selectedHintCompletion.trimEnd()
  }
  return completions[0]?.trimEnd() ?? value
}

function toInputHints(
  hints: readonly {
    readonly usage: string
    readonly description: string
    readonly kind: 'command' | 'detail' | 'warning'
    readonly completion?: string
  }[]
): readonly InputHint[] {
  return hints.map((hint) => ({
    usage: hint.usage,
    description: hint.description,
    kind: hint.kind,
    ...(hint.completion === undefined ? {} : { completion: hint.completion }),
  }))
}
