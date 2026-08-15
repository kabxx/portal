import assert from 'node:assert/strict'
import test from 'node:test'

import * as app from '../src/app.ts'
import * as appLifecycle from '../src/app/app-lifecycle.ts'
import * as providerCatalog from '../src/providers/provider-catalog.ts'
import * as runtimeSettings from '../src/runtime/runtime-settings.ts'
import * as spawnToolServices from '../src/tools/spawn-tool-services.ts'
import * as terminalLifecycle from '../src/app/app-terminal-lifecycle.ts'

test('app facade preserves extracted public exports', () => {
  assert.equal(app.closeWithTimeout, appLifecycle.closeWithTimeout)
  assert.equal(app.PROVIDERS, providerCatalog.PROVIDERS)
  assert.equal(
    app.createPortalRuntimeSettings,
    runtimeSettings.createPortalRuntimeSettings
  )
  assert.equal(
    app.inheritSpawnModelSelection,
    spawnToolServices.inheritSpawnModelSelection
  )
  assert.equal(
    app.showPendingThreadTimeline,
    terminalLifecycle.showPendingThreadTimeline
  )
})
