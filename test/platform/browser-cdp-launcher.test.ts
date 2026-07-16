import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'

import {
  buildBrowserLaunchArguments,
  connectBrowserOverCDP,
  createBrowserProcessFailureMonitor,
  createBrowserDisconnectSignal,
  type BrowserConnectionEvents,
  type BrowserConnector,
  launchBrowser,
  waitForBrowserDevToolsEndpoint,
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

function spawnNode(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
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
    '--enable-automation',
    '--disable-extensions',
    '--disable-sync',
    '--password-store=basic',
    '--use-mock-keychain',
  ])
})

test('buildBrowserLaunchArguments passes port zero through to Chromium', () => {
  assert.equal(
    buildBrowserLaunchArguments('profile', 0)[0],
    '--remote-debugging-port=0'
  )
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

test('launchBrowser rejects invalid debugging ports before creating a profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-port-'))
  const profile = path.join(root, 'profile')

  try {
    await assert.rejects(
      launchBrowser('chromium', process.execPath, -1, profile),
      /Invalid browser remote debugging port: -1/
    )
    await assert.rejects(
      launchBrowser('chromium', process.execPath, 65_536, profile),
      /Invalid browser remote debugging port: 65536/
    )
    await assert.rejects(access(profile), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser rejects an occupied fixed port before spawning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-port-'))
  const profile = path.join(root, 'profile')
  const server = net.createServer()

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')

    await assert.rejects(
      launchBrowser('chromium', process.execPath, address.port, profile),
      new RegExp(`port ${address.port} is already in use`)
    )
    await assert.rejects(access(profile), { code: 'ENOENT' })
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('waitForBrowserDevToolsEndpoint handles split Chromium output', async () => {
  const child = spawnNode(`
    process.stderr.write('DevTools listen')
    setTimeout(() => process.stderr.write('ing on ws://127.0.0.1:9222/devtools/browser/test\\n'), 10)
    setInterval(() => {}, 1000)
  `)

  try {
    assert.equal(
      await waitForBrowserDevToolsEndpoint(child, 9222, Date.now() + 1000),
      'ws://127.0.0.1:9222/devtools/browser/test'
    )
  } finally {
    await stopChild(child)
  }
})

test('waitForBrowserDevToolsEndpoint accepts Chromium dynamic ports', async () => {
  const child = spawnNode(`
    process.stderr.write('DevTools listening on ws://127.0.0.1:43123/devtools/browser/test\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    assert.equal(
      await waitForBrowserDevToolsEndpoint(child, 0, Date.now() + 1000),
      'ws://127.0.0.1:43123/devtools/browser/test'
    )
  } finally {
    await stopChild(child)
  }
})

test('waitForBrowserDevToolsEndpoint rejects wrong ports and remote hosts', async () => {
  const wrongPort = spawnNode(`
    process.stderr.write('DevTools listening on ws://127.0.0.1:9333/devtools/browser/test\\n')
    setInterval(() => {}, 1000)
  `)
  const remoteHost = spawnNode(`
    process.stderr.write('DevTools listening on ws://192.0.2.1:9222/devtools/browser/test\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(wrongPort, 9222, Date.now() + 1000),
      /reported CDP port 9333, expected 9222/
    )
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(remoteHost, 9222, Date.now() + 1000),
      /non-loopback CDP endpoint/
    )
  } finally {
    await Promise.all([stopChild(wrongPort), stopChild(remoteHost)])
  }
})

test('waitForBrowserDevToolsEndpoint reports Chromium profile conflicts', async () => {
  const child = spawnNode(`
    process.stderr.write('Failed to create a ProcessSingleton for your profile directory.\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(child, 9222, Date.now() + 1000),
      /Browser profile is already in use/
    )
  } finally {
    await stopChild(child)
  }
})

test('waitForBrowserDevToolsEndpoint reports early process exit', async () => {
  const child = spawnNode('process.exit(23)')

  await assert.rejects(
    waitForBrowserDevToolsEndpoint(child, 9222, Date.now() + 1000),
    /Browser exited before CDP was ready \(exit code 23\)/
  )
})

test('waitForBrowserDevToolsEndpoint reports spawn errors', async () => {
  const missing = path.join(
    os.tmpdir(),
    `portal-missing-browser-${process.pid}-${Date.now()}`
  )
  const child = spawn(missing, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  await assert.rejects(
    waitForBrowserDevToolsEndpoint(child, 9222, Date.now() + 1000),
    /Failed to start browser process:/
  )
})

test('waitForBrowserDevToolsEndpoint supports timeout and cancellation', async () => {
  const timeoutChild = spawnNode('setInterval(() => {}, 1000)')
  const cancelledChild = spawnNode('setInterval(() => {}, 1000)')
  const controller = new AbortController()

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(timeoutChild, 9222, Date.now() + 20),
      /Timed out waiting for the browser CDP endpoint/
    )
    const pending = waitForBrowserDevToolsEndpoint(
      cancelledChild,
      9222,
      Date.now() + 1000,
      controller.signal
    )
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
  } finally {
    await Promise.all([stopChild(timeoutChild), stopChild(cancelledChild)])
  }
})

test('connectBrowserOverCDP closes a connection that succeeds after cancellation', async () => {
  let resolveConnection!: (browser: Browser) => void
  const connection = new Promise<Browser>((resolve) => {
    resolveConnection = resolve
  })
  let closed = false
  const browser = {
    close: async () => {
      closed = true
    },
  } as Browser
  const connector: BrowserConnector = {
    connectOverCDP: async () => await connection,
  }
  const controller = new AbortController()

  const pending = connectBrowserOverCDP(
    connector,
    'ws://127.0.0.1:9222/devtools/browser/test',
    Date.now() + 1000,
    controller.signal
  )
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })

  resolveConnection(browser)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closed, true)
})

test('connectBrowserOverCDP fails when its browser exits after the CDP marker', async () => {
  const child = spawnNode('setTimeout(() => process.exit(17), 20)')
  const processFailure = createBrowserProcessFailureMonitor(child)
  const connector: BrowserConnector = {
    connectOverCDP: async () => await new Promise<Browser>(() => {}),
  }

  try {
    await assert.rejects(
      connectBrowserOverCDP(
        connector,
        'ws://127.0.0.1:9222/devtools/browser/test',
        Date.now() + 1000,
        undefined,
        processFailure.failure
      ),
      /Browser exited while connecting to CDP \(exit code 17\)/
    )
  } finally {
    processFailure.close()
    await stopChild(child)
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
