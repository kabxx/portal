import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'ink'

import { DEFAULT_COMMANDS } from '../../src/cli-commands/command-set.ts'
import { SkillCatalogSnapshot } from '../../src/skills/skill-library.ts'
import { sanitizeSkillDescription } from '../../src/skills/manual-skill-summary.ts'
import {
  MAX_INPUT_HINT_LINES,
  moveInputHintSelection,
  resolveInputHintSelection,
  sliceInputHintWindow,
} from '../../src/terminal-ui/input-hints.ts'
import { resolveSkillHints } from '../../src/terminal-ui/skill-hints.ts'
import {
  estimateDisplayWidth,
  InputHintPanel,
  resolveInputHintGroup,
} from '../../src/terminal-ui/terminal-screen.tsx'

const SKILLS = [
  { name: 'browser', description: 'Inspect pages in the browser.' },
  { name: 'code-review', description: 'Review code for defects.' },
  { name: 'documents', description: 'Create and edit documents.' },
  { name: 'email-notify', description: 'Send completion notifications.' },
  { name: 'frontend', description: 'Build application interfaces.' },
  { name: 'pdf', description: 'Read and create PDF files.' },
  { name: 'spreadsheets', description: 'Analyze spreadsheet files.' },
] as const

test('skill hints open on dollar input and filter by name prefix', () => {
  const all = resolveSkillHints('$', SKILLS)
  assert.equal(all.length, SKILLS.length)
  assert.deepEqual(all[0], {
    usage: '$browser',
    description: 'Inspect pages in the browser.',
    kind: 'skill',
    completion: '$browser ',
  })

  assert.deepEqual(resolveSkillHints('$code', SKILLS), [
    {
      usage: '$code-review',
      description: 'Review code for defects.',
      kind: 'skill',
      completion: '$code-review ',
    },
  ])
})

test('skill hints close for task text, multiline input, and unknown prefixes', () => {
  assert.deepEqual(resolveSkillHints('$browser ', SKILLS), [])
  assert.deepEqual(resolveSkillHints('$bro inspect this', SKILLS), [])
  assert.deepEqual(resolveSkillHints('$bro\ninspect this', SKILLS), [])
  assert.deepEqual(resolveSkillHints('$unknown', SKILLS), [])
  assert.deepEqual(resolveSkillHints('$', []), [])
})

test('skill selection defaults, wraps, and keeps the selected row visible', () => {
  const input = '$'
  const hints = resolveSkillHints(input, SKILLS)
  const first = resolveInputHintSelection(hints, input, null)
  const last = hints.at(-1)?.completion ?? null

  assert.equal(first, '$browser ')
  assert.equal(moveInputHintSelection(hints, input, first, 'up'), last)
  assert.equal(moveInputHintSelection(hints, input, last, 'down'), first)

  const tailWindow = sliceInputHintWindow(hints, last)
  assert.equal(tailWindow.length, MAX_INPUT_HINT_LINES)
  assert.equal(tailWindow.at(-1)?.completion, last)
})

test('input hint groups activate exactly one command or skill namespace', () => {
  const commandGroup = resolveInputHintGroup('/', DEFAULT_COMMANDS, [], SKILLS)
  assert.equal(commandGroup?.title, 'commands')

  const skillGroup = resolveInputHintGroup('$', DEFAULT_COMMANDS, [], SKILLS)
  assert.equal(skillGroup?.title, 'skills')

  assert.equal(
    resolveInputHintGroup('$unknown', DEFAULT_COMMANDS, [], SKILLS),
    null
  )
  assert.equal(resolveInputHintGroup('$', DEFAULT_COMMANDS, [], []), null)
})

test('skill descriptions are normalized to untrusted terminal-safe text', () => {
  const unsafe = '\u001B[31mDanger\u001B[0m\nnext\u0007\u009B31m hidden\ttext'
  assert.equal(sanitizeSkillDescription(unsafe), 'Danger next hidden text')

  const catalog = new SkillCatalogSnapshot([
    {
      name: 'unsafe-skill',
      description: unsafe,
      directory: 'C:\\skills\\unsafe-skill',
    },
  ])
  assert.deepEqual(catalog.summaries, [
    {
      name: 'unsafe-skill',
      description: 'Danger next hidden text',
    },
  ])
})

test('skill hint bubble renders one aligned frame with five rows', () => {
  const hints = resolveSkillHints('$', SKILLS)
  const selected = hints[0]?.completion ?? null

  for (const width of [79, 31, 24]) {
    const output = renderToString(
      createElement(InputHintPanel, {
        hints,
        selectedCompletion: selected,
        title: 'skills',
        width,
      }),
      { columns: width }
    )
    const lines = output.split('\n')

    assert.equal(lines.length, MAX_INPUT_HINT_LINES + 2)
    assert.match(lines[0] ?? '', /^┌ skills /)
    assert.match(lines.at(-1) ?? '', /^└─+┘$/)
    for (const line of lines) {
      assert.equal(estimateDisplayWidth(line), width, line)
    }
  }
})
