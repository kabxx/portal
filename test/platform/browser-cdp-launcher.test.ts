import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBrowserLaunchArguments,
  launchBrowser,
} from '../../src/platform/browser-cdp-launcher.ts'

test('buildBrowserLaunchArguments keeps the expected browser flags', () => {
  assert.deepEqual(buildBrowserLaunchArguments('C:\\profiles\\chrome', 9222), [
    '--remote-debugging-port=9222',
    '--user-data-dir=C:\\profiles\\chrome',
    '--homepage=about:blank',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
  ])
})

test('launchBrowser rejects unsupported browser engines before launch', async () => {
  await assert.rejects(
    launchBrowser('firefox' as never, 'missing-browser', 9222, 'profile'),
    /Unsupported browser engine: firefox/
  )
})
