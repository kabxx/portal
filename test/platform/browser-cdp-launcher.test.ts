import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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

test('launchBrowser rejects a missing executable before creating a profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-launch-'))
  const executable = path.join(root, 'missing-browser')
  const profile = path.join(root, 'profile')

  try {
    await assert.rejects(
      launchBrowser('chromium', executable, 9222, profile),
      /Browser executable not found at path:/
    )
    await assert.rejects(access(profile), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
