import test from 'node:test'
import assert from 'node:assert/strict'
import type { CliCommand } from '../../src/cli-commands/core/command-types.ts'

import {
  INPUT_CURSOR,
  buildWelcomeRows,
  calculateBubbleWidth,
  canSubmitInput,
  clearInput,
  completeManualSkill,
  completeSlashCommand,
  deleteBackwardAtCursor,
  deleteForwardAtCursor,
  deletePreviousWord,
  estimateDisplayWidth,
  formatInputAroundCursor,
  formatInputAroundCursorWithSyntax,
  formatInputForDisplay,
  insertAtCursor,
  isNewlineKey,
  isSubmitKey,
  moveCursorHorizontal,
  moveCursorToLineBoundary,
  moveCursorVertical,
  normalizePastedInput,
  renderBubbleBody,
  resolveInputSyntaxHighlight,
  shouldClearInputForCtrlC,
  shouldInterruptForKey,
  shouldNavigateInputHistory,
  truncateMiddleLine,
} from '../../src/terminal-ui/terminal-screen.tsx'
import type { KeyModifiers } from '../../src/terminal-ui/terminal-screen.tsx'

function key(modifiers: Partial<KeyModifiers> = {}): KeyModifiers {
  return {
    return: false,
    ctrl: false,
    shift: false,
    meta: false,
    ...modifiers,
  }
}

test('isNewlineKey keeps plain Enter as submit', () => {
  assert.equal(isNewlineKey(key({ return: true })), false)
  assert.equal(isSubmitKey(key({ return: true })), true)
})

test('isNewlineKey treats Shift+Enter as newline', () => {
  assert.equal(isNewlineKey(key({ return: true, shift: true })), true)
  assert.equal(isSubmitKey(key({ return: true, shift: true })), false)
})

test('Ctrl+Enter is neither newline nor submit', () => {
  assert.equal(isNewlineKey(key({ return: true, ctrl: true })), false)
  assert.equal(isSubmitKey(key({ return: true, ctrl: true })), false)
})

test('clearInput clears the current input', () => {
  assert.equal(clearInput(), '')
})

test('normalizePastedInput preserves multiline layout with Unix newlines', () => {
  assert.equal(
    normalizePastedInput('first\r\n\r\n\tsecond\rthird'),
    'first\n\n\tsecond\nthird'
  )
})

test('calculateBubbleWidth uses the full terminal width without right margin', () => {
  assert.equal(calculateBubbleWidth(80), 80)
  assert.equal(calculateBubbleWidth(120), 120)
})

test('formatInputForDisplay expands tabs without changing line breaks', () => {
  assert.equal(
    formatInputForDisplay('\tfirst\n\nA\tsecond'),
    '    first\n\nA   second'
  )
})

test('formatInputAroundCursor preserves tab columns on both sides', () => {
  assert.deepEqual(formatInputAroundCursor('A\t中B', 2), {
    before: 'A   ',
    cursor: '中',
    after: 'B',
    inverse: true,
  })
  assert.deepEqual(formatInputAroundCursor('A\tB', 1), {
    before: 'A',
    cursor: ' ',
    after: '  B',
    inverse: true,
  })
  assert.deepEqual(formatInputAroundCursor('end', 3), {
    before: 'end',
    cursor: INPUT_CURSOR,
    after: '',
    inverse: false,
  })
  assert.equal(INPUT_CURSOR, '█')
})

test('formatInputAroundCursorWithSyntax preserves highlighting around the cursor', () => {
  const display = formatInputAroundCursorWithSyntax('/thread list', 3, {
    start: 0,
    end: 7,
    kind: 'command',
  })

  assert.deepEqual(display, {
    before: [{ text: '/th', syntax: 'command' }],
    cursor: { text: 'r', syntax: 'command', inverse: true },
    after: [
      { text: 'ead', syntax: 'command' },
      { text: ' list', syntax: null },
    ],
  })
})

test('cursor edits insert and delete at the current grapheme boundary', () => {
  assert.deepEqual(insertAtCursor('ac', 1, '😆'), {
    value: 'a😆c',
    cursor: 3,
  })
  assert.deepEqual(deleteBackwardAtCursor('a😆c', 3), {
    value: 'ac',
    cursor: 1,
  })
  assert.deepEqual(deleteForwardAtCursor('a😆c', 1), {
    value: 'ac',
    cursor: 1,
  })
})

test('horizontal cursor movement does not split grapheme clusters', () => {
  assert.equal(moveCursorHorizontal('a😆c', 3, -1), 1)
  assert.equal(moveCursorHorizontal('a😆c', 1, 1), 3)
  assert.equal(moveCursorHorizontal('a😆c', 0, -1), 0)
  assert.equal(moveCursorHorizontal('a😆c', 4, 1), 4)
})

test('vertical cursor movement follows display columns between lines', () => {
  assert.equal(moveCursorVertical('abcd\nx\nwxyz', 3, 1), 6)
  assert.equal(moveCursorVertical('abcd\nx\nwxyz', 10, -1), 6)
  assert.equal(moveCursorVertical('ab\n中x', 2, 1), 4)
})

test('vertical cursor movement reaches the input boundary from its edge lines', () => {
  const multiline = 'abcd\nx\nwxyz'

  assert.equal(moveCursorVertical(multiline, 3, -1), 0)
  assert.equal(moveCursorVertical(multiline, 0, -1), 0)
  assert.equal(moveCursorVertical(multiline, 9, 1), multiline.length)
  assert.equal(
    moveCursorVertical(multiline, multiline.length, 1),
    multiline.length
  )

  assert.equal(moveCursorVertical('single line', 4, -1), 0)
  assert.equal(moveCursorVertical('single line', 4, 1), 11)
  assert.equal(moveCursorVertical('', 0, -1), 0)
  assert.equal(moveCursorVertical('', 0, 1), 0)
  assert.equal(moveCursorVertical('\nlast', 0, -1), 0)
  assert.equal(moveCursorVertical('first\n', 6, 1), 6)
})

test('vertical cursor movement can preserve a preferred display column', () => {
  const value = 'abcd\nx\nwxyz'
  const shortLineCursor = moveCursorVertical(value, 3, 1)

  assert.equal(shortLineCursor, 6)
  assert.equal(moveCursorVertical(value, shortLineCursor, 1, 3), 10)
})

test('line boundary movement stays within the current logical line', () => {
  const value = 'first\nsecond\nthird'

  assert.equal(moveCursorToLineBoundary(value, 9, 'start'), 6)
  assert.equal(moveCursorToLineBoundary(value, 9, 'end'), 12)
  assert.equal(moveCursorToLineBoundary(value, 5, 'start'), 0)
  assert.equal(moveCursorToLineBoundary(value, 5, 'end'), 5)
})

test('history navigation continues for loaded history until editing starts', () => {
  assert.equal(shouldNavigateInputHistory('', false), true)
  assert.equal(shouldNavigateInputHistory('loaded history', true), true)
  assert.equal(shouldNavigateInputHistory('manual draft', false), false)
})

test('deletePreviousWord deletes the word before the cursor', () => {
  assert.equal(deletePreviousWord('hello world'), 'hello')
  assert.equal(deletePreviousWord('hello world   '), 'hello')
  assert.equal(deletePreviousWord('hello'), '')
})

test('completeSlashCommand completes unique command and subcommand prefixes', () => {
  const execute: CliCommand['execute'] = async () => ({ continue: true })
  const commands: CliCommand[] = [
    { name: '/help', description: 'help', execute },
    { name: '/providers', description: 'providers', execute },
    {
      name: '/skill',
      description: 'skill',
      subcommands: ['add', 'list', 'enable', 'disable', 'remove'],
      execute,
    },
    {
      name: '/thread',
      description: 'thread',
      subcommands: [
        'open',
        'list',
        'history',
        'resume',
        'switch',
        'status',
        'close',
        'detach',
        'capability',
      ],
      execute,
    },
    {
      name: '/serve',
      description: 'listeners',
      subcommands: ['api', 'mcp'],
      execute,
    },
  ]

  assert.equal(completeSlashCommand('/th', commands), '/thread ')
  assert.equal(completeSlashCommand('/thread op', commands), '/thread open ')
  assert.equal(
    completeSlashCommand('/thread cap', commands),
    '/thread capability '
  )
  assert.equal(completeSlashCommand('/skill a', commands), '/skill add ')
  assert.equal(completeSlashCommand('/serve a', commands), '/serve api ')
  assert.equal(completeSlashCommand('/serve m', commands), '/serve mcp ')
  assert.equal(completeSlashCommand('/serve api st', commands), '/serve api st')
  assert.equal(completeSlashCommand('/thread s', commands), '/thread s')
  assert.equal(
    completeSlashCommand('/thread open gemini', commands),
    '/thread open gemini'
  )
  assert.equal(completeSlashCommand('/', commands), '/')
  assert.equal(completeSlashCommand('hello /op', commands), 'hello /op')
})

test('completeManualSkill completes only a unique skill prefix at the cursor', () => {
  const skills = ['chrome-automation', 'code-review']

  assert.deepEqual(completeManualSkill('$chr', 4, skills), {
    value: '$chrome-automation ',
    cursor: 19,
  })
  assert.deepEqual(completeManualSkill('$chr inspect the page', 4, skills), {
    value: '$chrome-automation inspect the page',
    cursor: 18,
  })
  assert.deepEqual(completeManualSkill('$chr  inspect the page', 4, skills), {
    value: '$chrome-automation  inspect the page',
    cursor: 18,
  })
  assert.deepEqual(completeManualSkill('$c', 2, skills), {
    value: '$c',
    cursor: 2,
  })
  assert.deepEqual(completeManualSkill('$unknown', 8, skills), {
    value: '$unknown',
    cursor: 8,
  })
  assert.deepEqual(completeManualSkill('$chrdo', 4, skills), {
    value: '$chrdo',
    cursor: 4,
  })
  assert.deepEqual(completeManualSkill('  $chr', 6, skills), {
    value: '  $chr',
    cursor: 6,
  })
})

test('resolveInputSyntaxHighlight only marks recognized commands and skills', () => {
  const execute: CliCommand['execute'] = async () => ({ continue: true })
  const commands: readonly CliCommand[] = [
    { name: '/help', description: 'help', execute },
    {
      name: '/thread',
      description: 'thread',
      subcommands: ['open', 'reload'],
      execute,
    },
  ]
  const skills = ['chrome-automation']

  assert.deepEqual(
    resolveInputSyntaxHighlight('/thread reload t-1', commands, skills),
    { start: 0, end: 14, kind: 'command' }
  )
  assert.deepEqual(
    resolveInputSyntaxHighlight('/thread unknown', commands, skills),
    { start: 0, end: 7, kind: 'command' }
  )
  assert.deepEqual(resolveInputSyntaxHighlight('  /help', commands, skills), {
    start: 2,
    end: 7,
    kind: 'command',
  })
  assert.deepEqual(
    resolveInputSyntaxHighlight('$chrome-automation inspect', commands, skills),
    { start: 0, end: 18, kind: 'skill' }
  )
  assert.equal(resolveInputSyntaxHighlight('/th', commands, skills), null)
  assert.equal(
    resolveInputSyntaxHighlight('$unknown inspect', commands, skills),
    null
  )
  assert.equal(
    resolveInputSyntaxHighlight('$chrome-automation-extra', commands, skills),
    null
  )
  assert.equal(
    resolveInputSyntaxHighlight('use $chrome-automation', commands, skills),
    null
  )
})

test('welcome rows use responsive layouts without overflowing', () => {
  const details = {
    browserStatus: 'connected' as const,
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  }
  const wideRows = buildWelcomeRows(details, 70)
  const narrowRows = buildWelcomeRows(details, 28)

  assert.ok(wideRows.some((row) => row.text.includes('█▀█')))
  assert.equal(
    wideRows.some((row) => row.text.includes('No active')),
    false
  )
  assert.equal(
    wideRows.some((row) => row.text.includes('/thread')),
    false
  )
  assert.ok(wideRows.every((row) => estimateDisplayWidth(row.text) <= 70))
  assert.ok(narrowRows.some((row) => row.text === 'PORTAL v1.0.0'))
  assert.equal(
    narrowRows.some((row) => row.text.includes('No active')),
    false
  )
  assert.equal(
    narrowRows.some((row) => row.text.includes('/help')),
    false
  )
  assert.ok(narrowRows.every((row) => estimateDisplayWidth(row.text) <= 28))
})

test('welcome rows describe each browser connection state', () => {
  const details = {
    directory: 'C:\\Users\\JXZ\\Desktop\\code\\portal',
    version: '1.0.0',
  }

  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'connecting' }, 70).some(
      (row) => row.text === '◌ Browser connecting'
    )
  )
  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'connected' }, 70).some(
      (row) => row.text === '● Browser connected'
    )
  )
  assert.ok(
    buildWelcomeRows({ ...details, browserStatus: 'disconnected' }, 70).some(
      (row) => row.text === '○ Browser disconnected'
    )
  )
})

test('truncateMiddleLine preserves both ends of long paths', () => {
  const result = truncateMiddleLine('C:\\Users\\JXZ\\Desktop\\code\\portal', 20)

  assert.ok(result.startsWith('C:\\Users'))
  assert.ok(result.endsWith('de\\portal'))
  assert.ok(result.includes('…'))
  assert.ok(estimateDisplayWidth(result) <= 20)
})

test('shouldInterruptForKey only allows Ctrl+C while busy', () => {
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'c',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldInterruptForKey({
      busy: true,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    true
  )
})

test('shouldClearInputForCtrlC only clears non-empty input while idle', () => {
  assert.equal(
    shouldClearInputForCtrlC({
      busy: false,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    true
  )
  assert.equal(
    shouldClearInputForCtrlC({
      busy: false,
      input: 'c',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldClearInputForCtrlC({
      busy: true,
      input: 'c',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    false
  )
})

test('busy input accepts slash commands but keeps ordinary prompts pending', () => {
  assert.equal(canSubmitInput('/thread switch t-2', true), true)
  assert.equal(canSubmitInput('  /thread list', true), true)
  assert.equal(canSubmitInput('continue with the tests', true), false)
  assert.equal(canSubmitInput('continue with the tests', false), true)
})

test('shouldInterruptForKey only allows Ctrl+D to exit on empty non-busy input', () => {
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'd',
      inputValue: '',
      key: { ctrl: true },
    }),
    true
  )
  assert.equal(
    shouldInterruptForKey({
      busy: false,
      input: 'd',
      inputValue: 'draft',
      key: { ctrl: true },
    }),
    false
  )
  assert.equal(
    shouldInterruptForKey({
      busy: true,
      input: 'd',
      inputValue: '',
      key: { ctrl: true },
    }),
    false
  )
})

test('renderBubbleBody keeps long markdown table cells instead of truncating', () => {
  const longText =
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
  const rendered = renderBubbleBody(
    ['| field | value |', '|---|---|', `| long_text | ${longText} |`].join(
      '\n'
    ),
    'markdown',
    40
  )

  assert.equal(rendered.includes('…'), false)
  assert.equal(rendered.includes('fifteen'), true)
})

test('renderBubbleBody colors V4A snapshot lines without changing their text', () => {
  const rendered = renderBubbleBody(
    [
      '1 file · +1 -1',
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      ' context',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
    'v4a',
    80
  )

  assert.match(rendered, /\u001B\[1m1 file · \+1 -1\u001B\[22m/)
  assert.match(rendered, /\u001B\[36m\*\*\* Begin Patch\u001B\[39m/)
  assert.match(rendered, /\u001B\[33m@@\u001B\[39m/)
  assert.match(rendered, /\u001B\[31m-old\u001B\[39m/)
  assert.match(rendered, /\u001B\[32m\+new\u001B\[39m/)
})

test('renderBubbleBody expands tabs at display-column stops for plain output', () => {
  const rendered = renderBubbleBody('a\tb\r\n\tc\rd', 'plain', 40)

  assert.equal(rendered, 'a   b\n    c\nd')
  assert.equal(rendered.includes('\t'), false)
})

test('renderBubbleBody ignores ANSI CSI sequences when expanding and measuring tabs', () => {
  const rendered = renderBubbleBody('a\u001B[2K\tb', 'plain', 40)

  assert.equal(rendered, 'a\u001B[2K   b')
  assert.equal(estimateDisplayWidth(rendered), 5)
})

test('renderBubbleBody expands tabs before markdown and V4A formatting', () => {
  const markdown = renderBubbleBody(
    '```\n\tconst value = 1\n```',
    'markdown',
    40
  )
  const v4a = renderBubbleBody('1 file\r\n*** Begin Patch\r\n\t+new', 'v4a', 40)

  assert.equal(markdown.includes('\t'), false)
  assert.equal(v4a.includes('\t'), false)
  assert.match(v4a, / {4}\+new/)
})

test('renderBubbleBody wraps long CJK markdown table cells through markdansi', () => {
  const longText =
    '这是一段没有空格的超长中文单元格内容用来验证表格边框不会被撑破并且内容不会丢失'
  const rendered = renderBubbleBody(
    ['| item | description |', '|---|---|', `| long | ${longText} |`].join(
      '\n'
    ),
    'markdown',
    40
  )

  for (const line of rendered.split('\n')) {
    assert.equal(estimateDisplayWidth(line) <= 40, true, line)
  }
  assert.equal(rendered.includes('丢失'), true)
  assert.equal(rendered.includes('…'), false)
})

test('renderBubbleBody hard-wraps long identifiers without widening table borders', () => {
  const identifier = 'buildRuntimeRecoveryPlan、createRuntimeFromAdapter'
  const rendered = renderBubbleBody(
    [
      '| 难度 | 切入点 | 具体建议 |',
      '|---|---|---|',
      `| 简单 | 增加注释 | ${identifier} |`,
    ].join('\n'),
    'markdown',
    40
  )

  for (const line of rendered.split('\n')) {
    assert.equal(estimateDisplayWidth(line) <= 40, true, line)
  }

  const recommendationText = rendered
    .split('\n')
    .filter((line) => line.startsWith('│'))
    .map((line) => line.split('│')[3]?.trim() ?? '')
    .join('')
  assert.equal(recommendationText.includes(identifier), true)
  assert.equal(rendered.includes('…'), false)
})
