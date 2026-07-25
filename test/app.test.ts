import assert from 'node:assert/strict'
import test from 'node:test'

import * as app from '../src/app.ts'
import * as apiHandlers from '../src/app/app-api-handlers.ts'
import * as appLifecycle from '../src/app/app-lifecycle.ts'
import * as providerCatalog from '../src/app/app-provider-catalog.ts'
import * as runtimeSettings from '../src/app/app-runtime-settings.ts'
import * as spawnToolServices from '../src/app/app-spawn-tool-services.ts'
import * as terminalLifecycle from '../src/app/app-terminal-lifecycle.ts'
import {
  clearApiProviderCapability,
  setApiProviderCapability,
} from '../src/app.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from './helpers/fakes.ts'

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
  assert.equal(
    app.setApiProviderCapability,
    apiHandlers.setApiProviderCapability
  )
  assert.equal(
    app.clearApiProviderCapability,
    apiHandlers.clearApiProviderCapability
  )
})

test('API capability helpers route DeepSeek search through toggle semantics', async () => {
  const states: string[] = []
  const adapter = createProviderAdapterStub()
  Object.assign(adapter, {
    hasToggleCapability: async () => true,
    getToggleState: async () => 'on',
    setToggleState: async (_name: string, state: string) => {
      states.push(state)
      return state
    },
  })
  const runtime = createFakeRuntime({ adapter })

  assert.deepEqual(
    await setApiProviderCapability('deepseek', runtime, 'search', 'off'),
    { name: 'search', state: 'deepseek.search: off' }
  )
  assert.deepEqual(
    await clearApiProviderCapability('deepseek', runtime, 'search'),
    { name: 'search', cleared: true }
  )
  assert.deepEqual(states, ['off', 'off'])
})

test('API capability helpers preserve action capability semantics', async () => {
  const events: string[] = []
  const adapter = createProviderAdapterStub()
  Object.assign(adapter, {
    listActionCapabilities: async () => [
      { name: 'canvas', state: 'available' },
    ],
    selectActionCapability: async (name: string) => {
      events.push(`select:${name}`)
      return 'selected'
    },
    clearActionCapability: async () => {
      events.push('clear')
    },
  })
  const runtime = createFakeRuntime({ adapter })

  await setApiProviderCapability('chatgpt', runtime, 'canvas', 'selected')
  await clearApiProviderCapability('chatgpt', runtime, 'canvas')

  assert.deepEqual(events, ['select:canvas', 'clear'])
})
