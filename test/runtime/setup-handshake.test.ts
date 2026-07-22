import assert from 'node:assert/strict'
import test from 'node:test'
import { hasReadyHandshakeToken } from '../../src/runtime/setup-handshake.ts'

test('hasReadyHandshakeToken matches READY as a case-insensitive whole word', () => {
  assert.equal(hasReadyHandshakeToken('READY'), true)
  assert.equal(hasReadyHandshakeToken('ready - setup complete'), true)
  assert.equal(hasReadyHandshakeToken('Not ReAdY yet.'), true)
  assert.equal(hasReadyHandshakeToken('already complete'), false)
  assert.equal(hasReadyHandshakeToken('readiness confirmed'), false)
})
