export const MAX_INPUT_HINT_LINES = 5

export interface InputHint {
  usage: string
  description: string
  kind: 'command' | 'skill' | 'detail' | 'warning'
  completion?: string
}

function selectableCompletions(
  hints: readonly InputHint[],
  input: string
): readonly string[] {
  return hints.flatMap(({ completion }) =>
    completion !== undefined && completion !== input ? [completion] : []
  )
}

export function resolveInputHintSelection(
  hints: readonly InputHint[],
  input: string,
  selectedCompletion: string | null
): string | null {
  const completions = selectableCompletions(hints, input)
  if (selectedCompletion !== null && completions.includes(selectedCompletion)) {
    return selectedCompletion
  }
  return completions[0] ?? null
}

export function moveInputHintSelection(
  hints: readonly InputHint[],
  input: string,
  selectedCompletion: string | null,
  direction: 'up' | 'down'
): string | null {
  const completions = selectableCompletions(hints, input)
  if (completions.length === 0) {
    return null
  }
  const currentIndex = completions.indexOf(selectedCompletion ?? '')
  const startIndex = currentIndex < 0 ? 0 : currentIndex
  const offset = direction === 'up' ? -1 : 1
  return completions[
    (startIndex + offset + completions.length) % completions.length
  ]!
}

export function navigateInputHintSelection(
  hints: readonly InputHint[],
  input: string,
  selectedCompletion: string | null,
  direction: 'up' | 'down'
): string | null {
  const selected = resolveInputHintSelection(hints, input, selectedCompletion)
  return selected === null
    ? null
    : moveInputHintSelection(hints, input, selected, direction)
}

export function sliceInputHintWindow(
  hints: readonly InputHint[],
  selectedCompletion: string | null,
  maxLines = MAX_INPUT_HINT_LINES
): readonly InputHint[] {
  const limit = Math.max(0, Math.trunc(maxLines))
  if (limit === 0) {
    return []
  }
  if (hints.length <= limit) {
    return hints
  }

  const selectedIndex = hints.findIndex(
    ({ completion }) => completion === selectedCompletion
  )
  const startIndex =
    selectedIndex < limit
      ? 0
      : Math.min(selectedIndex - limit + 1, hints.length - limit)
  return hints.slice(startIndex, startIndex + limit)
}
