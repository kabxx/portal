import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'ink'

import { DEFAULT_COMMANDS } from '../../src/cli-commands/command-set.ts'
import type { ProviderId } from '../../src/providers/provider-id.ts'
import { resolveCommandHints } from '../../src/terminal-ui/command-hints.ts'
import {
  MAX_INPUT_HINT_LINES as MAX_COMMAND_HINT_LINES,
  moveInputHintSelection as moveCommandHintSelection,
  navigateInputHintSelection,
  resolveInputHintSelection as resolveCommandHintSelection,
  sliceInputHintWindow as sliceCommandHintWindow,
} from '../../src/terminal-ui/input-hints.ts'
import {
  InputHintPanel as CommandHintPanel,
  estimateDisplayWidth,
  formatInputHintLines as formatCommandHintLines,
} from '../../src/terminal-ui/terminal-screen.tsx'

const PROVIDERS: readonly ProviderId[] = [
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
]

test('root slash input returns every command while the window stays bounded', () => {
  const hints = resolveCommandHints('/', DEFAULT_COMMANDS, PROVIDERS)
  const visible = sliceCommandHintWindow(hints, hints[0]?.completion ?? null)

  assert.equal(hints.length, DEFAULT_COMMANDS.length)
  assert.equal(hints[0]?.usage, '/help')
  assert.equal(hints[0]?.completion, '/help ')
  assert.equal(
    hints.some(({ usage }) => usage.includes('more')),
    false
  )
  assert.equal(visible.length, MAX_COMMAND_HINT_LINES)
})

test('command prefixes narrow to the matching top-level command', () => {
  assert.deepEqual(resolveCommandHints('/thr', DEFAULT_COMMANDS, PROVIDERS), [
    {
      usage: '/thread <subcommand>',
      description: 'Manage threads.',
      kind: 'command',
      completion: '/thread ',
    },
  ])
  assert.deepEqual(
    resolveCommandHints('  /thread', DEFAULT_COMMANDS, PROVIDERS),
    [
      {
        usage: '/thread <subcommand>',
        description: 'Manage threads.',
        kind: 'command',
        completion: '/thread ',
      },
    ]
  )
  assert.deepEqual(
    resolveCommandHints('explain /thread', DEFAULT_COMMANDS, PROVIDERS),
    []
  )
})

test('subcommand prefixes show one candidate per literal path', () => {
  const skillHints = resolveCommandHints(
    '/skill a',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(skillHints.length, 1)
  assert.equal(skillHints[0]?.usage, 'add')
  assert.equal(skillHints[0]?.completion, '/skill add ')

  const mcpHints = resolveCommandHints(
    '/mcp resource ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.deepEqual(
    mcpHints.map(({ usage }) => usage),
    ['resource list [server]', 'resource attach <server> <uri>']
  )
  assert.deepEqual(
    mcpHints.map(({ completion }) => completion),
    ['/mcp resource list ', '/mcp resource attach ']
  )

  assert.deepEqual(
    resolveCommandHints('/serve ', DEFAULT_COMMANDS, PROVIDERS).map(
      ({ usage }) => usage
    ),
    ['api <start|status|stop|token>', 'mcp <start|status|stop|token>']
  )
})

test('completed paths show all usage forms and ignore free-form arguments', () => {
  const addHints = resolveCommandHints(
    '/skill add ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.deepEqual(
    addHints.map(({ usage }) => usage),
    [
      '/skill add <local-directory>',
      '/skill add <url>',
      '/skill add <name> --registry <url>',
    ]
  )
  assert.equal(
    addHints.every(({ completion }) => completion === undefined),
    true
  )

  const attachHints = resolveCommandHints(
    '/mcp resource attach server-name ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(attachHints[0]?.usage, '/mcp resource attach <server> <uri>')
})

test('thread open hints filter providers then advance to the optional model', () => {
  const providerHints = resolveCommandHints(
    '/thread open gem',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(
    providerHints[0]?.usage,
    '/thread open <provider> [model-key] [option-key]'
  )
  assert.equal(providerHints[1]?.usage, 'gemini')
  assert.equal(
    resolveCommandHintSelection(providerHints, '/thread open gem', null),
    '/thread open gemini '
  )
  const modelHints = resolveCommandHints(
    '/thread open gemini ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.deepEqual(
    modelHints.slice(1).map(({ usage }) => usage),
    ['3.5-flash-lite', '3.6-flash', '3.1-pro']
  )
  assert.equal(
    resolveCommandHintSelection(modelHints, '/thread open gemini ', null),
    '/thread open gemini 3.5-flash-lite '
  )

  const completedHints = resolveCommandHints(
    '/thread open gemini 3.1',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(completedHints.at(-1)?.usage, '3.1-pro')
  assert.equal(
    completedHints.at(-1)?.completion,
    '/thread open gemini 3.1-pro '
  )

  const optionHints = resolveCommandHints(
    '/thread open gemini 3.1-pro e',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(optionHints.at(-1)?.usage, 'extended')
  assert.equal(
    resolveCommandHintSelection(
      optionHints,
      '/thread open gemini 3.1-pro e',
      null
    ),
    '/thread open gemini 3.1-pro extended'
  )

  assert.equal(
    resolveCommandHints(
      '/thread open gemini 3.1-pro extended extra',
      DEFAULT_COMMANDS,
      PROVIDERS
    ).some(({ usage }) => usage === 'extended'),
    false
  )
})

test('thread chat hints and completion mirror thread open', () => {
  const providerHints = resolveCommandHints(
    '/thread chat gem',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(
    providerHints[0]?.usage,
    '/thread chat <provider> [model-key] [option-key]'
  )
  assert.equal(providerHints[1]?.usage, 'gemini')
  assert.equal(
    resolveCommandHintSelection(providerHints, '/thread chat gem', null),
    '/thread chat gemini '
  )
  const modelHints = resolveCommandHints(
    '/thread chat gemini ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.deepEqual(
    modelHints.slice(1).map(({ usage }) => usage),
    ['3.5-flash-lite', '3.6-flash', '3.1-pro']
  )
  assert.equal(
    resolveCommandHintSelection(modelHints, '/thread chat gemini ', null),
    '/thread chat gemini 3.5-flash-lite '
  )

  const optionHints = resolveCommandHints(
    '/thread chat gemini 3.6-flash e',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(
    resolveCommandHintSelection(
      optionHints,
      '/thread chat gemini 3.6-flash e',
      null
    ),
    '/thread chat gemini 3.6-flash extended'
  )
})

test('unknown warnings wait until the invalid token is completed', () => {
  assert.deepEqual(
    resolveCommandHints('/unknown', DEFAULT_COMMANDS, PROVIDERS),
    []
  )
  assert.equal(
    resolveCommandHints('/unknown ', DEFAULT_COMMANDS, PROVIDERS)[0]?.kind,
    'warning'
  )
  assert.equal(
    resolveCommandHints('/unknown argument', DEFAULT_COMMANDS, PROVIDERS)[0]
      ?.kind,
    'warning'
  )
  assert.deepEqual(
    resolveCommandHints('/thread unknown', DEFAULT_COMMANDS, PROVIDERS),
    []
  )
  assert.equal(
    resolveCommandHints('/thread unknown ', DEFAULT_COMMANDS, PROVIDERS)[0]
      ?.kind,
    'warning'
  )
  assert.equal(
    resolveCommandHints(
      '/thread unknown argument',
      DEFAULT_COMMANDS,
      PROVIDERS
    )[0]?.kind,
    'warning'
  )
  assert.deepEqual(
    resolveCommandHints('/mcp resource att', DEFAULT_COMMANDS, PROVIDERS).map(
      ({ usage }) => usage
    ),
    ['resource attach <server> <uri>']
  )
  assert.equal(
    resolveCommandHints('/thr open', DEFAULT_COMMANDS, PROVIDERS)[0]?.kind,
    'warning'
  )
  assert.equal(
    resolveCommandHints('/mcp res att', DEFAULT_COMMANDS, PROVIDERS)[0]?.kind,
    'warning'
  )
})

test('multiline input never opens command hints', () => {
  assert.deepEqual(
    resolveCommandHints('/thread\nopen', DEFAULT_COMMANDS, PROVIDERS),
    []
  )
})

test('selection defaults to the first current prefix match without stale state', () => {
  const cases = [
    ['/', '/help '],
    ['/thr', '/thread '],
    ['/thread ', '/thread open '],
  ] as const

  for (const [input, expected] of cases) {
    const hints = resolveCommandHints(input, DEFAULT_COMMANDS, PROVIDERS)
    assert.equal(resolveCommandHintSelection(hints, input, null), expected)
  }

  const threadHints = resolveCommandHints(
    '/thread ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(
    resolveCommandHintSelection(threadHints, '/thread ', '/thread status '),
    '/thread status '
  )
  assert.equal(
    resolveCommandHintSelection(threadHints, '/thread ', '/thread missing '),
    '/thread open '
  )

  const completedHelp = resolveCommandHints(
    '/help ',
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(completedHelp[0]?.completion, undefined)
  assert.equal(resolveCommandHintSelection(completedHelp, '/help ', null), null)
})

test('selection moves through selectable rows and wraps at both ends', () => {
  const input = '/'
  const hints = resolveCommandHints(input, DEFAULT_COMMANDS, PROVIDERS)
  const first = resolveCommandHintSelection(hints, input, null)
  const last = hints.at(-1)?.completion ?? null

  assert.equal(first, '/help ')
  assert.equal(moveCommandHintSelection(hints, input, first, 'up'), last)
  assert.equal(moveCommandHintSelection(hints, input, last, 'down'), first)
  assert.equal(
    moveCommandHintSelection(hints, input, first, 'down'),
    '/thread '
  )

  const providerInput = '/thread open gem'
  const providerHints = resolveCommandHints(
    providerInput,
    DEFAULT_COMMANDS,
    PROVIDERS
  )
  assert.equal(
    resolveCommandHintSelection(providerHints, providerInput, null),
    '/thread open gemini '
  )
  assert.equal(
    moveCommandHintSelection(providerHints, providerInput, null, 'down'),
    '/thread open gemini '
  )

  const mixedHints = [
    {
      usage: '/first',
      description: 'First command.',
      kind: 'command' as const,
      completion: '/first ',
    },
    {
      usage: 'provider: gemini',
      description: '',
      kind: 'detail' as const,
    },
    {
      usage: '/second',
      description: 'Second command.',
      kind: 'command' as const,
      completion: '/second ',
    },
  ]
  assert.equal(
    moveCommandHintSelection(mixedHints, '/', '/first ', 'down'),
    '/second '
  )
  assert.equal(
    moveCommandHintSelection(mixedHints, '/', '/second ', 'down'),
    '/first '
  )
})

test('navigation decisions follow the latest queued input value', () => {
  const staleHints = resolveCommandHints('/x', DEFAULT_COMMANDS, PROVIDERS)
  assert.equal(
    navigateInputHintSelection(staleHints, '/x', '/help ', 'down'),
    null
  )
  const currentHints = resolveCommandHints('/', DEFAULT_COMMANDS, PROVIDERS)
  assert.equal(
    navigateInputHintSelection(currentHints, '/', null, 'down'),
    '/thread '
  )
})

test('five-line window follows middle, tail, and wrapped selections', () => {
  const hints = resolveCommandHints('/', DEFAULT_COMMANDS, PROVIDERS)
  const middle = hints[6]?.completion ?? null
  const tail = hints.at(-1)?.completion ?? null

  const middleWindow = sliceCommandHintWindow(hints, middle)
  assert.equal(middleWindow.length, MAX_COMMAND_HINT_LINES)
  assert.equal(
    middleWindow.some(({ completion }) => completion === middle),
    true
  )

  const tailWindow = sliceCommandHintWindow(hints, tail)
  assert.equal(tailWindow.at(-1)?.completion, tail)

  const wrappedWindow = sliceCommandHintWindow(
    hints,
    hints[0]?.completion ?? null
  )
  assert.equal(wrappedWindow[0]?.completion, hints[0]?.completion)
})

test('formatted hint rows fit the bubble content at narrow widths', () => {
  const hints = resolveCommandHints('/thread ', DEFAULT_COMMANDS, PROVIDERS)
  const selected = hints[0]?.completion ?? null
  const visible = sliceCommandHintWindow(hints, selected)
  const bubbleWidth = 32
  const contentWidth = bubbleWidth - 4
  const lines = formatCommandHintLines(visible, bubbleWidth, selected)

  assert.equal(lines.length, MAX_COMMAND_HINT_LINES)
  assert.equal(lines[0]?.selected, true)
  for (const line of lines) {
    const rendered = line.description
      ? `${line.usage}  ${line.description}`
      : line.usage
    assert.ok(estimateDisplayWidth(rendered) <= contentWidth, rendered)
    assert.equal(rendered.includes('\n'), false)
  }
})

test('formatted hint rows keep their width budget near the minimum bubble size', () => {
  const hints = resolveCommandHints('/', DEFAULT_COMMANDS, PROVIDERS)
  const bubbleWidth = 24
  const lines = formatCommandHintLines(
    sliceCommandHintWindow(hints, hints[0]?.completion ?? null),
    bubbleWidth,
    hints[0]?.completion ?? null
  )

  for (const line of lines) {
    const rendered = line.description
      ? `${line.usage}  ${line.description}`
      : line.usage
    assert.ok(estimateDisplayWidth(rendered) <= bubbleWidth - 4, rendered)
  }
})

test('command hint bubble renders one aligned frame with five command rows', () => {
  const hints = resolveCommandHints('/', DEFAULT_COMMANDS, PROVIDERS)
  const selected = hints[0]?.completion ?? null

  for (const width of [79, 31, 24]) {
    const output = renderToString(
      createElement(CommandHintPanel, {
        hints,
        selectedCompletion: selected,
        title: 'commands',
        width,
      }),
      { columns: width }
    )
    const lines = output.split('\n')

    assert.equal(lines.length, MAX_COMMAND_HINT_LINES + 2)
    assert.match(lines[0] ?? '', /^┌ commands /)
    assert.match(lines.at(-1) ?? '', /^└─+┘$/)
    for (const line of lines) {
      assert.equal(estimateDisplayWidth(line), width, line)
    }
  }
})

test('guide-derived subcommands preserve existing completion order', () => {
  const expected: Readonly<Record<string, readonly string[]>> = {
    '/thread': [
      'open',
      'chat',
      'list',
      'history',
      'resume',
      'reload',
      'switch',
      'status',
      'close',
      'detach',
      'capability',
    ],
    '/skill': ['add', 'list', 'enable', 'disable', 'remove'],
    '/mcp': [
      'add',
      'list',
      'enable',
      'disable',
      'remove',
      'resource',
      'prompt',
    ],
  }

  for (const [name, subcommands] of Object.entries(expected)) {
    assert.deepEqual(
      DEFAULT_COMMANDS.find((command) => command.name === name)?.subcommands,
      subcommands
    )
  }
})
