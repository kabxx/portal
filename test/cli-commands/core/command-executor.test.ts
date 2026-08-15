import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CommandContribution,
  CommandExecutionContext,
  CommandHandler,
  CommandTraceEvent,
} from '../../../src/cli-commands/core/command-contracts.ts'
import {
  CommandInvocationError,
  CommandResultValidationError,
} from '../../../src/cli-commands/core/command-errors.ts'
import {
  commandContributionSpec,
  commandContributions,
  commandHandlerBindingSpec,
  commandHandlerBindings,
  ResolvedCommandPlan,
} from '../../../src/cli-commands/core/command-plan.ts'
import {
  commandOutputService,
  commandServiceRefs,
  commandThreadService,
  type CommandOutputService,
} from '../../../src/cli-commands/core/command-services.ts'
import {
  CommandRuntime,
  type CommandSessionRuntime,
} from '../../../src/cli-commands/core/command-runtime.ts'
import type { ExtensionModule } from '../../../src/extensions/extension-contracts.ts'
import { ExtensionTestHost } from '../../../src/extensions/extension-test-host.ts'
import { ServiceAccessDeniedError } from '../../../src/extensions/extension-errors.ts'
import {
  extension,
  ManualHookClock,
  testPolicies,
} from '../../extensions/extension-test-fixtures.ts'

test('CommandExecutor grants only declared services and disposes the command scope', async () => {
  const retained: { current: CommandExecutionContext | null } = {
    current: null,
  }
  const messages: string[] = []
  const handler: CommandHandler = async (_invocation, context) => {
    retained.current = context
    const output = await context.services.get(commandOutputService)
    messages.push('executed')
    output.write({ level: 'info', title: 'test', body: 'executed' })
    await assert.rejects(
      context.services.get(commandThreadService),
      ServiceAccessDeniedError
    )
    context.scope.defer('command cleanup', () => {
      messages.push('cleanup')
    })
    return { disposition: 'continue' }
  }
  const runtime = commandRuntime(handler)
  const analysis = runtime.plan.prepare('/test')
  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return

  const result = await runtime.session.execute(analysis.invocation, {
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
  })

  assert.equal(result.disposition, 'continue')
  assert.equal(retained.current?.signal.aborted, true)
  assert.deepEqual(messages, ['executed', 'cleanup'])
  assert.throws(() => retained.current?.scope.defer('late', () => undefined))
  await runtime.host.dispose()
})

test('CommandExecutor strictly finalizes results and isolates async trace rejection', async () => {
  let unhandled = 0
  const listener = () => {
    unhandled += 1
  }
  process.on('unhandledRejection', listener)
  try {
    const handler: CommandHandler = async () => ({
      disposition: 'continue',
      extra: true,
    })
    const runtime = commandRuntime(handler, {
      traceSink: () => Promise.reject(new Error('trace failed')),
    })
    const analysis = runtime.plan.prepare('/test')
    assert.equal(analysis.kind, 'ready')
    if (analysis.kind !== 'ready') return

    await assert.rejects(
      runtime.session.execute(analysis.invocation, {
        signal: new AbortController().signal,
        deadline: Number.POSITIVE_INFINITY,
      }),
      CommandResultValidationError
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(unhandled, 0)
    await runtime.host.dispose()
  } finally {
    process.removeListener('unhandledRejection', listener)
  }
})

test('CommandExecutor enforces deadlines, revokes capabilities, and traces late settlement', async () => {
  const clock = new ManualHookClock()
  const deferred = Promise.withResolvers<{ readonly disposition: 'continue' }>()
  const started = Promise.withResolvers<void>()
  const retained: { current: CommandExecutionContext | null } = {
    current: null,
  }
  const traces: CommandTraceEvent[] = []
  const runtime = commandRuntime(
    async (_invocation, context) => {
      retained.current = context
      started.resolve()
      return await deferred.promise
    },
    { clock, traceSink: (event) => traces.push(event) }
  )
  const analysis = runtime.plan.prepare('/test')
  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return

  const execution = runtime.session.execute(analysis.invocation, {
    signal: new AbortController().signal,
    deadline: 10,
  })
  await started.promise
  clock.advance(10)
  await assert.rejects(execution, /cleanup was incomplete/)
  assert.equal(retained.current?.signal.aborted, true)
  assert.throws(() => retained.current?.scope.defer('late', () => undefined))

  deferred.resolve({ disposition: 'continue' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    traces.some(({ kind }) => kind === 'command.lateSettled'),
    true
  )
  await runtime.host.dispose()
})

test('caller cancellation wins and a late stop result cannot be delivered', async () => {
  const deferred = Promise.withResolvers<{
    readonly disposition: 'request-stop'
  }>()
  const controller = new AbortController()
  const runtime = commandRuntime(async () => await deferred.promise)
  const analysis = runtime.plan.prepare('/test')
  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return

  const execution = runtime.session.execute(analysis.invocation, {
    signal: controller.signal,
    deadline: Number.POSITIVE_INFINITY,
  })
  await Promise.resolve()
  controller.abort(new Error('cancel command'))
  await assert.rejects(execution, /cancel command/)
  deferred.resolve({ disposition: 'request-stop' })
  await Promise.resolve()
  await runtime.host.dispose()
})

test('cleanup determines the final trace outcome', async () => {
  const traces: CommandTraceEvent[] = []
  const runtime = commandRuntime(
    async (_invocation, context) => {
      context.scope.defer('failing cleanup', () => {
        throw new Error('cleanup failed')
      })
      return { disposition: 'continue' }
    },
    { traceSink: (event) => traces.push(event) }
  )
  const analysis = runtime.plan.prepare('/test')
  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return

  await assert.rejects(
    runtime.session.execute(analysis.invocation, {
      signal: new AbortController().signal,
      deadline: Number.POSITIVE_INFINITY,
    }),
    CommandInvocationError
  )
  assert.deepEqual(
    traces.map(({ kind }) => kind),
    ['command.started', 'command.failed']
  )
  await runtime.host.dispose()
})

test('invalid deadline values are rejected before the Handler starts', async () => {
  let calls = 0
  const runtime = commandRuntime(async () => {
    calls += 1
    return { disposition: 'continue' }
  })
  const analysis = runtime.plan.prepare('/test')
  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return

  for (const deadline of [Number.NaN, Number.NEGATIVE_INFINITY, 'later']) {
    await assert.rejects(
      runtime.session.execute(analysis.invocation, {
        signal: new AbortController().signal,
        // Exercise the JavaScript runtime boundary, not only TypeScript callers.
        // @ts-expect-error An untyped caller can pass an invalid deadline.
        deadline,
      }),
      /finite absolute time or positive Infinity/
    )
  }
  assert.equal(calls, 0)
  await runtime.host.dispose()
})

function commandRuntime(
  handler: CommandHandler,
  options: {
    readonly clock?: ManualHookClock
    readonly traceSink?: (event: CommandTraceEvent) => unknown
  } = {}
): {
  readonly host: ExtensionTestHost
  readonly plan: ResolvedCommandPlan
  readonly session: CommandSessionRuntime
} {
  const host = new ExtensionTestHost({
    generation: 'command-test',
    policies: testPolicies,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  for (const ref of commandServiceRefs) host.defineService(ref)
  host.defineContribution(commandContributionSpec)
  host.defineExecutableBinding(commandHandlerBindingSpec)
  const output: CommandOutputService = {
    write: (message) => void outputMessages.push(String(message.body)),
    navigate: () => undefined,
  }
  const outputMessages: string[] = []
  const module: ExtensionModule = {
    register(api) {
      api.provide(commandOutputService, {
        dependencies: [],
        async create() {
          return output
        },
      })
      api.contribute(commandContributions, {
        id: testCommand.id,
        value: testCommand,
        requiredServices: [commandOutputService],
        requiredCapabilities: [],
      })
      api.bind(commandHandlerBindings, {
        id: 'test.command-handler',
        targetId: testCommand.id,
        binding: handler,
      })
    },
  }
  host.register(extension('test.command-owner'), module)
  const graph = host.freeze()
  const runtime = new CommandRuntime(graph, {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.traceSink === undefined
      ? {}
      : { traceSink: options.traceSink }),
  })
  const session = runtime.openSession(host.rootScope, 'test-session')
  return { host, plan: runtime.plan, session }
}

const testCommand: CommandContribution = {
  id: 'test.command',
  primaryName: '/test',
  aliases: [],
  usage: '/test',
  description: 'Test command.',
  routes: [
    {
      id: 'root',
      path: [],
      availability: 'always',
      positionals: [],
      options: [],
      constraints: [],
      help: [],
    },
  ],
}
