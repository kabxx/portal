interface PlannedSnapshot {
  displayPath: string
  originalExists: boolean
  originalContent: string
  content: string
}

interface DiffLine {
  kind: 'context' | 'add' | 'remove'
  text: string
}

interface DiffRange {
  start: number
  end: number
}

const CONTEXT_LINES = 3

export function buildV4aPreview(files: readonly PlannedSnapshot[]): string {
  const sections: string[] = []
  let additions = 0
  let removals = 0

  for (const file of files) {
    const diff = diffLines(file.originalContent, file.content)
    additions += diff.filter(({ kind }) => kind === 'add').length
    removals += diff.filter(({ kind }) => kind === 'remove').length

    if (!file.originalExists) {
      sections.push(
        [
          `*** Add File: ${file.displayPath}`,
          ...splitLines(file.content).map((line) => `+${line}`),
        ].join('\n')
      )
      continue
    }

    sections.push(
      [`*** Update File: ${file.displayPath}`, ...renderUpdateDiff(diff)].join(
        '\n'
      )
    )
  }

  const fileLabel = `${files.length} file${files.length === 1 ? '' : 's'}`
  return [
    `${fileLabel} · +${additions} -${removals}`,
    '*** Begin Patch',
    ...sections,
    '*** End Patch',
  ].join('\n')
}

function renderUpdateDiff(diff: readonly DiffLine[]): string[] {
  const ranges = buildDiffRanges(diff)
  if (ranges.length === 0) {
    return ['@@']
  }

  return ranges.flatMap(({ start, end }) => [
    '@@',
    ...diff
      .slice(start, end)
      .map((line) => `${prefixFor(line.kind)}${line.text}`),
  ])
}

function prefixFor(kind: DiffLine['kind']): string {
  switch (kind) {
    case 'add':
      return '+'
    case 'remove':
      return '-'
    case 'context':
      return ' '
  }
}

function buildDiffRanges(diff: readonly DiffLine[]): DiffRange[] {
  const ranges: DiffRange[] = []
  for (let index = 0; index < diff.length; index += 1) {
    if (diff[index]?.kind === 'context') {
      continue
    }
    const start = Math.max(0, index - CONTEXT_LINES)
    const end = Math.min(diff.length, index + CONTEXT_LINES + 1)
    const previous = ranges.at(-1)
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end)
    } else {
      ranges.push({ start, end })
    }
  }
  return ranges
}

function diffLines(before: string, after: string): DiffLine[] {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const maxDistance = oldLines.length + newLines.length
  const trace: Map<number, number>[] = []
  let frontier = new Map<number, number>([[0, 0]])

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    const next = new Map<number, number>()
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1
      const right = (frontier.get(diagonal - 1) ?? -1) + 1
      let oldIndex =
        diagonal === -distance || (diagonal !== distance && down > right)
          ? down
          : right
      let newIndex = oldIndex - diagonal

      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex += 1
        newIndex += 1
      }
      next.set(diagonal, oldIndex)

      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        trace.push(next)
        return backtrackDiff(trace, oldLines, newLines)
      }
    }
    trace.push(next)
    frontier = next
  }

  throw new Error('Unable to build V4A snapshot diff')
}

function backtrackDiff(
  trace: readonly Map<number, number>[],
  oldLines: readonly string[],
  newLines: readonly string[]
): DiffLine[] {
  const result: DiffLine[] = []
  let oldIndex = oldLines.length
  let newIndex = newLines.length

  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const frontier = trace[distance - 1]!
    const diagonal = oldIndex - newIndex
    const down = frontier.get(diagonal + 1) ?? -1
    const right = (frontier.get(diagonal - 1) ?? -1) + 1
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && down > right)
        ? diagonal + 1
        : diagonal - 1
    const previousOldIndex = frontier.get(previousDiagonal) ?? 0
    const previousNewIndex = previousOldIndex - previousDiagonal

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      oldIndex -= 1
      newIndex -= 1
      result.push({ kind: 'context', text: oldLines[oldIndex]! })
    }

    if (oldIndex === previousOldIndex) {
      newIndex -= 1
      result.push({ kind: 'add', text: newLines[newIndex]! })
    } else {
      oldIndex -= 1
      result.push({ kind: 'remove', text: oldLines[oldIndex]! })
    }
  }

  while (oldIndex > 0 && newIndex > 0) {
    oldIndex -= 1
    newIndex -= 1
    result.push({ kind: 'context', text: oldLines[oldIndex]! })
  }
  while (oldIndex > 0) {
    oldIndex -= 1
    result.push({ kind: 'remove', text: oldLines[oldIndex]! })
  }
  while (newIndex > 0) {
    newIndex -= 1
    result.push({ kind: 'add', text: newLines[newIndex]! })
  }

  return normalizeChangeOrder(result.reverse())
}

function normalizeChangeOrder(lines: readonly DiffLine[]): DiffLine[] {
  const normalized: DiffLine[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index]?.kind === 'context') {
      normalized.push(lines[index]!)
      index += 1
      continue
    }

    const nextContext = lines.findIndex(
      (line, lineIndex) => lineIndex >= index && line.kind === 'context'
    )
    const changeEnd = nextContext === -1 ? lines.length : nextContext
    normalized.push(
      ...lines.slice(index, changeEnd).filter(({ kind }) => kind === 'remove'),
      ...lines.slice(index, changeEnd).filter(({ kind }) => kind === 'add')
    )
    index = changeEnd
  }
  return normalized
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').split('\n')
}
