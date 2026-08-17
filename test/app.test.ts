import assert from 'node:assert/strict'
import test from 'node:test'

import * as app from '../src/app.ts'
import * as appLifecycle from '../src/app/app-lifecycle.ts'
import * as runtimeSettings from '../src/runtime/runtime-settings.ts'
import * as childConversations from '../src/threads/web-child-conversation-service.ts'
import * as terminalLifecycle from '../src/app/app-terminal-lifecycle.ts'

test('app facade preserves extracted public exports', () => {
  assert.equal(app.closeWithTimeout, appLifecycle.closeWithTimeout)
  assert.equal(
    app.createPortalRuntimeSettings,
    runtimeSettings.createPortalRuntimeSettings
  )
  assert.equal(
    app.inheritSpawnModelSelection,
    childConversations.inheritSpawnModelSelection
  )
  assert.equal(
    app.showPendingThreadTimeline,
    terminalLifecycle.showPendingThreadTimeline
  )
})
