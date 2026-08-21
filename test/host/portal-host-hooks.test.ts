import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { BrowserContext } from 'playwright'
import type {
  ExtensionRegistrationApi,
  HookInvocationContext,
  HookRuntimeClock,
  HookTimerHandle,
} from '../../src/extensions/extension-contracts.ts'
import {
  portalBeforeStartHook,
  portalBeforeStartSpec,
  portalBeforeStopHook,
  portalBeforeStopSpec,
  portalHostTestExtensions,
  portalReadyHook,
  portalReadySpec,
  portalStoppedHook,
  portalStoppedSpec,
  type PortalExtensionRegistration,
} from '../../src/extensions/portal-hooks.ts'
import { PortalHost } from '../../src/host/portal-host.ts'

test('Portal lifecycle Hook specs freeze their complete authorization boundary', () => {
  for (const spec of [
    portalBeforeStartSpec,
    portalReadySpec,
    portalBeforeStopSpec,
    portalStoppedSpec,
  ]) {
    assert.equal(Object.isFrozen(spec), true)
    assert.equal(Object.isFrozen(spec.allowedServices), true)
    assert.equal(Object.isFrozen(spec.allowedCapabilities), true)
  }
})

test('PortalHost invokes lifecycle Hooks around core resources in exact order', async () => {
  const fixture = createFixture('portal-host-hooks-order-')
  const events: string[] = []
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.portal-lifecycle', (api) => {
            api.handle(portalBeforeStartHook, {
              id: 'test.portal-before-start',
              handler: async (input, context) => {
                assert.deepEqual(input, {
                  sessionIntent: 'batch',
                  previousState: 'resolved',
                })
                assert.equal(Object.isFrozen(input), true)
                const active = activeContext(context)
                active.scope.defer('before-start test resource', () => {
                  events.push('beforeStart cleanup')
                })
                events.push('beforeStart')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalReadyHook, {
              id: 'test.portal-ready',
              handler: async (input, context) => {
                assert.deepEqual(input, { sessionIntent: 'batch' })
                const active = activeContext(context)
                active.scope.defer('ready test resource', () => {
                  events.push('ready cleanup')
                })
                events.push('ready')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalBeforeStopHook, {
              id: 'test.portal-before-stop',
              handler: async (input, context) => {
                assert.deepEqual(input, {
                  sessionIntent: 'batch',
                  previousState: 'ready',
                })
                const active = activeContext(context)
                active.scope.defer('before-stop test resource', () => {
                  events.push('beforeStop cleanup')
                })
                events.push('beforeStop')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalStoppedHook, {
              id: 'test.portal-stopped',
              handler: async (input, context) => {
                assert.deepEqual(input, {
                  sessionIntent: 'batch',
                  previousState: 'ready',
                  coreCleanup: { status: 'clean', errorCount: 0 },
                })
                assert.equal(context.scopeAccess, 'terminal')
                if (context.scopeAccess === 'terminal') {
                  assert.equal(context.scope.kind, 'portal')
                  assert.equal(
                    Reflect.has(context.scope, 'defer') ||
                      Reflect.has(context.scope, 'acquire'),
                    false
                  )
                }
                assert.equal(host?.state, 'stopped')
                events.push('stopped')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () => {
          events.push('browser launch')
          return browserLaunch(() => events.push('browser close'))
        },
      }
    )

    const firstStart = host.start()
    assert.equal(firstStart, host.start())
    await firstStart
    await host.close()
    await host.close()

    assert.deepEqual(events, [
      'beforeStart',
      'browser launch',
      'ready',
      'beforeStop',
      'browser close',
      'beforeStop cleanup',
      'ready cleanup',
      'beforeStart cleanup',
      'stopped',
    ])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.beforeStart failure rolls back its resources without launching a browser', async () => {
  const fixture = createFixture('portal-host-hook-before-start-')
  const events: string[] = []
  let launchCount = 0
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.tui',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.before-start-failure', (api) => {
            api.handle(portalBeforeStartHook, {
              id: 'test.before-start-failure',
              handler: async (_input, context) => {
                activeContext(context).scope.defer('rollback marker', () => {
                  events.push('rollback')
                })
                events.push('handler')
                throw new Error('beforeStart failed')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalBeforeStopHook, {
              id: 'test.before-stop-after-failure',
              handler: async (input) => {
                assert.equal(input.previousState, 'failed')
                events.push('beforeStop')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalStoppedHook, {
              id: 'test.stopped-after-failure',
              handler: async (input) => {
                assert.equal(input.previousState, 'failed')
                events.push('stopped')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () => {
          launchCount += 1
          return browserLaunch(() => {})
        },
      }
    )

    await assert.rejects(host.start(), /portal\.beforeStart/)
    assert.equal(host.state, 'failed')
    assert.equal(launchCount, 0)
    assert.deepEqual(events, ['handler', 'rollback'])
    await host.close()
    assert.deepEqual(events, ['handler', 'rollback', 'beforeStop', 'stopped'])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('a cancelled portal.ready Handler cannot publish services after shutdown', async () => {
  const fixture = createFixture('portal-host-hook-ready-close-')
  const readyStarted = Promise.withResolvers<void>()
  const finishReady = Promise.withResolvers<void>()
  let browserCloseCount = 0
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.pending-ready', (api) => {
            api.handle(portalReadyHook, {
              id: 'test.pending-ready',
              handler: async () => {
                readyStarted.resolve()
                await finishReady.promise
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () =>
          browserLaunch(() => {
            browserCloseCount += 1
          }),
      }
    )
    const start = host.start()
    await readyStarted.promise
    const close = host.close()

    await assert.rejects(start)
    await close
    assert.equal(host.state, 'stopped')
    assert.equal(browserCloseCount, 1)
    assert.throws(() => host?.services, /unavailable/)

    finishReady.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(host.state, 'stopped')
  } finally {
    finishReady.resolve()
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('PortalHost observes browser cleanup failure while portal.ready is pending', async () => {
  const fixture = createFixture('portal-host-ready-disconnect-')
  const readyStarted = Promise.withResolvers<void>()
  const finishReady = Promise.withResolvers<void>()
  const disconnected = Promise.withResolvers<void>()
  const observed = Promise.withResolvers<boolean>()
  let host: PortalHost | null = null

  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.pending-ready-disconnect', (api) => {
            api.handle(portalReadyHook, {
              id: 'test.pending-ready-disconnect',
              handler: async () => {
                readyStarted.resolve()
                await finishReady.promise
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () => ({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          context: { isClosed: () => false } as unknown as BrowserContext,
          disconnected: disconnected.promise,
          close: async () => undefined,
        }),
      }
    )
    host.subscribeSurfaceEvents((event) => {
      if (event.type === 'runtime.disconnected') {
        observed.resolve(event.cleanupVerified)
      }
    })

    const start = host.start()
    await readyStarted.promise
    disconnected.reject(new Error('cleanup uncertain'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    finishReady.resolve()
    await start

    assert.equal(await observed.promise, false)
  } finally {
    finishReady.resolve()
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.ready failure prevents publication and closes the acquired browser once', async () => {
  const fixture = createFixture('portal-host-hook-ready-')
  let browserCloseCount = 0
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.ready-failure', (api) => {
            api.handle(portalReadyHook, {
              id: 'test.ready-failure',
              handler: async () => {
                throw new Error('ready failed')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () =>
          browserLaunch(() => {
            browserCloseCount += 1
          }),
      }
    )

    await assert.rejects(host.start(), /portal\.ready/)
    assert.equal(host.state, 'failed')
    assert.equal(browserCloseCount, 1)
    assert.throws(() => host?.services, /unavailable/)
    await host.close()
    assert.equal(browserCloseCount, 1)
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.beforeStop aggregates every Handler failure and continues cleanup', async () => {
  const fixture = createFixture('portal-host-hook-before-stop-')
  const events: string[] = []
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.before-stop-failures', (api) => {
            for (const id of ['test.before-stop-one', 'test.before-stop-two']) {
              api.handle(portalBeforeStopHook, {
                id,
                handler: async () => {
                  events.push(id)
                  throw new Error(`${id} failed`)
                },
                requiredServices: [],
                requiredCapabilities: [],
              })
            }
            api.handle(portalStoppedHook, {
              id: 'test.stopped-after-before-stop-errors',
              handler: async (input) => {
                assert.deepEqual(input.coreCleanup, {
                  status: 'clean',
                  errorCount: 0,
                })
                events.push('stopped')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () =>
          browserLaunch(() => events.push('browser close')),
      }
    )
    await host.start()

    await assert.rejects(host.close(), AggregateError)
    assert.equal(host.state, 'stopped')
    assert.deepEqual(events, [
      'test.before-stop-one',
      'test.before-stop-two',
      'browser close',
      'stopped',
    ])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.stopped reports core cleanup failures without suppressing close errors', async () => {
  const fixture = createFixture('portal-host-hook-core-errors-')
  const events: string[] = []
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.core-cleanup-report', (api) => {
            api.handle(portalStoppedHook, {
              id: 'test.core-cleanup-report',
              handler: async (input) => {
                assert.deepEqual(input.coreCleanup, {
                  status: 'errors',
                  errorCount: 1,
                })
                events.push('stopped')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () =>
          browserLaunch(() => {
            events.push('browser close')
            throw new Error('browser cleanup failed')
          }),
      }
    )
    await host.start()

    await assert.rejects(host.close(), AggregateError)
    assert.equal(host.state, 'stopped')
    assert.deepEqual(events, ['browser close', 'stopped'])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.beforeStop Handlers share one absolute shutdown deadline', async () => {
  const fixture = createFixture('portal-host-hook-shutdown-deadline-')
  const clock = new ManualClock()
  const events: string[] = []
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        extensionClock: clock,
        [portalHostTestExtensions]: [
          extension('test.shutdown-deadline', (api) => {
            api.handle(portalBeforeStopHook, {
              id: 'test.shutdown-deadline-one',
              handler: async () => {
                events.push('first')
                clock.advance(3000)
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalBeforeStopHook, {
              id: 'test.shutdown-deadline-two',
              handler: async () => {
                events.push('second')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () => browserLaunch(() => {}),
      }
    )
    await host.start()

    await assert.rejects(host.close(), AggregateError)
    assert.equal(host.state, 'stopped')
    assert.deepEqual(events, ['first'])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('portal.stopped isolates Handler failure and reports close from resolved state', async () => {
  const fixture = createFixture('portal-host-hook-stopped-')
  const events: string[] = []
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.tui',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.stopped-isolation', (api) => {
            api.handle(portalBeforeStopHook, {
              id: 'test.before-stop-resolved',
              handler: async (input) => {
                assert.equal(input.previousState, 'resolved')
                events.push('beforeStop')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalStoppedHook, {
              id: 'test.stopped-isolated-failure',
              handler: async (input, context) => {
                assert.equal(input.sessionIntent, 'interactive')
                assert.equal(input.previousState, 'resolved')
                assert.deepEqual(input.coreCleanup, {
                  status: 'clean',
                  errorCount: 0,
                })
                assert.equal(context.scopeAccess, 'terminal')
                events.push('stopped')
                throw new Error('notification failure')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
      }
    )

    await host.close()
    assert.equal(host.state, 'stopped')
    assert.deepEqual(events, ['beforeStop', 'stopped'])
  } finally {
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

test('closing during portal.beforeStart cancels startup and still emits shutdown Hooks', async () => {
  const fixture = createFixture('portal-host-hook-start-close-')
  const handlerStarted = Promise.withResolvers<void>()
  const finishHandler = Promise.withResolvers<void>()
  const events: string[] = []
  let launchCount = 0
  let host: PortalHost | null = null
  try {
    host = await PortalHost.prepare(
      {
        entrySurfaceId: 'portal.exec',
        cwd: fixture.cwd,
        dataDirectory: fixture.dataDirectory,
      },
      {
        [portalHostTestExtensions]: [
          extension('test.start-close-race', (api) => {
            api.handle(portalBeforeStartHook, {
              id: 'test.pending-before-start',
              handler: async () => {
                events.push('beforeStart')
                handlerStarted.resolve()
                await finishHandler.promise
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalBeforeStopHook, {
              id: 'test.before-stop-after-start-cancel',
              handler: async (input) => {
                assert.equal(input.previousState, 'starting')
                events.push('beforeStop')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
            api.handle(portalStoppedHook, {
              id: 'test.stopped-after-start-cancel',
              handler: async () => {
                events.push('stopped')
              },
              requiredServices: [],
              requiredCapabilities: [],
            })
          }),
        ],
        launchBrowser: async () => {
          launchCount += 1
          return browserLaunch(() => {})
        },
      }
    )
    const start = host.start()
    await handlerStarted.promise
    const close = host.close()

    await assert.rejects(start)
    await close
    assert.equal(launchCount, 0)
    assert.equal(host.state, 'stopped')
    assert.deepEqual(events, ['beforeStart', 'beforeStop', 'stopped'])
  } finally {
    finishHandler.resolve()
    await host?.close().catch(() => {})
    fixture.remove()
  }
})

function extension(
  id: string,
  register: (api: ExtensionRegistrationApi) => void
): PortalExtensionRegistration {
  return {
    descriptor: {
      id,
      version: '1.0.0',
      dependencies: [],
      capabilities: [],
    },
    module: { register },
  }
}

function activeContext(
  context: HookInvocationContext
): Extract<HookInvocationContext, { readonly scopeAccess: 'active' }> {
  assert.equal(context.scopeAccess, 'active')
  if (context.scopeAccess !== 'active') {
    throw new Error('Expected an active Hook context.')
  }
  return context
}

function createFixture(prefix: string): {
  readonly cwd: string
  readonly dataDirectory: string
  remove(): void
} {
  const cwd = mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    cwd,
    dataDirectory: path.join(cwd, 'data'),
    remove: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

function browserLaunch(onClose: () => void): {
  readonly context: BrowserContext
  readonly disconnected: Promise<void>
  close(): Promise<void>
} {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    context: { isClosed: () => false } as unknown as BrowserContext,
    disconnected: new Promise(() => {}),
    close: async () => onClose(),
  }
}

class ManualClock implements HookRuntimeClock {
  readonly #timers = new Set<{
    readonly deadline: number
    readonly callback: () => void
    cancelled: boolean
  }>()
  #now = 0

  public now(): number {
    return this.#now
  }

  public setTimer(delayMs: number, callback: () => void): HookTimerHandle {
    const timer = {
      deadline: this.#now + delayMs,
      callback,
      cancelled: false,
    }
    this.#timers.add(timer)
    return {
      cancel: () => {
        timer.cancelled = true
        this.#timers.delete(timer)
      },
    }
  }

  public advance(delayMs: number): void {
    this.#now += delayMs
    for (const timer of [...this.#timers]) {
      if (!timer.cancelled && timer.deadline <= this.#now) {
        timer.cancelled = true
        this.#timers.delete(timer)
        timer.callback()
      }
    }
  }
}
