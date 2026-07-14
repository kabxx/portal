import test from 'node:test'
import assert from 'node:assert/strict'

import { joinPromptSections } from '../../src/shared/prompt-sections.ts'

test('joinPromptSections normalizes section boundaries', () => {
  assert.equal(
    joinPromptSections(['\n first \n\n', null, '', '\n\nsecond\n']),
    'first\n\nsecond'
  )
})

test('joinPromptSections preserves intentional internal spacing', () => {
  assert.equal(
    joinPromptSections(['first\n\n\ninternal', 'second']),
    'first\n\n\ninternal\n\nsecond'
  )
})

test('joinPromptSections supports wider top-level block separation', () => {
  assert.equal(
    joinPromptSections(['# Tools\n\n## Definitions', '# Skills'], '\n\n\n'),
    '# Tools\n\n## Definitions\n\n\n# Skills'
  )
})
