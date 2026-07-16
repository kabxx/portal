import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  launchBrowser,
  type BrowserLaunch,
} from '../../src/platform/browser-cdp-launcher.ts'

const browserExecutablePath = process.env.PORTAL_BROWSER_EXECUTABLE

async function reserveAvailablePort(): Promise<number> {
  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return address.port
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open: boolean) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function waitForPortToClose(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) {
      return
    }
    await sleep(100)
  }
  assert.fail(`Browser CDP port ${port} remained open after ${timeoutMs}ms.`)
}

test('launchBrowser starts and cleans up a real Chromium process', async () => {
  assert.ok(
    browserExecutablePath,
    'Set PORTAL_BROWSER_EXECUTABLE to a Chromium-based browser executable.'
  )

  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-smoke-'))
  const profile = path.join(root, 'profile')
  let launch: BrowserLaunch | null = null

  try {
    const port = await reserveAvailablePort()
    launch = await launchBrowser(
      'chromium',
      browserExecutablePath,
      port,
      profile,
      { startupTimeoutMs: 45_000, closeTimeoutMs: 5_000 }
    )

    assert.ok(launch.context.browser()?.isConnected())
    assert.equal(await isPortOpen(port), true)

    const firstClose = launch.close()
    const secondClose = launch.close()
    await Promise.all([firstClose, secondClose])
    await waitForPortToClose(port, 10_000)
  } finally {
    await launch?.close()
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
})
