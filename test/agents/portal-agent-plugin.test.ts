import assert from 'node:assert/strict'
import test from 'node:test'

import { PORTAL_INITIALIZATION_PROMPT } from '../../src/prompts/portal-prompt-plugin.ts'

test('Portal initialization asks for READY without validating the response', () => {
  assert.equal(
    PORTAL_INITIALIZATION_PROMPT,
    '## Initialization\nReply exactly: READY'
  )
})
