import assert from 'node:assert/strict'
import test from 'node:test'

import { hasReadyHandshakeToken } from '../../src/agents/portal-agent-plugin.ts'

test('Agent plugin accepts READY as a case-insensitive whole word', () => {
  assert.equal(hasReadyHandshakeToken('READY'), true)
  assert.equal(hasReadyHandshakeToken('ready - setup complete'), true)
  assert.equal(hasReadyHandshakeToken('Not ReAdY yet.'), true)
  assert.equal(hasReadyHandshakeToken('already complete'), false)
  assert.equal(hasReadyHandshakeToken('readiness confirmed'), false)
})
