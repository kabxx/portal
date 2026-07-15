import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildBrowserLaunchArguments,
  createBrowserDisconnectSignal,
  type BrowserConnectionEvents,
  launchBrowser,
} from '../../src/platform/browser-cdp-launcher.ts'

class FakeBrowserConnection implements BrowserConnectionEvents {
  private connected = true
  private listener: (() => void) | null = null

  public once(event: 'disconnected', listener: () => void): void {
    assert.equal(event, 'disconnected')
    this.listener = listener
  }

  public off(event: 'disconnected', listener: () => void): void {
    assert.equal(event, 'disconnected')
    if (this.listener === listener) {
      this.listener = null
    }
  }

  public isConnected(): boolean {
    return this.connected
  }

  public disconnect(): void {
    this.connected = false
    const listener = this.listener
    this.listener = null
    listener?.()
  }

  public listenerCount(): number {
    return this.listener === null ? 0 : 1
  }
}

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

test('browser disconnect signal resolves for an external disconnect', async () => {
  const browser = new FakeBrowserConnection()
  const disconnected = createBrowserDisconnectSignal(browser, () => false)

  browser.disconnect()

  await disconnected
  assert.equal(browser.listenerCount(), 0)
})

test('browser disconnect signal covers an already disconnected browser', async () => {
  const browser = new FakeBrowserConnection()
  browser.disconnect()

  await createBrowserDisconnectSignal(browser, () => false)
  assert.equal(browser.listenerCount(), 0)
})

test('browser disconnect signal ignores an intentional close', async () => {
  const browser = new FakeBrowserConnection()
  let resolved = false
  const disconnected = createBrowserDisconnectSignal(browser, () => true)
  void disconnected.then(() => {
    resolved = true
  })

  browser.disconnect()
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(resolved, false)
  assert.equal(browser.listenerCount(), 0)
})
