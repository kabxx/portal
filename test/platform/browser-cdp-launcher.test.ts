import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext } from 'playwright'

import {
  BrowserStartupError,
  buildBrowserLaunchArguments,
  browserLaunchTestExtensions,
  connectBrowserOverCDP,
  createBrowserProcessFailureMonitor,
  createBrowserDisconnectSignal,
  type BrowserConnection,
  type BrowserConnectionEvents,
  type BrowserConnector,
  type BrowserRuntimeConnection,
  launchBrowser,
  reserveDynamicBrowserPort,
  sanitizeBrowserConnectionError,
  waitForBrowserDevToolsEndpoint,
} from '../../src/platform/browser-cdp-launcher.ts'
import {
  BrowserProcessTreeCleanupError,
  type BrowserProcess,
} from '../../src/platform/browser-process.ts'

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

class FakeRuntimeBrowser
  extends FakeBrowserConnection
  implements BrowserRuntimeConnection
{
  private readonly context: BrowserContext

  public constructor() {
    super()
    // The launcher only forwards this opaque context in these tests.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    this.context = {} as BrowserContext
  }

  public contexts(): BrowserContext[] {
    return [this.context]
  }

  public async close(): Promise<void> {
    this.disconnect()
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

function createInjectedBrowserProcess(
  script: string,
  onClose: () => void,
  cleanupError?: Error
): BrowserProcess {
  const child = spawnNode(script)
  let closePromise: Promise<void> | null = null
  return {
    process: child,
    browserPid: child.pid ?? 0,
    close: () => {
      closePromise ??= (async () => {
        await stopChild(child)
        onClose()
        if (cleanupError !== undefined) {
          throw cleanupError
        }
      })()
      return closePromise
    },
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for test condition.')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test('buildBrowserLaunchArguments keeps the expected browser flags', () => {
  assert.deepEqual(buildBrowserLaunchArguments('C:\\profiles\\chrome', 9222), [
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=C:\\profiles\\chrome',
    '--homepage=about:blank',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-extensions',
    '--disable-sync',
    '--password-store=basic',
    '--use-mock-keychain',
  ])
})

test('buildBrowserLaunchArguments never passes port zero to Chromium', () => {
  assert.throws(
    () => buildBrowserLaunchArguments('profile', 0),
    /actual non-zero CDP port/
  )
})

test('launchBrowser rejects unsupported browser engines before launch', async () => {
  await assert.rejects(
    // @ts-expect-error Verify the runtime boundary rejects unsupported engines.
    launchBrowser('firefox', 'missing-browser', 9222, 'profile'),
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

test(
  'launchBrowser hardens only the configured POSIX profile root',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-mode-'))
    const profile = path.join(root, 'profile')
    const child = path.join(profile, 'existing.txt')

    try {
      await mkdir(profile, { mode: 0o755 })
      await writeFile(child, 'existing', { mode: 0o644 })
      await assert.rejects(
        launchBrowser('chromium', process.execPath, 0, profile)
      )
      assert.equal((await stat(profile)).mode & 0o777, 0o700)
      assert.equal((await stat(child)).mode & 0o777, 0o644)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

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

test('launchBrowser applies its startup deadline to fixed-port probing', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-browser-fixed-deadline-')
  )
  const profile = path.join(root, 'profile')

  try {
    await assert.rejects(
      launchBrowser('chromium', process.execPath, 43119, profile, {
        startupTimeoutMs: 0,
      }),
      /Timed out while reserving a browser CDP port/
    )
    await assert.rejects(access(profile), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reserveDynamicBrowserPort returns a closed non-zero loopback port', async () => {
  const port = await reserveDynamicBrowserPort()
  assert.ok(port > 0)

  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

test('reserveDynamicBrowserPort waits for an aborted probe to close', async () => {
  const controller = new AbortController()
  const reservation = reserveDynamicBrowserPort(
    controller.signal,
    Date.now() + 1000
  )
  controller.abort()

  await assert.rejects(reservation, { name: 'AbortError' })
})

test('launchBrowser rechecks cancellation after dynamic port allocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-abort-'))
  const controller = new AbortController()
  let launches = 0

  try {
    await assert.rejects(
      launchBrowser(
        'chromium',
        process.execPath,
        0,
        path.join(root, 'profile'),
        {
          signal: controller.signal,
          [browserLaunchTestExtensions]: {
            reserveDynamicPort: async () => {
              controller.abort()
              return 43120
            },
            launchProcess: async () => {
              launches += 1
              throw new Error('Browser process must not launch.')
            },
          },
        }
      ),
      { name: 'AbortError' }
    )
    assert.equal(launches, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser bounds dynamic port allocation by its startup deadline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-deadline-'))
  let launches = 0
  let reservations = 0
  const startedAt = Date.now()

  try {
    await assert.rejects(
      launchBrowser(
        'chromium',
        process.execPath,
        0,
        path.join(root, 'profile'),
        {
          startupTimeoutMs: 1000,
          [browserLaunchTestExtensions]: {
            reserveDynamicPort: async (deadline) => {
              reservations += 1
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.max(0, deadline - Date.now()))
              )
              throw new Error('Timed out while reserving a browser CDP port.')
            },
            launchProcess: async () => {
              launches += 1
              throw new Error('Browser process must not launch.')
            },
          },
        }
      ),
      /Timed out while reserving a browser CDP port/
    )
    assert.equal(launches, 0)
    assert.equal(reservations, 1)
    assert.ok(Date.now() - startedAt < 2500)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser waits for an aborted port reservation to clean up', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-browser-port-cleanup-')
  )
  const controller = new AbortController()
  const reservationStarted = Promise.withResolvers<void>()
  let cleanupFinished = false

  try {
    const launching = launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        signal: controller.signal,
        [browserLaunchTestExtensions]: {
          reserveDynamicPort: async (_deadline, signal) => {
            reservationStarted.resolve()
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  setTimeout(() => {
                    cleanupFinished = true
                    reject(new DOMException('Operation aborted.', 'AbortError'))
                  }, 20)
                },
                { once: true }
              )
            })
            return 43120
          },
        },
      }
    )

    await reservationStarted.promise
    controller.abort()
    await assert.rejects(launching, { name: 'AbortError' })
    assert.equal(cleanupFinished, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser retries only after a dynamic CDP bind process is cleaned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-retry-'))
  const ports = [43121, 43122]
  const launches: string[][] = []
  let allocations = 0
  let cleanedProcesses = 0
  const browser = new FakeRuntimeBrowser()
  const connector: BrowserConnector<BrowserRuntimeConnection> = {
    connectOverCDP: async (endpoint) => {
      assert.equal(endpoint, 'ws://127.0.0.1:43122/devtools/browser/test')
      return browser
    },
  }

  try {
    const launch = await launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        startupTimeoutMs: 2000,
        closeTimeoutMs: 1000,
        [browserLaunchTestExtensions]: {
          connector,
          reserveDynamicPort: async () => ports[allocations++]!,
          launchProcess: async (_executable, args) => {
            launches.push(args)
            if (launches.length === 2) {
              assert.equal(cleanedProcesses, 1)
            }
            const port = ports[launches.length - 1]!
            const output =
              launches.length === 1
                ? 'bind failed: address already in use\n'
                : `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/test\n`
            return createInjectedBrowserProcess(
              `process.stderr.write(${JSON.stringify(output)}); setInterval(() => {}, 1000)`,
              () => {
                cleanedProcesses += 1
              }
            )
          },
        },
      }
    )

    assert.equal(launch.remoteDebuggingPort, 43122)
    assert.equal(launches.length, 2)
    assert.equal(allocations, 2)
    for (const args of launches) {
      assert.equal(args.includes('--remote-debugging-port=0'), false)
      assert.equal(args.includes('--remote-debugging-address=127.0.0.1'), true)
    }
    await launch.close()
    assert.equal(cleanedProcesses, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser does not retry when process-tree cleanup is uncertain', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-browser-cleanup-failure-')
  )
  let launches = 0
  let allocations = 0

  try {
    await assert.rejects(
      launchBrowser(
        'chromium',
        process.execPath,
        0,
        path.join(root, 'profile'),
        {
          startupTimeoutMs: 1000,
          closeTimeoutMs: 500,
          [browserLaunchTestExtensions]: {
            reserveDynamicPort: async () => {
              allocations += 1
              return 43123
            },
            launchProcess: async () => {
              launches += 1
              return createInjectedBrowserProcess(
                "process.stderr.write('bind failed: address already in use\\n'); setInterval(() => {}, 1000)",
                () => {},
                new BrowserProcessTreeCleanupError('cleanup uncertain')
              )
            },
          },
        }
      ),
      (error) =>
        error instanceof BrowserProcessTreeCleanupError &&
        error.code === 'BROWSER_PROCESS_TREE_CLEANUP_FAILED'
    )
    assert.equal(launches, 1)
    assert.equal(allocations, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser limits automatic CDP bind retries to three attempts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-limit-'))
  let launches = 0
  let allocations = 0
  let cleanups = 0

  try {
    await assert.rejects(
      launchBrowser(
        'chromium',
        process.execPath,
        0,
        path.join(root, 'profile'),
        {
          startupTimeoutMs: 2000,
          closeTimeoutMs: 500,
          [browserLaunchTestExtensions]: {
            reserveDynamicPort: async () => 43200 + allocations++,
            launchProcess: async () => {
              launches += 1
              return createInjectedBrowserProcess(
                "process.stderr.write('bind failed: address already in use\\n'); setInterval(() => {}, 1000)",
                () => {
                  cleanups += 1
                }
              )
            },
          },
        }
      ),
      (error) =>
        error instanceof BrowserStartupError && error.code === 'CDP_BIND'
    )
    assert.equal(launches, 3)
    assert.equal(allocations, 3)
    assert.equal(cleanups, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser does not retry profile conflicts in automatic port mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-profile-'))
  let launches = 0
  let allocations = 0

  try {
    await assert.rejects(
      launchBrowser(
        'chromium',
        process.execPath,
        0,
        path.join(root, 'profile'),
        {
          startupTimeoutMs: 1000,
          closeTimeoutMs: 500,
          [browserLaunchTestExtensions]: {
            reserveDynamicPort: async () => {
              allocations += 1
              return 43124
            },
            launchProcess: async () => {
              launches += 1
              return createInjectedBrowserProcess(
                "process.stderr.write('Failed to create a ProcessSingleton for the profile directory.\\n'); setInterval(() => {}, 1000)",
                () => {}
              )
            },
          },
        }
      ),
      (error) =>
        error instanceof BrowserStartupError && error.code === 'PROFILE_IN_USE'
    )
    assert.equal(launches, 1)
    assert.equal(allocations, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchBrowser classifies a bind error at the drained stderr tail before retrying', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-tail-'))
  const ports = [43127, 43128]
  let launches = 0
  let cleanups = 0
  const browser = new FakeRuntimeBrowser()

  try {
    const launch = await launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        startupTimeoutMs: 3000,
        closeTimeoutMs: 1000,
        [browserLaunchTestExtensions]: {
          connector: {
            connectOverCDP: async (endpoint) => {
              assert.equal(
                endpoint,
                'ws://127.0.0.1:43128/devtools/browser/test'
              )
              return browser
            },
          },
          reserveDynamicPort: async () => ports[launches]!,
          launchProcess: async () => {
            launches += 1
            const port = ports[launches - 1]!
            const script =
              launches === 1
                ? `process.stderr.write('x'.repeat(256 * 1024), () => process.stderr.write('\\nbind failed: address already in use\\n', () => process.exit(23)))`
                : `process.stderr.write('DevTools listening on ws://127.0.0.1:${port}/devtools/browser/test\\n'); setInterval(() => {}, 1000)`
            return createInjectedBrowserProcess(script, () => {
              cleanups += 1
            })
          },
        },
      }
    )

    assert.equal(launches, 2)
    assert.equal(cleanups, 1)
    await launch.close()
    assert.equal(cleanups, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unexpected browser disconnect cleans the process tree before publishing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-exit-'))
  const browser = new FakeRuntimeBrowser()
  let cleanups = 0

  try {
    const launch = await launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        closeTimeoutMs: 500,
        [browserLaunchTestExtensions]: {
          connector: {
            connectOverCDP: async () => browser,
          },
          reserveDynamicPort: async () => 43125,
          launchProcess: async () =>
            createInjectedBrowserProcess(
              "process.stderr.write('DevTools listening on ws://127.0.0.1:43125/devtools/browser/test\\n'); setInterval(() => {}, 1000)",
              () => {
                cleanups += 1
              }
            ),
        },
      }
    )

    browser.disconnect()
    await launch.disconnected
    assert.equal(cleanups, 1)
    await launch.close()
    assert.equal(cleanups, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unexpected browser disconnect rejects when process cleanup is uncertain', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-browser-disconnect-cleanup-')
  )
  const browser = new FakeRuntimeBrowser()

  try {
    const launch = await launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        closeTimeoutMs: 500,
        [browserLaunchTestExtensions]: {
          connector: { connectOverCDP: async () => browser },
          reserveDynamicPort: async () => 43129,
          launchProcess: async () =>
            createInjectedBrowserProcess(
              "process.stderr.write('DevTools listening on ws://127.0.0.1:43129/devtools/browser/test\\n'); setInterval(() => {}, 1000)",
              () => {},
              new BrowserProcessTreeCleanupError('cleanup uncertain')
            ),
        },
      }
    )

    browser.disconnect()
    await assert.rejects(
      launch.disconnected,
      (error) => error instanceof BrowserProcessTreeCleanupError
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser close starts process cleanup without waiting for Playwright', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-browser-close-'))
  const connection = new FakeRuntimeBrowser()
  connection.close = async () => await new Promise<void>(() => {})
  let processCloseStarted = false

  try {
    const launch = await launchBrowser(
      'chromium',
      process.execPath,
      0,
      path.join(root, 'profile'),
      {
        closeTimeoutMs: 100,
        [browserLaunchTestExtensions]: {
          connector: { connectOverCDP: async () => connection },
          reserveDynamicPort: async () => 43126,
          launchProcess: async () => {
            const child = spawnNode(
              "process.stderr.write('DevTools listening on ws://127.0.0.1:43126/devtools/browser/test\\n'); setInterval(() => {}, 1000)"
            )
            let closePromise: Promise<void> | null = null
            return {
              process: child,
              browserPid: child.pid ?? 0,
              close: () => {
                processCloseStarted = true
                closePromise ??= stopChild(child)
                return closePromise
              },
            }
          },
        },
      }
    )

    const closing = launch.close()
    await waitUntil(() => processCloseStarted)
    await closing
  } finally {
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

test('waitForBrowserDevToolsEndpoint rejects an endpoint for another port', async () => {
  const child = spawnNode(`
    process.stderr.write('DevTools listening on ws://127.0.0.1:43123/devtools/browser/test\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(child, 43124, Date.now() + 1000),
      /reported CDP port 43123, expected 43124/
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

test('waitForBrowserDevToolsEndpoint classifies profile conflicts', async () => {
  const child = spawnNode(`
    process.stderr.write('Unable to create a ProcessSingleton for the profile directory.\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(child, 43123, Date.now() + 1000),
      (error) =>
        error instanceof BrowserStartupError && error.code === 'PROFILE_IN_USE'
    )
  } finally {
    await stopChild(child)
  }
})

test('waitForBrowserDevToolsEndpoint classifies CDP bind failures', async () => {
  const child = spawnNode(`
    process.stderr.write('bind failed: address already in use\\n')
    setInterval(() => {}, 1000)
  `)

  try {
    await assert.rejects(
      waitForBrowserDevToolsEndpoint(child, 43123, Date.now() + 1000),
      (error) =>
        error instanceof BrowserStartupError && error.code === 'CDP_BIND'
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
  interface ClosableBrowser {
    close(): Promise<void>
  }

  let resolveConnection!: (browser: ClosableBrowser) => void
  const connection = new Promise<ClosableBrowser>((resolve) => {
    resolveConnection = resolve
  })
  let closed = false
  const browser = {
    close: async () => {
      closed = true
    },
  }
  const connector: BrowserConnector<ClosableBrowser> = {
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

test('sanitizeBrowserConnectionError removes the CDP browser identifier', () => {
  const sanitized = sanitizeBrowserConnectionError(
    new Error(
      'connect ECONNREFUSED ws://127.0.0.1:43123/devtools/browser/550e8400-e29b-41d4-a716-446655440000'
    )
  )

  assert.ok(sanitized instanceof Error)
  assert.match(sanitized.message, /\/devtools\/browser\/\[redacted\]/)
  assert.doesNotMatch(sanitized.message, /550e8400/)
})

test('connectBrowserOverCDP fails when its browser exits after the CDP marker', async () => {
  const child = spawnNode('setTimeout(() => process.exit(17), 20)')
  const processFailure = createBrowserProcessFailureMonitor(child)
  const connector: BrowserConnector<BrowserConnection> = {
    connectOverCDP: async () => await new Promise<BrowserConnection>(() => {}),
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
