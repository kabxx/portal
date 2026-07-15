import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useInput, usePaste, useWindowSize } from 'ink'
import type { CliCommand } from '../cli-commands/core/command-types.ts'
import {
  type TerminalState,
  type TimelineEntry,
  type WelcomeTimelineDetails,
  type BubbleFormat,
  TerminalController,
} from './terminal-controller.ts'
import { render as renderMarkdown } from 'markdansi'

interface TerminalScreenProps {
  ui: TerminalController
  commands: readonly CliCommand[]
  onInterrupt: () => void
}

const CHAT_PADDING_X = 0
const INPUT_PADDING_X = 1
const INPUT_GAP = 1
const INPUT_MARGIN_TOP = 0
const INPUT_TAB_WIDTH = 4
const MIN_MESSAGE_WIDTH = 24
const WELCOME_BORDER_COLOR = 'white'
const WELCOME_LOGO_GLYPHS = [
  { lines: ['█▀█', '█▀▀'], color: '#ff5f57' },
  { lines: ['█▀█', '█▄█'], color: '#ffbd2e' },
  { lines: ['█▀▄', '█▀▄'], color: '#28c840' },
  { lines: ['▀█▀', ' █ '], color: '#22d3ee' },
  { lines: ['█▀█', '█▀█'], color: '#a78bfa' },
  { lines: ['█  ', '█▄▄'], color: '#f472b6' },
] as const
const WELCOME_LOGO = [
  WELCOME_LOGO_GLYPHS.map((glyph) => glyph.lines[0]).join(' '),
  WELCOME_LOGO_GLYPHS.map((glyph) => glyph.lines[1]).join(' '),
] as const
const MIN_WIDE_WELCOME_CONTENT_WIDTH = 48
export const INPUT_CURSOR = '█'
export type InputSyntaxKind = 'command' | 'skill'

export interface InputSyntaxHighlight {
  start: number
  end: number
  kind: InputSyntaxKind
}

export interface InputDisplayRun {
  text: string
  syntax: InputSyntaxKind | null
}

export interface InputCursorDisplay {
  before: readonly InputDisplayRun[]
  cursor: InputDisplayRun & { inverse: boolean }
  after: readonly InputDisplayRun[]
}

const INPUT_SYNTAX_COLOR: Record<InputSyntaxKind, string> = {
  command: 'cyan',
  skill: '#a78bfa',
}
const SPINNER_FRAMES = ['waiting', 'waiting.', 'waiting..', 'waiting...']
const WAITING_INDICATOR_TONES = new Set<TimelineEntry['tone'] | undefined>([
  undefined,
  'info',
  'success',
  'warning',
  'user',
  'tool_result',
])

const TONE_COLOR: Record<TimelineEntry['tone'], string> = {
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  assistant: 'white',
  tool_call: 'magenta',
  tool_result: 'magenta',
  user: 'white',
}

const TONE_LABEL: Record<TimelineEntry['tone'], string> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
  assistant: 'assistant',
  tool_call: 'tool call',
  tool_result: 'tool result',
  user: 'user',
}

export function shouldShowWaitingIndicator(state: TerminalState): boolean {
  return false
}

export interface KeyModifiers {
  return: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

export function isNewlineKey(key: KeyModifiers): boolean {
  return key.return && key.shift && !key.ctrl
}

export function isSubmitKey(key: KeyModifiers): boolean {
  return key.return && !key.shift && !key.ctrl
}

export function clearInput(): string {
  return ''
}

export function normalizePastedInput(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

export function formatInputForDisplay(value: string): string {
  return formatInputSegment(normalizePastedInput(value), 0).text
}

export function formatInputAroundCursor(
  value: string,
  cursor: number
): { before: string; cursor: string; after: string; inverse: boolean } {
  const display = formatInputAroundCursorWithSyntax(value, cursor, null)

  return {
    before: display.before.map(({ text }) => text).join(''),
    cursor: display.cursor.text,
    after: display.after.map(({ text }) => text).join(''),
    inverse: display.cursor.inverse,
  }
}

export function formatInputAroundCursorWithSyntax(
  value: string,
  cursor: number,
  highlight: InputSyntaxHighlight | null
): InputCursorDisplay {
  const safeCursor = clampCursor(value, cursor)
  const normalizedValue = normalizePastedInput(value)
  const normalizedCursor = normalizePastedInput(
    value.slice(0, safeCursor)
  ).length
  const before = formatInputRuns(
    normalizedValue.slice(0, normalizedCursor),
    0,
    0,
    highlight
  )
  const remaining = normalizedValue.slice(normalizedCursor)
  const current = splitGraphemes(remaining)[0] ?? ''

  if (current === '' || current === '\n') {
    return {
      before: before.runs,
      cursor: { text: INPUT_CURSOR, syntax: null, inverse: false },
      after: formatInputRuns(
        remaining,
        normalizedCursor,
        before.column,
        highlight
      ).runs,
    }
  }

  if (current === '\t') {
    const tabWidth = INPUT_TAB_WIDTH - (before.column % INPUT_TAB_WIDTH)
    const syntax = syntaxAtIndex(normalizedCursor, highlight)
    const after: InputDisplayRun[] = []
    appendInputRun(after, ' '.repeat(Math.max(0, tabWidth - 1)), syntax)
    const tail = formatInputRuns(
      remaining.slice(current.length),
      normalizedCursor + current.length,
      before.column + tabWidth,
      highlight
    )
    for (const run of tail.runs) {
      appendInputRun(after, run.text, run.syntax)
    }
    return {
      before: before.runs,
      cursor: { text: ' ', syntax, inverse: true },
      after,
    }
  }

  const currentWidth = estimateGraphemeWidth(current)
  if (currentWidth === 0) {
    return {
      before: before.runs,
      cursor: { text: INPUT_CURSOR, syntax: null, inverse: false },
      after: formatInputRuns(
        remaining,
        normalizedCursor,
        before.column,
        highlight
      ).runs,
    }
  }

  return {
    before: before.runs,
    cursor: {
      text: current,
      syntax: syntaxAtIndex(normalizedCursor, highlight),
      inverse: true,
    },
    after: formatInputRuns(
      remaining.slice(current.length),
      normalizedCursor + current.length,
      before.column + currentWidth,
      highlight
    ).runs,
  }
}

function formatInputRuns(
  value: string,
  offset: number,
  initialColumn: number,
  highlight: InputSyntaxHighlight | null
): { runs: InputDisplayRun[]; column: number } {
  const boundaries = new Set([0, value.length])
  if (highlight !== null) {
    boundaries.add(
      Math.min(value.length, Math.max(0, highlight.start - offset))
    )
    boundaries.add(Math.min(value.length, Math.max(0, highlight.end - offset)))
  }

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b)
  const runs: InputDisplayRun[] = []
  let column = initialColumn
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index]!
    const end = sortedBoundaries[index + 1]!
    const formatted = formatInputSegment(value.slice(start, end), column)
    appendInputRun(
      runs,
      formatted.text,
      syntaxAtIndex(offset + start, highlight)
    )
    column = formatted.column
  }

  return { runs, column }
}

function syntaxAtIndex(
  index: number,
  highlight: InputSyntaxHighlight | null
): InputSyntaxKind | null {
  if (highlight === null || index < highlight.start || index >= highlight.end) {
    return null
  }
  return highlight.kind
}

function appendInputRun(
  runs: InputDisplayRun[],
  text: string,
  syntax: InputSyntaxKind | null
): void {
  if (!text) {
    return
  }
  const previous = runs.at(-1)
  if (previous?.syntax === syntax) {
    previous.text += text
    return
  }
  runs.push({ text, syntax })
}

function formatInputSegment(
  value: string,
  initialColumn: number
): { text: string; column: number } {
  let column = initialColumn
  let formatted = ''

  for (const grapheme of splitGraphemes(value)) {
    if (grapheme === '\n') {
      formatted += grapheme
      column = 0
      continue
    }

    if (grapheme === '\t') {
      const spaces = INPUT_TAB_WIDTH - (column % INPUT_TAB_WIDTH)
      formatted += ' '.repeat(spaces)
      column += spaces
      continue
    }

    formatted += grapheme
    column += estimateGraphemeWidth(grapheme)
  }

  return { text: formatted, column }
}

export function insertAtCursor(
  value: string,
  cursor: number,
  text: string
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor)
  return {
    value: value.slice(0, safeCursor) + text + value.slice(safeCursor),
    cursor: safeCursor + text.length,
  }
}

export function deleteBackwardAtCursor(
  value: string,
  cursor: number
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor)
  const previous = moveCursorHorizontal(value, safeCursor, -1)
  return {
    value: value.slice(0, previous) + value.slice(safeCursor),
    cursor: previous,
  }
}

export function deleteForwardAtCursor(
  value: string,
  cursor: number
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor)
  const next = moveCursorHorizontal(value, safeCursor, 1)
  return {
    value: value.slice(0, safeCursor) + value.slice(next),
    cursor: safeCursor,
  }
}

export function moveCursorHorizontal(
  value: string,
  cursor: number,
  direction: -1 | 1
): number {
  const safeCursor = clampCursor(value, cursor)
  const boundaries = graphemeBoundaries(value)

  if (direction < 0) {
    let previous = 0
    for (const boundary of boundaries) {
      if (boundary >= safeCursor) {
        return previous
      }
      previous = boundary
    }
    return previous
  }

  for (const boundary of boundaries) {
    if (boundary > safeCursor) {
      return boundary
    }
  }
  return value.length
}

export function moveCursorVertical(
  value: string,
  cursor: number,
  direction: -1 | 1,
  preferredColumn?: number
): number {
  const safeCursor = clampCursor(value, cursor)
  const lineStart = value.lastIndexOf('\n', Math.max(-1, safeCursor - 1)) + 1
  const targetColumn =
    preferredColumn ??
    formatInputSegment(value.slice(lineStart, safeCursor), 0).column

  let targetStart: number
  let targetEnd: number
  if (direction < 0) {
    if (lineStart === 0) {
      return safeCursor
    }
    targetEnd = lineStart - 1
    targetStart = value.lastIndexOf('\n', targetEnd - 1) + 1
  } else {
    const lineEnd = value.indexOf('\n', safeCursor)
    if (lineEnd < 0) {
      return safeCursor
    }
    targetStart = lineEnd + 1
    const nextLineEnd = value.indexOf('\n', targetStart)
    targetEnd = nextLineEnd < 0 ? value.length : nextLineEnd
  }

  return cursorAtDisplayColumn(value, targetStart, targetEnd, targetColumn)
}

export function moveCursorToLineBoundary(
  value: string,
  cursor: number,
  boundary: 'start' | 'end'
): number {
  const safeCursor = clampCursor(value, cursor)
  if (boundary === 'start') {
    return value.lastIndexOf('\n', Math.max(-1, safeCursor - 1)) + 1
  }
  const lineEnd = value.indexOf('\n', safeCursor)
  return lineEnd < 0 ? value.length : lineEnd
}

function cursorDisplayColumn(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor)
  const lineStart = value.lastIndexOf('\n', Math.max(-1, safeCursor - 1)) + 1
  return formatInputSegment(value.slice(lineStart, safeCursor), 0).column
}

export function shouldNavigateInputHistory(
  inputValue: string,
  browsingHistory: boolean
): boolean {
  return inputValue.length === 0 || browsingHistory
}

function cursorAtDisplayColumn(
  value: string,
  lineStart: number,
  lineEnd: number,
  targetColumn: number
): number {
  let cursor = lineStart
  let column = 0
  for (const grapheme of splitGraphemes(value.slice(lineStart, lineEnd))) {
    const nextColumn =
      grapheme === '\t'
        ? column + (INPUT_TAB_WIDTH - (column % INPUT_TAB_WIDTH))
        : column + estimateGraphemeWidth(grapheme)
    if (nextColumn > targetColumn) {
      return cursor
    }
    cursor += grapheme.length
    column = nextColumn
    if (column === targetColumn) {
      return cursor
    }
  }
  return lineEnd
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0]
  let cursor = 0
  for (const grapheme of splitGraphemes(value)) {
    cursor += grapheme.length
    boundaries.push(cursor)
  }
  return boundaries
}

function clampCursor(value: string, cursor: number): number {
  return Math.min(value.length, Math.max(0, Math.trunc(cursor)))
}

export function deletePreviousWord(value: string): string {
  return value.replace(/\s*\S+\s*$/, '')
}

function deletePreviousWordAtCursor(
  value: string,
  cursor: number
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor)
  const before = deletePreviousWord(value.slice(0, safeCursor))
  return {
    value: before + value.slice(safeCursor),
    cursor: before.length,
  }
}

export function completeSlashCommand(
  value: string,
  commands: readonly CliCommand[]
): string {
  const match = value.match(/^\/(\S+)(?: +(\S*))?$/)
  if (match === null) {
    return value
  }

  const commandPrefix = match[1] ?? ''
  const subcommandPrefix = match[2]
  if (subcommandPrefix === undefined) {
    const matches = commands
      .map((command) => command.name.replace(/^\/+/, ''))
      .filter((name) => name.startsWith(commandPrefix))
    return matches.length === 1 ? `/${matches[0]} ` : value
  }

  const command = commands.find(
    (item) => item.name.replace(/^\/+/, '') === commandPrefix
  )
  const matches =
    command?.subcommands?.filter((name) => name.startsWith(subcommandPrefix)) ??
    []
  if (matches.length !== 1) {
    return value
  }

  return `/${commandPrefix} ${matches[0]} `
}

export function completeManualSkill(
  value: string,
  cursor: number,
  manualSkillNames: readonly string[]
): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor)
  const beforeCursor = value.slice(0, safeCursor)
  const match = beforeCursor.match(/^\$(\S*)$/)
  if (match === null) {
    return { value, cursor: safeCursor }
  }

  const suffix = value.slice(safeCursor)
  if (suffix.length > 0 && !/^\s/.test(suffix)) {
    return { value, cursor: safeCursor }
  }

  const prefix = match[1] ?? ''
  const matches = manualSkillNames.filter((name) => name.startsWith(prefix))
  if (matches.length !== 1) {
    return { value, cursor: safeCursor }
  }

  const completedToken = `$${matches[0]}`
  const replacement =
    suffix.length === 0 ? `${completedToken} ` : completedToken
  const tokenStart = beforeCursor.length - match[0].length
  return {
    value: value.slice(0, tokenStart) + replacement + suffix,
    cursor: tokenStart + replacement.length,
  }
}

export function resolveInputSyntaxHighlight(
  value: string,
  commands: readonly CliCommand[],
  manualSkillNames: readonly string[]
): InputSyntaxHighlight | null {
  const normalized = normalizePastedInput(value)
  const trimmed = normalized.trimStart()
  const start = normalized.length - trimmed.length

  const command = commands.find(
    ({ name }) =>
      trimmed.startsWith(name) && hasInputTokenBoundary(trimmed, name.length)
  )
  if (command !== undefined) {
    let end = command.name.length
    const subcommandMatch = trimmed
      .slice(command.name.length)
      .match(/^(\s+)(\S+)/)
    const subcommand = subcommandMatch?.[2]
    if (
      subcommand !== undefined &&
      command.subcommands?.includes(subcommand) === true
    ) {
      end += subcommandMatch![1]!.length + subcommand.length
    }
    return { start, end: start + end, kind: 'command' }
  }

  const skillName = manualSkillNames.find((name) => {
    const token = `$${name}`
    return (
      trimmed.startsWith(token) && hasInputTokenBoundary(trimmed, token.length)
    )
  })
  if (skillName === undefined) {
    return null
  }

  return {
    start,
    end: start + skillName.length + 1,
    kind: 'skill',
  }
}

function hasInputTokenBoundary(value: string, index: number): boolean {
  const next = value[index]
  return next === undefined || /\s/.test(next)
}

export function shouldInterruptForKey({
  busy,
  input,
  inputValue,
  key,
}: {
  busy: boolean
  input: string
  inputValue: string
  key: { ctrl?: boolean }
}): boolean {
  if (key.ctrl === true && input === 'c') {
    return busy
  }

  if (key.ctrl === true && input === 'd') {
    return !busy && inputValue.length === 0
  }

  return false
}

export function shouldClearInputForCtrlC({
  busy,
  input,
  inputValue,
  key,
}: {
  busy: boolean
  input: string
  inputValue: string
  key: { ctrl?: boolean }
}): boolean {
  return !busy && inputValue.length > 0 && key.ctrl === true && input === 'c'
}

export function canSubmitInput(inputValue: string, busy: boolean): boolean {
  return !busy || inputValue.trimStart().startsWith('/')
}

class InputHistory {
  private readonly entries: string[] = []
  private cursor: number | null = null

  public push(value: string) {
    const normalized = value.trim()
    if (!normalized) {
      this.resetCursor()
      return
    }

    if (this.entries.at(-1) !== normalized) {
      this.entries.push(normalized)
    }
    this.resetCursor()
  }

  public previous(): string | null {
    if (this.entries.length === 0) {
      return null
    }

    if (this.cursor === null) {
      this.cursor = this.entries.length - 1
      return this.entries[this.cursor]!
    }

    this.cursor = Math.max(0, this.cursor - 1)
    return this.entries[this.cursor]!
  }

  public next(): string {
    if (this.entries.length === 0) {
      return ''
    }

    if (this.cursor === null) {
      return ''
    }

    if (this.cursor >= this.entries.length - 1) {
      this.resetCursor()
      return ''
    }

    this.cursor += 1
    return this.entries[this.cursor]!
  }

  public resetCursor() {
    this.cursor = null
  }

  public isBrowsing(): boolean {
    return this.cursor !== null
  }
}

interface InputEditorState {
  value: string
  cursor: number
  preferredColumn: number | null
}

export function describeInputPanel(
  state: TerminalState,
  inputValue: string,
  spinnerText: string
): {
  bodyColor: string | undefined
  bodyText: string
  labelText: string
  labelColor: string
  showCursor: boolean
} {
  const labelText = state.prompt.label.trimEnd()

  if (state.prompt.active) {
    return {
      bodyColor: undefined,
      bodyText: formatInputForDisplay(inputValue || ' '),
      labelText: state.busy ? appendPromptStatus(labelText, 'busy') : labelText,
      labelColor: state.busy ? 'yellow' : 'gray',
      showCursor: true,
    }
  }

  if (state.busy) {
    return {
      bodyColor: undefined,
      bodyText: formatInputForDisplay(inputValue || ' '),
      labelText: appendPromptStatus(labelText, 'busy'),
      labelColor: 'yellow',
      showCursor: true,
    }
  }

  return {
    bodyColor: undefined,
    bodyText: ' ',
    labelText: appendPromptStatus(labelText, 'locked'),
    labelColor: 'blackBright',
    showCursor: false,
  }
}

export function TerminalScreen({
  ui,
  commands,
  onInterrupt,
}: TerminalScreenProps) {
  const [state, setState] = useState<TerminalState>(ui.getState())
  const [inputState, setInputState] = useState<InputEditorState>({
    value: '',
    cursor: 0,
    preferredColumn: null,
  })
  const [spinnerFrameIndex, setSpinnerFrameIndex] = useState(0)
  const historyRef = useRef(new InputHistory())
  const { columns, rows } = useWindowSize()
  const inputValue = inputState.value

  useEffect(() => {
    return ui.subscribe(() => {
      setState(ui.getState())
    })
  }, [ui])

  useEffect(() => {
    if (!state.prompt.active && !state.busy) {
      setInputState({ value: '', cursor: 0, preferredColumn: null })
      historyRef.current.resetCursor()
    }
  }, [state.prompt.active])

  useEffect(() => {
    if (!state.busy) {
      setSpinnerFrameIndex(0)
      return
    }

    const timer = setInterval(() => {
      setSpinnerFrameIndex((current) => (current + 1) % SPINNER_FRAMES.length)
    }, 250)

    return () => {
      clearInterval(timer)
    }
  }, [state.busy])

  useInput((input, key) => {
    if (
      shouldInterruptForKey({
        busy: state.busy,
        input,
        inputValue,
        key,
      })
    ) {
      onInterrupt()
      return
    }

    if (
      shouldClearInputForCtrlC({
        busy: state.busy,
        input,
        inputValue,
        key,
      })
    ) {
      setInputState({
        value: clearInput(),
        cursor: 0,
        preferredColumn: null,
      })
      historyRef.current.resetCursor()
      return
    }

    if (key.ctrl && input === 'c') {
      return
    }

    if (key.ctrl && input === 'd') {
      return
    }

    if (!state.prompt.active) {
      return
    }

    if (key.ctrl && input === 'u') {
      setInputState({
        value: clearInput(),
        cursor: 0,
        preferredColumn: null,
      })
      historyRef.current.resetCursor()
      return
    }

    if (key.ctrl && input === 'w') {
      historyRef.current.resetCursor()
      setInputState((current) => ({
        ...deletePreviousWordAtCursor(current.value, current.cursor),
        preferredColumn: null,
      }))
      return
    }

    if (key.tab || input === '\t') {
      const trimmedInput = inputValue.trimStart()
      if (
        state.busy &&
        !trimmedInput.startsWith('/') &&
        !trimmedInput.startsWith('$')
      ) {
        return
      }
      historyRef.current.resetCursor()
      setInputState((current) => {
        const commandValue = completeSlashCommand(current.value, commands)
        if (commandValue !== current.value) {
          return {
            value: commandValue,
            cursor: commandValue.length,
            preferredColumn: null,
          }
        }

        const skillCompletion = completeManualSkill(
          current.value,
          current.cursor,
          ui.getActiveManualSkillNames()
        )
        return { ...skillCompletion, preferredColumn: null }
      })
      return
    }

    if (isNewlineKey(key)) {
      historyRef.current.resetCursor()
      setInputState((current) => ({
        ...insertAtCursor(current.value, current.cursor, '\n'),
        preferredColumn: null,
      }))
      return
    }

    if (isSubmitKey(key)) {
      const currentState = ui.getState()
      if (
        !currentState.prompt.active ||
        !canSubmitInput(inputValue, currentState.busy)
      ) {
        return
      }
      if (!ui.submitInput(inputValue)) return
      historyRef.current.push(inputValue)
      setInputState({ value: '', cursor: 0, preferredColumn: null })
      return
    }

    if (key.backspace || key.delete) {
      historyRef.current.resetCursor()
      setInputState((current) => ({
        ...(key.backspace
          ? deleteBackwardAtCursor(current.value, current.cursor)
          : deleteForwardAtCursor(current.value, current.cursor)),
        preferredColumn: null,
      }))
      return
    }

    if (key.home || (key.ctrl && input === 'a')) {
      setInputState((current) => ({
        ...current,
        cursor: moveCursorToLineBoundary(
          current.value,
          current.cursor,
          'start'
        ),
        preferredColumn: null,
      }))
      return
    }

    if (key.end || (key.ctrl && input === 'e')) {
      setInputState((current) => ({
        ...current,
        cursor: moveCursorToLineBoundary(current.value, current.cursor, 'end'),
        preferredColumn: null,
      }))
      return
    }

    if (key.leftArrow && !key.ctrl && !key.meta) {
      setInputState((current) => ({
        ...current,
        cursor: moveCursorHorizontal(current.value, current.cursor, -1),
        preferredColumn: null,
      }))
      return
    }

    if (key.rightArrow && !key.ctrl && !key.meta) {
      setInputState((current) => ({
        ...current,
        cursor: moveCursorHorizontal(current.value, current.cursor, 1),
        preferredColumn: null,
      }))
      return
    }

    if (key.upArrow && !key.ctrl && !key.meta) {
      if (
        shouldNavigateInputHistory(inputValue, historyRef.current.isBrowsing())
      ) {
        const previous = historyRef.current.previous()
        if (previous !== null) {
          setInputState({
            value: previous,
            cursor: previous.length,
            preferredColumn: null,
          })
        }
      } else {
        setInputState((current) => {
          const preferredColumn =
            current.preferredColumn ??
            cursorDisplayColumn(current.value, current.cursor)
          return {
            ...current,
            cursor: moveCursorVertical(
              current.value,
              current.cursor,
              -1,
              preferredColumn
            ),
            preferredColumn,
          }
        })
      }
      return
    }

    if (key.downArrow && !key.ctrl && !key.meta) {
      if (
        shouldNavigateInputHistory(inputValue, historyRef.current.isBrowsing())
      ) {
        const next = historyRef.current.next()
        setInputState({
          value: next,
          cursor: next.length,
          preferredColumn: null,
        })
      } else {
        setInputState((current) => {
          const preferredColumn =
            current.preferredColumn ??
            cursorDisplayColumn(current.value, current.cursor)
          return {
            ...current,
            cursor: moveCursorVertical(
              current.value,
              current.cursor,
              1,
              preferredColumn
            ),
            preferredColumn,
          }
        })
      }
      return
    }

    if (key.escape) {
      setInputState({ value: '', cursor: 0, preferredColumn: null })
      historyRef.current.resetCursor()
      return
    }

    if (key.ctrl || key.meta) {
      return
    }

    if (input) {
      historyRef.current.resetCursor()
      const text = normalizePastedInput(input)
      setInputState((current) => ({
        ...insertAtCursor(current.value, current.cursor, text),
        preferredColumn: null,
      }))
    }
  })

  usePaste((text) => {
    if (!state.prompt.active) {
      return
    }

    historyRef.current.resetCursor()
    const normalizedText = normalizePastedInput(text)
    setInputState((current) => ({
      ...insertAtCursor(current.value, current.cursor, normalizedText),
      preferredColumn: null,
    }))
  })

  const inputDisplay = describeInputPanel(
    state,
    inputValue,
    SPINNER_FRAMES[spinnerFrameIndex]!
  )
  const inputHighlight = resolveInputSyntaxHighlight(
    inputValue,
    commands,
    ui.getActiveManualSkillNames()
  )
  const inputCursorDisplay = formatInputAroundCursorWithSyntax(
    inputValue,
    inputState.cursor,
    inputHighlight
  )
  const inputLabelWidth = Math.min(
    Math.max(2, estimateDisplayWidth(inputDisplay.labelText)),
    Math.max(2, columns - INPUT_PADDING_X * 2 - 2)
  )
  const bubbleWidth = Math.max(
    MIN_MESSAGE_WIDTH,
    columns - CHAT_PADDING_X * 2 - 1
  )
  const connectingWelcome =
    state.timeline.find(
      (entry) => entry.welcome?.browserStatus === 'connecting'
    ) ?? null
  const staticTimeline =
    connectingWelcome === null
      ? state.timeline
      : state.timeline.filter((entry) => entry.id !== connectingWelcome.id)

  return (
    <>
      <Static
        key={`${state.timelineVersion}:${bubbleWidth}`}
        items={staticTimeline}
      >
        {(entry) => (
          <TimelineBubble entry={entry} key={entry.id} width={bubbleWidth} />
        )}
      </Static>

      <Box flexDirection="column" paddingBottom={0}>
        <ChatPanel
          bubbleWidth={bubbleWidth}
          connectingWelcome={connectingWelcome}
          spinnerText={SPINNER_FRAMES[spinnerFrameIndex]!}
          state={state}
        />

        <InputPanel
          display={inputDisplay}
          cursorDisplay={inputCursorDisplay}
          inputLabelWidth={inputLabelWidth}
          columns={columns}
        />
      </Box>
    </>
  )
}

function ChatPanel({
  state,
  bubbleWidth,
  connectingWelcome,
  spinnerText,
}: {
  state: TerminalState
  bubbleWidth: number
  connectingWelcome: TimelineEntry | null
  spinnerText: string
}) {
  const shouldShowWaiting = shouldShowWaitingIndicator(state)

  return (
    <Box flexDirection="column" width="100%">
      {connectingWelcome ? (
        <TimelineBubble
          entry={connectingWelcome}
          key={connectingWelcome.id}
          width={bubbleWidth}
        />
      ) : null}

      {state.liveAssistant ? (
        <TimelineBubble
          entry={state.liveAssistant}
          key={state.liveAssistant.id}
          width={bubbleWidth}
        />
      ) : null}

      {state.liveCommand ? (
        <TimelineBubble
          entry={state.liveCommand}
          key={state.liveCommand.id}
          width={bubbleWidth}
          labelOverride={formatLiveCommandTitle(
            state.liveCommand.toolName,
            state.liveCommand.startedAt
          )}
          {...(state.liveCommand.fixedLineCount === undefined
            ? {}
            : { fixedLineCount: state.liveCommand.fixedLineCount })}
        />
      ) : null}

      {shouldShowWaiting ? (
        <TimelineBubble
          entry={{
            id: -1,
            tone: 'assistant',
            label: 'assistant',
            body: spinnerText,
            format: 'plain',
          }}
          width={bubbleWidth}
        />
      ) : null}
    </Box>
  )
}

function InputPanel({
  display,
  cursorDisplay,
  inputLabelWidth,
  columns,
}: {
  display: ReturnType<typeof describeInputPanel>
  cursorDisplay: ReturnType<typeof formatInputAroundCursorWithSyntax>
  inputLabelWidth: number
  columns: number
}) {
  const separatorLine = '─'.repeat(Math.max(0, columns))
  const cursorColor = cursorDisplay.cursor.inverse
    ? inputRunColor(cursorDisplay.cursor.syntax, display.bodyColor)
    : 'gray'

  return (
    <Box flexDirection="column" marginTop={INPUT_MARGIN_TOP} width="100%">
      <Text color={display.labelColor}>{separatorLine}</Text>

      <Box
        flexDirection="row"
        gap={INPUT_GAP}
        paddingX={INPUT_PADDING_X}
        width="100%"
      >
        <Box flexShrink={0} width={inputLabelWidth}>
          <Text color={display.labelColor}>{display.labelText}</Text>
        </Box>

        <Box flexGrow={1}>
          <Text wrap="wrap">
            {display.showCursor ? (
              <>
                {cursorDisplay.before.map((run, index) => {
                  const color = inputRunColor(run.syntax, display.bodyColor)
                  return (
                    <Text
                      {...(color === undefined ? {} : { color })}
                      key={`before-${index}`}
                    >
                      {run.text}
                    </Text>
                  )
                })}
                <Text
                  {...(cursorColor === undefined ? {} : { color: cursorColor })}
                  {...(cursorDisplay.cursor.inverse ? { inverse: true } : {})}
                >
                  {cursorDisplay.cursor.text}
                </Text>
                {cursorDisplay.after.map((run, index) => {
                  const color = inputRunColor(run.syntax, display.bodyColor)
                  return (
                    <Text
                      {...(color === undefined ? {} : { color })}
                      key={`after-${index}`}
                    >
                      {run.text}
                    </Text>
                  )
                })}
              </>
            ) : (
              <Text
                {...(display.bodyColor ? { color: display.bodyColor } : {})}
              >
                {display.bodyText}
              </Text>
            )}
          </Text>
        </Box>
      </Box>

      <Text color={display.labelColor}>{separatorLine}</Text>
    </Box>
  )
}

function inputRunColor(
  syntax: InputSyntaxKind | null,
  fallback: string | undefined
): string | undefined {
  return syntax === null ? fallback : INPUT_SYNTAX_COLOR[syntax]
}

function appendPromptStatus(labelText: string, status: string): string {
  const trimmedStatus = status.trim()
  if (!trimmedStatus) {
    return labelText
  }

  const trimmed = labelText.trimEnd()
  if (trimmed.endsWith('>')) {
    return `${trimmed.slice(0, -1).trimEnd()} [${trimmedStatus}] > `
  }

  return `${labelText} [${trimmedStatus}]`
}

function TimelineBubble({
  entry,
  width,
  labelOverride,
  fixedLineCount,
}: {
  entry: TimelineEntry
  width: number
  labelOverride?: string
  fixedLineCount?: number
}) {
  if (entry.welcome !== undefined) {
    return (
      <WelcomeBubble
        details={entry.welcome}
        label={entry.label}
        width={width}
      />
    )
  }

  const toneColor = TONE_COLOR[entry.tone]
  const useEntryLabel = entry.tone !== 'assistant' && entry.tone !== 'user'
  const label =
    labelOverride ??
    (useEntryLabel
      ? entry.label || TONE_LABEL[entry.tone]
      : TONE_LABEL[entry.tone])
  const contentWidth = Math.max(1, width - 4)

  const rendered = renderBubbleBody(entry.body, entry.format, contentWidth)
  const renderedLines = rendered.length > 0 ? rendered.split('\n') : ['']
  const wrappedLines =
    fixedLineCount === undefined
      ? renderedLines.flatMap((line) => wrapAnsiLine(line, contentWidth))
      : fixedLines(renderedLines, fixedLineCount).map((line) =>
          truncateAnsiLine(line, contentWidth)
        )

  return (
    <Box flexDirection="column" width={width}>
      <Text color={toneColor}>{buildBubbleTopLine(label, width)}</Text>
      {wrappedLines.map((line, index) => (
        <Text key={index}>
          <Text color={toneColor}>│ </Text>
          <Text>{padToWidthAnsi(line, contentWidth)}</Text>
          <Text color={toneColor}> │</Text>
        </Text>
      ))}
      <Text color={toneColor}>{`└${'─'.repeat(Math.max(0, width - 2))}┘`}</Text>
    </Box>
  )
}

export interface WelcomeRow {
  kind: 'plain' | 'compact-logo' | 'wide-logo-top' | 'wide-logo-bottom'
  text: string
  tone: 'brand' | 'default' | 'muted'
}

export function buildWelcomeRows(
  details: WelcomeTimelineDetails,
  contentWidth: number
): WelcomeRow[] {
  const safeWidth = Math.max(1, contentWidth)
  const version = `v${details.version}`
  const status =
    details.browserStatus === 'connecting'
      ? '◌ Browser connecting'
      : details.browserStatus === 'connected'
        ? '● Browser connected'
        : '○ Browser disconnected'
  const wideLayout =
    safeWidth >=
    Math.max(
      MIN_WIDE_WELCOME_CONTENT_WIDTH,
      estimateDisplayWidth(WELCOME_LOGO[0]) + 1 + estimateDisplayWidth(version)
    )

  if (!wideLayout) {
    return [
      { kind: 'plain', text: '', tone: 'default' },
      { kind: 'compact-logo', text: `PORTAL ${version}`, tone: 'brand' },
      { kind: 'plain', text: '', tone: 'default' },
      { kind: 'plain', text: status, tone: 'default' },
      {
        kind: 'plain',
        text: truncateMiddleLine(details.directory, safeWidth),
        tone: 'muted',
      },
    ]
  }

  return [
    { kind: 'plain', text: '', tone: 'default' },
    {
      kind: 'wide-logo-top',
      text: alignWelcomeHeader(WELCOME_LOGO[0], version, safeWidth),
      tone: 'brand',
    },
    { kind: 'wide-logo-bottom', text: WELCOME_LOGO[1], tone: 'brand' },
    { kind: 'plain', text: '', tone: 'default' },
    { kind: 'plain', text: status, tone: 'default' },
    {
      kind: 'plain',
      text: truncateMiddleLine(details.directory, safeWidth),
      tone: 'muted',
    },
  ]
}

function WelcomeBubble({
  details,
  label,
  width,
}: {
  details: WelcomeTimelineDetails
  label: string
  width: number
}) {
  const contentWidth = Math.max(1, width - 4)
  const rows = buildWelcomeRows(details, contentWidth)

  return (
    <Box flexDirection="column" width={width}>
      <Text color={WELCOME_BORDER_COLOR}>
        {buildBubbleTopLine(label, width)}
      </Text>
      {rows.map((row, index) => {
        return (
          <Text key={index}>
            <Text color={WELCOME_BORDER_COLOR}>│ </Text>
            <WelcomeRowContent
              contentWidth={contentWidth}
              row={row}
              version={details.version}
            />
            <Text color={WELCOME_BORDER_COLOR}> │</Text>
          </Text>
        )
      })}
      <Text color={WELCOME_BORDER_COLOR}>
        {`└${'─'.repeat(Math.max(0, width - 2))}┘`}
      </Text>
    </Box>
  )
}

function WelcomeRowContent({
  contentWidth,
  row,
  version,
}: {
  contentWidth: number
  row: WelcomeRow
  version: string
}) {
  if (row.kind === 'compact-logo') {
    const suffix = truncateAnsiLine(
      ` v${version}`,
      Math.max(0, contentWidth - WELCOME_LOGO_GLYPHS.length)
    )
    const padding = Math.max(
      0,
      contentWidth - WELCOME_LOGO_GLYPHS.length - estimateDisplayWidth(suffix)
    )

    return (
      <Text>
        {'PORTAL'.split('').map((letter, index) => (
          <Text bold color={WELCOME_LOGO_GLYPHS[index]!.color} key={letter}>
            {letter}
          </Text>
        ))}
        <Text color="gray">{suffix}</Text>
        <Text>{' '.repeat(padding)}</Text>
      </Text>
    )
  }

  if (row.kind === 'wide-logo-top' || row.kind === 'wide-logo-bottom') {
    const line = row.kind === 'wide-logo-top' ? 0 : 1
    const logoWidth = estimateDisplayWidth(WELCOME_LOGO[line])
    const versionText = `v${version}`
    const suffix =
      line === 0
        ? `${' '.repeat(
            Math.max(
              1,
              contentWidth - logoWidth - estimateDisplayWidth(versionText)
            )
          )}${versionText}`
        : ''
    const padding = Math.max(
      0,
      contentWidth - logoWidth - estimateDisplayWidth(suffix)
    )

    return (
      <Text>
        {WELCOME_LOGO_GLYPHS.map((glyph, index) => (
          <Text bold color={glyph.color} key={glyph.color}>
            {index === 0 ? glyph.lines[line] : ` ${glyph.lines[line]}`}
          </Text>
        ))}
        {suffix ? <Text color="gray">{suffix}</Text> : null}
        <Text>{' '.repeat(padding)}</Text>
      </Text>
    )
  }

  const text = truncateAnsiLine(row.text, contentWidth)
  const color = row.tone === 'muted' ? 'gray' : undefined

  return (
    <Text {...(color === undefined ? {} : { color })}>
      {padToWidthAnsi(text, contentWidth)}
    </Text>
  )
}

function alignWelcomeHeader(
  left: string,
  right: string,
  width: number
): string {
  const gap = Math.max(
    1,
    width - estimateDisplayWidth(left) - estimateDisplayWidth(right)
  )
  return truncateAnsiLine(`${left}${' '.repeat(gap)}${right}`, width)
}

export function truncateMiddleLine(value: string, width: number): string {
  const safeWidth = Math.max(0, width)
  if (estimateDisplayWidth(value) <= safeWidth) {
    return value
  }
  if (safeWidth === 0) {
    return ''
  }
  if (safeWidth === 1) {
    return '…'
  }

  const ellipsis = '…'
  const availableWidth = safeWidth - estimateDisplayWidth(ellipsis)
  const leftBudget = Math.ceil(availableWidth / 2)
  const rightBudget = availableWidth - leftBudget
  const graphemes = splitGraphemes(value)
  let left = ''
  let leftWidth = 0
  let leftIndex = 0
  while (leftIndex < graphemes.length) {
    const grapheme = graphemes[leftIndex]!
    const graphemeWidth = estimateDisplayWidth(grapheme)
    if (leftWidth + graphemeWidth > leftBudget) {
      break
    }
    left += grapheme
    leftWidth += graphemeWidth
    leftIndex += 1
  }

  let right = ''
  let rightWidth = 0
  let rightIndex = graphemes.length - 1
  while (rightIndex >= leftIndex) {
    const grapheme = graphemes[rightIndex]!
    const graphemeWidth = estimateDisplayWidth(grapheme)
    if (rightWidth + graphemeWidth > rightBudget) {
      break
    }
    right = grapheme + right
    rightWidth += graphemeWidth
    rightIndex -= 1
  }

  return `${left}${ellipsis}${right}`
}

const MARKDOWN_RENDER_OPTIONS = {
  codeBox: true,
  codeWrap: true,
  tableBorder: 'unicode' as const,
  tableTruncate: false,
  wrap: true,
}

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g

function collectLeadingAnsi(value: string): string {
  let leading = ''
  let match: RegExpExecArray | null
  ANSI_SGR_RE.lastIndex = 0
  while ((match = ANSI_SGR_RE.exec(value)) !== null) {
    if (match.index === leading.length) {
      leading += match[0]
    } else {
      break
    }
  }
  ANSI_SGR_RE.lastIndex = 0
  return leading
}

function wrapAnsiLine(value: string, maxWidth: number): string[] {
  const safeWidth = Math.max(1, maxWidth)
  if (!value) return ['']

  const plain = value.replace(ANSI_SGR_RE, '')
  if (estimateDisplayWidth(plain) <= safeWidth) {
    return [value]
  }

  const leadingAnsi = collectLeadingAnsi(value)
  const segments: string[] = []
  let current = leadingAnsi
  let currentWidth = 0

  for (const grapheme of splitGraphemes(plain)) {
    const charWidth = estimateDisplayWidth(grapheme)
    if (currentWidth > 0 && currentWidth + charWidth > safeWidth) {
      segments.push(current)
      current = leadingAnsi + grapheme
      currentWidth = charWidth
    } else {
      current += grapheme
      currentWidth += charWidth
    }
  }

  if (current || segments.length === 0) {
    segments.push(current)
  }

  return segments
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_SGR_RE, '')
}

function padToWidthAnsi(value: string, width: number): string {
  const plain = stripAnsi(value)
  const currentWidth = estimateDisplayWidth(plain)
  if (currentWidth >= width) return value
  return value + ' '.repeat(width - currentWidth)
}

export function renderBubbleBody(
  body: string,
  format: BubbleFormat,
  width: number
): string {
  if (format === 'v4a') {
    return renderV4aBody(body)
  }
  if (format === 'markdown') {
    return renderMarkdown(body || ' ', {
      ...MARKDOWN_RENDER_OPTIONS,
      width,
    }).replace(/\n+$/, '')
  }

  return body
}

function renderV4aBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line, index) => {
      if (index === 0) {
        return `\u001B[1m${line}\u001B[22m`
      }
      if (line.startsWith('***')) {
        return `\u001B[36m${line}\u001B[39m`
      }
      if (line.startsWith('@@')) {
        return `\u001B[33m${line}\u001B[39m`
      }
      if (line.startsWith('+')) {
        return `\u001B[32m${line}\u001B[39m`
      }
      if (line.startsWith('-')) {
        return `\u001B[31m${line}\u001B[39m`
      }
      return `\u001B[2m${line}\u001B[22m`
    })
    .join('\n')
}

function buildBubbleTopLine(label: string, width: number): string {
  const safeInnerWidth = Math.max(0, width - 2)
  const title = truncateAnsiLine(` ${label} `, safeInnerWidth)
  const titleWidth = Math.min(estimateDisplayWidth(title), safeInnerWidth)
  const remainingWidth = Math.max(0, safeInnerWidth - titleWidth)
  return `┌${title}${'─'.repeat(remainingWidth)}┐`
}

export function formatLiveCommandTitle(
  toolName: string,
  startedAt: number,
  now = Date.now()
): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${toolName} · running · ${elapsedSeconds}s`
}

function fixedLines(lines: readonly string[], count: number): string[] {
  const safeCount = Math.max(0, count)
  const visible = safeCount === 0 ? [] : lines.slice(-safeCount)
  return [
    ...Array.from(
      { length: Math.max(0, safeCount - visible.length) },
      () => ''
    ),
    ...visible,
  ]
}

const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

const COMBINING_MARK_REGEX = /\p{Mark}/u
const EMOJI_GRAPHEME_REGEX = /[\p{Extended_Pictographic}\u200d\ufe0f\u20e3]/u

export function wrapSingleLine(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  if (!value) {
    return ['']
  }

  const segments: string[] = []
  let current = ''
  let currentWidth = 0

  for (const char of splitGraphemes(value)) {
    const charWidth = estimateDisplayWidth(char)
    if (currentWidth > 0 && currentWidth + charWidth > safeWidth) {
      segments.push(current)
      current = char
      currentWidth = charWidth
      continue
    }

    current += char
    currentWidth += charWidth
  }

  if (current || segments.length === 0) {
    segments.push(current)
  }

  return segments
}

export function truncateAnsiLine(value: string, width: number): string {
  const safeWidth = Math.max(0, width)
  if (safeWidth === 0) {
    return ''
  }
  if (estimateDisplayWidth(stripAnsi(value)) <= safeWidth) {
    return value
  }

  const ellipsis = '…'
  const ellipsisWidth = estimateDisplayWidth(ellipsis)
  const leadingAnsi = collectLeadingAnsi(value)
  const plain = stripAnsi(value)
  let current = ''
  let currentWidth = 0
  for (const grapheme of splitGraphemes(plain)) {
    const charWidth = estimateDisplayWidth(grapheme)
    if (currentWidth + charWidth + ellipsisWidth > safeWidth) {
      break
    }
    current += grapheme
    currentWidth += charWidth
  }

  return `${leadingAnsi}${current}${ellipsis}`
}

function estimateTextRows(value: string, width: number): number {
  const safeWidth = Math.max(1, width)

  return value.split(/\r?\n/).reduce((total, line) => {
    return (
      total + Math.max(1, Math.ceil(estimateDisplayWidth(line) / safeWidth))
    )
  }, 0)
}

export function estimateDisplayWidth(value: string): number {
  let width = 0

  for (const grapheme of splitGraphemes(value)) {
    width += estimateGraphemeWidth(grapheme)
  }

  return Math.max(0, width)
}

function splitGraphemes(value: string): string[] {
  if (GRAPHEME_SEGMENTER === null) {
    return Array.from(value)
  }

  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment)
}

function estimateGraphemeWidth(grapheme: string): number {
  if (!grapheme) {
    return 0
  }

  if (EMOJI_GRAPHEME_REGEX.test(grapheme)) {
    return 2
  }

  let width = 0
  for (const char of Array.from(grapheme)) {
    if (isZeroWidthCharacter(char)) {
      continue
    }
    width += isWideCharacter(char) ? 2 : 1
  }

  return width
}

function isZeroWidthCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0
  return (
    codePoint === 0x200d ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    COMBINING_MARK_REGEX.test(char)
  )
}

function isWideCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0

  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6))
  )
}
