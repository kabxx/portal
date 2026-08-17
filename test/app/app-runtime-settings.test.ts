import assert from 'node:assert/strict'
import test from 'node:test'

import { createPortalRuntimeSettings } from '../../src/runtime/runtime-settings.ts'

test('runtime settings expose only the Portal spawn policy', () => {
  assert.deepEqual(createPortalRuntimeSettings(), { spawnDepthLimit: 3 })
})
