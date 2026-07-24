import assert from 'node:assert/strict'
import test from 'node:test'

import { inheritSpawnModelSelection } from '../../src/app/spawn-tool-services.ts'

test('spawn model selection inherits only within the same provider', () => {
  const model = { key: '3.1-pro', option: 'extended' }

  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', model), model)
  assert.equal(inheritSpawnModelSelection('gemini', 'deepseek', model), null)
  assert.equal(inheritSpawnModelSelection('gemini', 'gemini', null), null)
})
