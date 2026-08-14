import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPortalRuntimeSettings,
  runtimeSetupModeForThreadCreation,
} from '../../src/app/app-runtime-settings.ts'

test('thread creation modes map to setup modes', () => {
  assert.equal(runtimeSetupModeForThreadCreation('agent'), 'full')
  assert.equal(runtimeSetupModeForThreadCreation('chat'), 'handshake')
})

test('runtime settings expose only the Portal spawn policy', () => {
  assert.deepEqual(createPortalRuntimeSettings(), { spawnDepthLimit: 3 })
})
