import assert from 'node:assert/strict'
import test from 'node:test'

import type { KeybindingCatalog } from '../../src/keybindings/keybinding-catalog.ts'
import type { PortalMcpServer } from '../../src/mcp-server/mcp-server.ts'
import { listProviderModels } from '../../src/providers/provider-model-catalog.ts'
import {
  createPortalCommandServices,
  portalCommandCompletionSnapshot,
} from '../../src/host/portal-command-services.ts'
import type { PortalHostStartedServices } from '../../src/host/portal-host.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { ThreadOperationCoordinator } from '../../src/threads/thread-operation-coordinator.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'
import { createTestSurfacePort } from '../helpers/surface-port.ts'

test('portal Command thread adapter validates model selection before lifecycle creation', async () => {
  const creations: unknown[] = []
  const started = {
    lifecycle: {
      create: async (input: unknown) => {
        creations.push(input)
        return { ok: true }
      },
    },
  }
  const ui = new TerminalController()
  const services = createPortalCommandServices(
    {
      // These tests exercise the private host adapter one port at a time.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: started as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )
  const signal = new AbortController().signal

  const invalid = await services.threads.create({
    provider: 'gemini',
    modelKey: 'missing-model',
    optionKey: null,
    mode: 'agent',
    signal,
  })
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.message, /does not support model/)
  assert.equal(creations.length, 0)

  const modelKey = listProviderModels('gemini')[0]
  assert.ok(modelKey !== undefined)
  assert.deepEqual(
    await services.threads.create({
      provider: 'gemini',
      modelKey,
      optionKey: null,
      mode: 'chat',
      signal,
    }),
    { ok: true }
  )
  assert.deepEqual(creations, [
    {
      provider: 'gemini',
      model: { key: modelKey, option: null },
      mode: 'chat',
      source: 'tui',
      activate: true,
    },
  ])
})

test('portal Command output maps structured messages and discovery is deeply frozen', () => {
  const ui = new TerminalController()
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {} as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )

  services.output.write({
    level: 'warning',
    title: '/test',
    body: ['First', 'Second'],
  })
  assert.deepEqual(ui.getState().timeline.at(-1), {
    id: 1,
    tone: 'warning',
    label: '/test',
    body: 'First\nSecond',
    format: 'plain',
  })

  const snapshot = portalCommandCompletionSnapshot()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.entries), true)
  assert.equal(
    snapshot.entries.every(
      (entry) =>
        Object.isFrozen(entry) &&
        Object.isFrozen(entry.dependencies) &&
        Object.isFrozen(entry.candidates) &&
        entry.candidates.every(Object.isFrozen)
    ),
    true
  )
})

test('portal Command reload owns the Thread operation and bridges cancellation', async () => {
  const adapter = createProviderAdapterStub()
  const restoreStarted = Promise.withResolvers<AbortSignal>()
  Object.assign(adapter, {
    restore: async ({ signal }: { signal: AbortSignal }) => {
      restoreStarted.resolve(signal)
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('reload aborted')
            ),
          { once: true }
        )
      })
    },
  })
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter }),
    createdAt: 1,
  })
  const operations = new ThreadOperationCoordinator(100)
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(threadManager))
  ui.showThreadTimeline(thread.id)
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {
        threadManager,
        lifecycle: {
          startOperation: (
            threadId: string,
            runner: Parameters<ThreadOperationCoordinator['tryStart']>[2],
            stopTarget: Parameters<ThreadOperationCoordinator['tryStart']>[1]
          ) => operations.tryStart(threadId, stopTarget, runner),
        },
      } as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )
  const commandController = new AbortController()
  const reload = services.threads.reloadActive(commandController.signal)
  const operationSignal = await restoreStarted.promise

  assert.equal(ui.getState().busy, true)
  assert.equal(operations.get(thread.id)?.phase, 'running')
  commandController.abort(new DOMException('cancel reload', 'AbortError'))
  await assert.rejects(reload, { name: 'AbortError' })
  assert.equal(operationSignal.aborted, true)
  assert.equal(operations.get(thread.id), null)
  assert.equal(ui.getState().busy, false)
})

test('portal Command reload remains busy until an abort-ignoring operation settles', async () => {
  const adapter = createProviderAdapterStub()
  const restoreStarted = Promise.withResolvers<void>()
  const restoreFinished = Promise.withResolvers<void>()
  Object.assign(adapter, {
    restore: async () => {
      restoreStarted.resolve()
      await restoreFinished.promise
    },
  })
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({ adapter }),
    createdAt: 1,
  })
  const operations = new ThreadOperationCoordinator(5)
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(threadManager))
  ui.showThreadTimeline(thread.id)
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {
        threadManager,
        lifecycle: {
          startOperation: (
            threadId: string,
            runner: Parameters<ThreadOperationCoordinator['tryStart']>[2],
            stopTarget: Parameters<ThreadOperationCoordinator['tryStart']>[1]
          ) => operations.tryStart(threadId, stopTarget, runner),
        },
      } as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )
  const commandController = new AbortController()
  const reload = services.threads.reloadActive(commandController.signal)
  await restoreStarted.promise

  commandController.abort(new DOMException('cancel reload', 'AbortError'))
  await assert.rejects(reload, { name: 'AbortError' })
  assert.equal(operations.get(thread.id)?.phase, 'cancelling')
  assert.equal(ui.getState().busy, true)

  restoreFinished.resolve()
  assert.equal(await operations.waitForIdle(thread.id), true)
  await Promise.resolve()
  assert.equal(operations.get(thread.id), null)
  assert.equal(ui.getState().busy, false)
})

test('portal Command reload rejects a concurrent Thread operation', async () => {
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const operations = new ThreadOperationCoordinator(100)
  const active = Promise.withResolvers<void>()
  const existing = operations.tryStart(thread.id, null, async () => {
    await active.promise
  })
  assert.equal(existing.accepted, true)
  const ui = new TerminalController()
  ui.bindSurfacePort(createTestSurfacePort(threadManager))
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {
        threadManager,
        lifecycle: {
          startOperation: (
            threadId: string,
            runner: Parameters<ThreadOperationCoordinator['tryStart']>[2],
            stopTarget: Parameters<ThreadOperationCoordinator['tryStart']>[1]
          ) => operations.tryStart(threadId, stopTarget, runner),
        },
      } as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )

  assert.deepEqual(
    await services.threads.reloadActive(new AbortController().signal),
    {
      ok: false,
      message: `Thread ${thread.id} already has an active operation.`,
      threadId: thread.id,
    }
  )
  active.resolve()
  if (existing.accepted) await existing.operation.done
})

test('portal Command close reports logical removal when runtime cleanup fails', async () => {
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime({
      close: async () => {
        throw new Error('runtime cleanup failed')
      },
    }),
    createdAt: 1,
  })
  const ui = new TerminalController()
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {
        threadManager,
        lifecycle: {
          close: async (threadId: string) => {
            await threadManager.closeThread(threadId)
            return { ok: true, threadId, closed: true }
          },
        },
      } as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )

  assert.deepEqual(
    await services.threads.close(thread.id, new AbortController().signal),
    {
      ok: false,
      message: `Thread ${thread.id} was closed, but cleanup failed: Error: runtime cleanup failed`,
      removedThreadId: thread.id,
    }
  )
  assert.equal(threadManager.getThread(thread.id), null)
})

test('portal Command close propagates cancellation and observes late settlement', async () => {
  const threadManager = new ThreadManager()
  const thread = threadManager.addThread({
    id: threadManager.createThreadId(),
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const closeFinished = Promise.withResolvers<{
    readonly ok: true
    readonly threadId: string
    readonly closed: true
  }>()
  const ui = new TerminalController()
  const services = createPortalCommandServices(
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      started: {
        threadManager,
        lifecycle: {
          close: async () => await closeFinished.promise,
        },
      } as unknown as PortalHostStartedServices,
      ui,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      keybindings: {} as KeybindingCatalog,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      mcp: {} as PortalMcpServer,
    },
    { list: () => [] }
  )
  const controller = new AbortController()
  const closing = services.threads.close(thread.id, controller.signal)
  controller.abort(new DOMException('cancel close', 'AbortError'))

  await assert.rejects(closing, { name: 'AbortError' })
  closeFinished.resolve({ ok: true, threadId: thread.id, closed: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
})
