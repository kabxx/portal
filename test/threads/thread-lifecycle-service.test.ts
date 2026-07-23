import test from 'node:test'
import assert from 'node:assert/strict'

import { loadProjectInstructions } from '../../src/instructions/project-instructions.ts'
import type { PortalAgentInstructionsConfig } from '../../src/config/portal-config.ts'
import type { ConversationHistoryResult } from '../../src/providers/conversation-history.ts'
import type { RuntimeCore } from '../../src/runtime/runtime-core.ts'
import {
  ThreadCloseCleanupError,
  ThreadManager,
} from '../../src/threads/thread-manager.ts'
import {
  ThreadCloseTimeoutError,
  ThreadOperationCoordinator,
} from '../../src/threads/thread-operation-coordinator.ts'
import {
  ThreadLifecycleService,
  type ThreadLifecycleDependencies,
  type ThreadLifecycleEvent,
} from '../../src/threads/thread-lifecycle-service.ts'
import { ThreadRuntimeRegistry } from '../../src/threads/thread-runtime-registry.ts'
import {
  ThreadStore,
  type CreateThreadHistoryEntryInput,
  type ThreadHistoryEntry,
} from '../../src/threads/thread-store.ts'
import {
  createFakeRuntime,
  createProviderAdapterStub,
} from '../helpers/fakes.ts'

interface HarnessOptions {
  runtime?: RuntimeCore
  runtimeFactory?: () => Promise<RuntimeCore>
  cancelWaitTimeoutMs?: number
}

interface Harness {
  service: ThreadLifecycleService
  manager: ThreadManager
  operations: ThreadOperationCoordinator
  registry: ThreadRuntimeRegistry<RuntimeCore>
  events: ThreadLifecycleEvent[]
}

const EMPTY_INSTRUCTION_CONFIG: PortalAgentInstructionsConfig = {
  claude: { global: false, local: false },
  codex: { global: false, local: false },
}

class TestThreadStore extends ThreadStore {
  public constructor() {
    super(':memory:')
  }

  public override async touch(
    input: CreateThreadHistoryEntryInput
  ): Promise<ThreadHistoryEntry> {
    return {
      id: 1,
      provider: input.provider,
      conversationUrl: input.conversationUrl,
      title: input.title ?? null,
      createdAt: 'test',
      lastUsedAt: 'test',
    }
  }

  public override async setTitleIfEmpty(_input: {
    conversationUrl: string
    title: string
    lastUsedAt?: number | Date | string
  }): Promise<void> {}
}

function createHarness(options: HarnessOptions = {}): Harness {
  const manager = new ThreadManager()
  const operations = new ThreadOperationCoordinator(
    options.cancelWaitTimeoutMs ?? 25
  )
  const registry = new ThreadRuntimeRegistry<RuntimeCore>()
  const events: ThreadLifecycleEvent[] = []
  const runtime = options.runtime ?? createFakeRuntime()
  const adapter = createProviderAdapterStub()
  const store = new TestThreadStore()

  const dependencies: ThreadLifecycleDependencies = {
    threadManager: manager,
    threadOperations: operations,
    threadStore: store,
    runtimeRegistry: registry,
    browserProfileDir: 'test-profile',
    initializationAttemptLimit: 1,
    resolveConversationUrl: (value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:'
          ? { provider: 'chatgpt', conversationUrl: url.toString() }
          : null
      } catch {
        return null
      }
    },
    createProjectInstructions: async () =>
      (
        await loadProjectInstructions({
          cwd: process.cwd(),
          config: EMPTY_INSTRUCTION_CONFIG,
        })
      ).instructions,
    createAdapter: async () => adapter,
    createRuntime: async () =>
      options.runtimeFactory === undefined
        ? runtime
        : await options.runtimeFactory(),
    waitForLogin: async () => {},
    observer: {
      onEvent: (event) => {
        events.push(event)
      },
    },
  }

  return {
    service: new ThreadLifecycleService(dependencies),
    manager,
    operations,
    registry,
    events,
  }
}

function admitThread(harness: Harness, runtime: RuntimeCore, id = 't-1'): void {
  harness.registry.commitPrepared({
    id,
    provider: 'chatgpt',
    runtime,
    origin: 'new',
    source: 'tui',
    conversationId: runtime.conversationId,
    conversationUrl: runtime.conversationUrl,
    createdAt: 1,
  })
  harness.manager.addThread({
    id,
    provider: 'chatgpt',
    runtime,
    createdAt: 1,
    source: 'tui',
  })
}

function getProvisionFinished(
  events: readonly ThreadLifecycleEvent[]
): Extract<ThreadLifecycleEvent, { type: 'provision.finished' }> {
  const event = events.find(
    (candidate) => candidate.type === 'provision.finished'
  )
  assert.ok(event)
  return event
}

test('provision failure preserves TUI source and releases runtime and reservation', async () => {
  const conversationUrl = 'https://chatgpt.com/c/provision-failure'
  let closeCalls = 0
  const runtime = createFakeRuntime({
    conversationUrl: 'not-a-conversation-url',
    close: async () => {
      closeCalls += 1
    },
  })
  const harness = createHarness({ runtime })

  const result = await harness.service.resume({
    conversationUrl,
    source: 'tui',
    activate: true,
  })

  assert.equal(result.ok, false)
  assert.equal(getProvisionFinished(harness.events).source, 'tui')
  assert.equal(closeCalls, 1)
  assert.equal(harness.registry.list().length, 0)
  const claimed = harness.registry.getThreadIdByConversationUrl(conversationUrl)
  assert.equal(claimed, null)
  const probeOwner = 'probe'
  const reserved = harness.registry.reserveConversationUrl(
    probeOwner,
    conversationUrl
  )
  harness.registry.releaseConversationUrl(probeOwner, reserved)
})

test('resume preparation failure is reported as a provider failure', async () => {
  const harness = createHarness({
    runtimeFactory: async () => {
      throw new Error('runtime setup failed')
    },
  })

  const result = await harness.service.resume({
    conversationUrl: 'https://chatgpt.com/c/runtime-failure',
    source: 'tui',
    activate: true,
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.failure.code, 'provider_failure')
  assert.equal(result.failure.stage, 'building_runtime')
})

test('close timeout keeps the runtime registry claim while the manager still owns the thread', async () => {
  let releaseRunner!: () => void
  let releaseStop!: () => void
  const runnerBlocked = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const stopBlocked = new Promise<void>((resolve) => {
    releaseStop = resolve
  })
  const conversationUrl = 'https://chatgpt.com/c/close-timeout'
  const runtime = createFakeRuntime({
    conversationUrl,
    stopGeneration: async () => await stopBlocked,
  })
  const harness = createHarness({
    runtime,
    cancelWaitTimeoutMs: 5,
  })
  admitThread(harness, runtime)

  const started = harness.service.startSend(
    't-1',
    'input',
    async () => await runnerBlocked
  )
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  await assert.rejects(harness.service.close('t-1'), ThreadCloseTimeoutError)
  assert.equal(harness.manager.getThread('t-1')?.id, 't-1')
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'closing')
  assert.equal(
    harness.registry.getThreadIdByConversationUrl(conversationUrl),
    't-1'
  )

  releaseStop()
  releaseRunner()
  await started.operation.done
  await harness.operations.waitForIdle('t-1')
  assert.equal((await harness.service.close('t-1')).closed, true)
  assert.equal(harness.registry.get('t-1'), null)
})

test('provider page close force-removes a thread after cancellation stays stuck', async () => {
  const stopNever = new Promise<void>(() => {})
  let releaseRunner!: () => void
  const runnerBlocked = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  let closeCalls = 0
  const runtime = createFakeRuntime({
    conversationUrl: 'https://chatgpt.com/c/page-close',
    stopGeneration: async () => await stopNever,
    close: async () => {
      closeCalls += 1
    },
  })
  const harness = createHarness({ runtime, cancelWaitTimeoutMs: 5 })
  admitThread(harness, runtime)

  const started = harness.service.startSend(
    't-1',
    'input',
    async () => await runnerBlocked
  )
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  assert.equal(
    (await harness.service.close('t-1', 'provider_page_closed')).closed,
    true
  )
  assert.equal(closeCalls, 1)
  assert.equal(harness.manager.getThread('t-1'), null)
  assert.equal(harness.registry.get('t-1'), null)
  assert.equal(
    harness.events.filter((event) => event.type === 'thread.closed').length,
    1
  )

  releaseRunner()
  await started.operation.done
})

test('provider page close retries the logical close after late cancellation settlement', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStopStarted!: () => void
  const stopStarted = new Promise<void>((resolve) => {
    markStopStarted = resolve
  })
  const runtime = createFakeRuntime({
    conversationUrl: 'https://chatgpt.com/c/page-close-late-settle',
    stopGeneration: async () => {
      markStopStarted()
      await blocked
    },
  })
  const harness = createHarness({ runtime, cancelWaitTimeoutMs: 20 })
  admitThread(harness, runtime)
  const started = harness.service.startSend('t-1', 'input', async (signal) => {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    await blocked
  })
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  const closing = harness.service.close('t-1', 'provider_page_closed')
  await stopStarted
  await new Promise<void>((resolve) => setTimeout(resolve, 25))
  release()

  assert.equal((await closing).closed, true)
  assert.equal(harness.manager.getThread('t-1'), null)
  assert.equal(harness.registry.get('t-1'), null)
  await started.operation.done
})

test('cleanup errors still remove the thread and publish one closed event', async () => {
  let closeCalls = 0
  const runtime = createFakeRuntime({
    conversationUrl: 'https://chatgpt.com/c/cleanup-error',
    close: async () => {
      closeCalls += 1
      throw new Error('runtime close failed')
    },
  })
  const harness = createHarness({ runtime })
  admitThread(harness, runtime)

  const results = await Promise.allSettled([
    harness.service.close('t-1'),
    harness.service.close('t-1'),
  ])

  assert.equal(closeCalls, 1)
  assert.equal(harness.manager.getThread('t-1'), null)
  assert.equal(harness.registry.get('t-1'), null)
  assert.equal(
    harness.events.filter((event) => event.type === 'thread.closed').length,
    1
  )
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof ThreadCloseCleanupError)
    }
  }
})

test('resume succeeds with a warning when history loading fails', async () => {
  const conversationUrl = 'https://chatgpt.com/c/history-warning'
  const historyError = 'history endpoint unavailable'
  const runtime = createFakeRuntime({
    conversationUrl,
    loadHistory: async (): Promise<ConversationHistoryResult> => {
      throw new Error(historyError)
    },
  })
  const harness = createHarness({ runtime })

  const result = await harness.service.resume({
    conversationUrl,
    source: 'tui',
    activate: true,
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.history)
  assert.equal(result.history?.complete, false)
  assert.match(result.history?.warning ?? '', new RegExp(historyError))
  assert.ok(result.warnings.some((warning) => warning.includes(historyError)))
  const historyEvent = harness.events.find(
    (
      event
    ): event is Extract<ThreadLifecycleEvent, { type: 'thread.history' }> =>
      event.type === 'thread.history'
  )
  assert.ok(historyEvent)
  assert.match(historyEvent.history.warning ?? '', new RegExp(historyError))
  assert.ok(harness.manager.getThread(result.threadId))

  await harness.service.close(result.threadId)
})

test('startSend can be closed immediately without a closing-to-running transition', async () => {
  const runtime = createFakeRuntime({
    conversationUrl: 'https://chatgpt.com/c/immediate-close',
  })
  const harness = createHarness({ runtime })
  admitThread(harness, runtime)

  const started = harness.service.startSend('t-1', 'input', async () => {})
  assert.equal(started.accepted, true)
  if (!started.accepted) return
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'running')

  const closing = harness.service.close('t-1')
  await assert.doesNotReject(started.operation.done)
  assert.equal((await closing).closed, true)
  assert.equal(harness.registry.get('t-1'), null)
})

test('cancellation owns the registry state until the operation settles', async () => {
  let releaseStop!: () => void
  const stopBlocked = new Promise<void>((resolve) => {
    releaseStop = resolve
  })
  const runtime = createFakeRuntime({
    stopGeneration: async () => await stopBlocked,
  })
  const harness = createHarness({ runtime, cancelWaitTimeoutMs: 100 })
  admitThread(harness, runtime)

  const started = harness.service.startSend('t-1', 'input', async (signal) => {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  const cancelling = harness.service.cancel('t-1')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'cancelling')

  releaseStop()
  assert.equal(await cancelling, true)
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'idle')
  await started.operation.done
})

test('late cancellation settlement restores idle after the bounded wait times out', async () => {
  let releaseRunner!: () => void
  const runnerBlocked = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const runtime = createFakeRuntime()
  const harness = createHarness({ runtime, cancelWaitTimeoutMs: 5 })
  admitThread(harness, runtime)
  const started = harness.service.startSend(
    't-1',
    'input',
    async () => await runnerBlocked
  )
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  assert.equal(await harness.service.cancel('t-1'), true)
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'cancelling')

  releaseRunner()
  await started.operation.done
  await started.operation.settled
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'idle')
})

test('a stale operation handle cannot cancel or reclassify later work', async () => {
  const runtime = createFakeRuntime()
  const harness = createHarness({ runtime })
  admitThread(harness, runtime)
  const first = harness.service.startSend('t-1', 'first', async () => {})
  assert.equal(first.accepted, true)
  if (!first.accepted) return
  await first.operation.done
  await first.operation.settled

  let resolveSecondSignal!: (signal: AbortSignal) => void
  const secondSignalReady = new Promise<AbortSignal>((resolve) => {
    resolveSecondSignal = resolve
  })
  let releaseSecond!: () => void
  const secondBlocked = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const second = harness.service.startSend('t-1', 'second', async (signal) => {
    resolveSecondSignal(signal)
    await secondBlocked
  })
  assert.equal(second.accepted, true)
  if (!second.accepted) return
  const secondSignal = await secondSignalReady

  assert.equal(await first.operation.cancel(), false)
  assert.equal(secondSignal.aborted, false)
  assert.equal(harness.registry.getSnapshot('t-1')?.state, 'running')

  releaseSecond()
  await second.operation.done
  await second.operation.settled
})

test('operation settlement synchronizes a conversation URL assigned during submit', async () => {
  const runtimeOptions = {
    conversationId: 'draft',
    conversationUrl: 'https://chatgpt.com/c/draft',
  }
  const runtime = createFakeRuntime(runtimeOptions)
  const harness = createHarness({ runtime })
  admitThread(harness, runtime)

  const started = harness.service.startSend(
    't-1',
    'create conversation',
    () => {
      runtimeOptions.conversationId = 'created'
      runtimeOptions.conversationUrl = 'https://chatgpt.com/c/created'
      return Promise.reject(new Error('response parsing failed'))
    }
  )
  assert.equal(started.accepted, true)
  if (!started.accepted) return

  await assert.rejects(started.operation.done, /response parsing failed/)
  await started.operation.settled

  const snapshot = harness.registry.getSnapshot('t-1')
  assert.equal(snapshot?.conversationId, 'created')
  assert.equal(snapshot?.conversationUrl, runtimeOptions.conversationUrl)
  assert.equal(
    harness.registry.getThreadIdByConversationUrl(
      runtimeOptions.conversationUrl
    ),
    't-1'
  )
  assert.equal(
    harness.registry.getThreadIdByConversationUrl(
      'https://chatgpt.com/c/draft'
    ),
    null
  )
})
