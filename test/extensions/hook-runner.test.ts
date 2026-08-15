import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHookRef,
  createServiceRef,
  type ActiveHookInvocationContext,
  type Decision,
  type GuardHookSpec,
  type HookRef,
  type HookTraceEvent,
  type ObserveHookSpec,
  type RuntimeSchema,
  type WaterfallHookSpec,
} from '../../src/extensions/extension-contracts.ts'
import {
  HookInvocationError,
  HookScopeMismatchError,
  HookShutdownAggregateError,
  ExtensionCapabilityExpiredError,
} from '../../src/extensions/extension-errors.ts'
import {
  activationPolicyRef,
  createTestHost,
  extension,
  guardPolicyRef,
  ManualHookClock,
  notificationPolicyRef,
  objectSchema,
  shutdownPolicyRef,
  stringField,
  transformPolicyRef,
} from './extension-test-fixtures.ts'

interface EventInput {
  readonly event: string
}

interface NumberInput {
  readonly value: number
}

interface NumberPatch {
  readonly delta: number
}

const eventSchema = objectSchema<EventInput>((record) => ({
  event: stringField(record, 'event'),
}))

const numberSchema = objectSchema<NumberInput>((record) => {
  const value = record.value
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Expected a finite value.')
  }
  return { value }
})

const numberPatchSchema = objectSchema<NumberPatch>((record) => {
  const delta = record.delta
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    throw new TypeError('Expected a finite delta.')
  }
  return { delta }
})

const decisionSchema: RuntimeSchema<Decision> = {
  parse(value: unknown): Decision {
    if (!isRecord(value)) throw new TypeError('Expected a decision object.')
    if (value.kind === 'allow') return { kind: 'allow' }
    if (
      value.kind === 'deny' &&
      typeof value.code === 'string' &&
      typeof value.message === 'string'
    ) {
      return { kind: 'deny', code: value.code, message: value.message }
    }
    throw new TypeError('Invalid decision.')
  },
}

test('activation observers run serially in resolved order and rollback on failure', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.activation',
    version: 1,
    mode: 'observe',
  })
  const spec: ObserveHookSpec<EventInput> = {
    ref: hook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: eventSchema,
    policy: activationPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: (input) => ({ input: { event: input.event } }),
    stability: 'experimental',
  }
  const order: string[] = []
  const host = createTestHost()
  host.defineHook(spec)
  host.register(extension('test.second', { dependencies: ['test.first'] }), {
    register(api) {
      api.handle(hook, {
        id: 'test.second-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(input, context) {
          order.push('second')
          assert.equal(Object.isFrozen(input), true)
          assert.equal(context.scopeAccess, 'active')
          context.scope.defer('second-resource', () => {
            order.push('second-close')
          })
          throw new Error('activation failed')
        },
      })
    },
  })
  host.register(extension('test.first'), {
    register(api) {
      api.handle(hook, {
        id: 'test.first-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(input) {
          assert.equal(Object.isFrozen(input), true)
          order.push('first')
        },
      })
    },
  })
  const operation = host.createScope('portal', 'activation-operation')
  await assert.rejects(
    host.invokeObserve(
      hook,
      { event: 'start' },
      {
        scopeAccess: 'active',
        scope: operation,
      }
    ),
    HookInvocationError
  )
  assert.deepEqual(order, ['first', 'second', 'second-close'])
  assert.equal(operation.resourceScope.state, 'disposed')
  await host.dispose()
})

test('notification observers start in parallel and isolate failures', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.notification',
    version: 1,
    mode: 'observe',
  })
  const traces: HookTraceEvent[] = []
  const host = createTestHost({ traceSink: (event) => traces.push(event) })
  host.defineHook(observeSpec(hook, notificationPolicyRef, 'active'))
  const release = Promise.withResolvers<void>()
  const started: string[] = []
  host.register(extension('test.notification-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.notification-failure',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          started.push('failure')
          throw new Error('isolated')
        },
      })
      api.handle(hook, {
        id: 'test.notification-waiter',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          started.push('waiter')
          await release.promise
        },
      })
    },
  })

  const invocation = host.invokeObserve(
    hook,
    { event: 'ready' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(started.sort(), ['failure', 'waiter'])
  release.resolve()
  await invocation
  assert.equal(
    traces.some(
      (event) =>
        event.kind === 'handler.failed' &&
        event.handlerId === 'test.notification-failure'
    ),
    true
  )
  assert.equal(
    traces.some(
      (event) =>
        event.kind === 'hook.completed' &&
        event.resultCategory === 'completed_with_isolated_errors'
    ),
    true
  )
  await host.dispose()
})

test('shutdown observers execute every Handler and aggregate errors', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.shutdown',
    version: 1,
    mode: 'observe',
  })
  const order: string[] = []
  const host = createTestHost()
  host.defineHook(observeSpec(hook, shutdownPolicyRef, 'active'))
  host.register(extension('test.shutdown-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.shutdown-first',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          order.push('first')
          throw new Error('first failed')
        },
      })
      api.handle(hook, {
        id: 'test.shutdown-second',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          order.push('second')
          throw new Error('second failed')
        },
      })
      api.handle(hook, {
        id: 'test.shutdown-last',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          order.push('last')
        },
      })
    },
  })

  await assert.rejects(
    host.invokeObserve(
      hook,
      { event: 'stop' },
      {
        scopeAccess: 'active',
        scope: host.rootScope,
      }
    ),
    (error: unknown) =>
      error instanceof HookShutdownAggregateError && error.errors.length === 2
  )
  assert.deepEqual(order, ['first', 'last', 'second'])
  await host.dispose()
})

test('waterfall validates each patch and complete resulting input', async () => {
  const hook = createHookRef<NumberInput, NumberPatch, 'waterfall'>({
    id: 'test.waterfall',
    version: 1,
    mode: 'waterfall',
  })
  const spec: WaterfallHookSpec<NumberInput, NumberPatch> = {
    ref: hook,
    scope: 'turn',
    scopeAccess: 'active',
    inputSchema: numberSchema,
    patchSchema: numberPatchSchema,
    applyPatch: (current, patch) => ({ value: current.value + patch.delta }),
    policy: transformPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: (input, output) => ({
      input: { value: input.value },
      ...(output === undefined ? {} : { output: { delta: output.delta } }),
    }),
    stability: 'experimental',
  }
  const seen: number[] = []
  const host = createTestHost()
  host.defineHook(spec)
  host.register(extension('test.waterfall-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.waterfall-add',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(input) {
          seen.push(input.value)
          return { delta: 2 }
        },
      })
      api.handle(hook, {
        id: 'test.waterfall-double',
        requiredServices: [],
        requiredCapabilities: [],
        after: ['test.waterfall-add'],
        async handler(input) {
          seen.push(input.value)
          return { delta: input.value }
        },
      })
    },
  })
  const turnScope = host.createScope('turn', 'turn-1')
  const result = await host.invokeWaterfall(
    hook,
    { value: 3 },
    {
      scopeAccess: 'active',
      scope: turnScope,
    }
  )
  assert.deepEqual(seen, [3, 5])
  assert.deepEqual(result, { value: 10 })
  assert.equal(Object.isFrozen(result), true)
  await host.dispose()
})

test('waterfall invalid resulting input fails and rolls back the operation scope', async () => {
  const positiveSchema = objectSchema<NumberInput>((record) => {
    const parsed = numberSchema.parse(record)
    if (parsed.value < 0) throw new RangeError('value must be positive')
    return parsed
  })
  const hook = createHookRef<NumberInput, NumberPatch, 'waterfall'>({
    id: 'test.invalid-waterfall',
    version: 1,
    mode: 'waterfall',
  })
  const host = createTestHost()
  host.defineHook({
    ref: hook,
    scope: 'turn',
    scopeAccess: 'active',
    inputSchema: positiveSchema,
    patchSchema: numberPatchSchema,
    applyPatch: (current, patch) => ({ value: current.value + patch.delta }),
    policy: transformPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  host.register(extension('test.invalid-waterfall-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.invalid-waterfall-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          return { delta: -10 }
        },
      })
    },
  })
  const operation = host.createScope('turn', 'invalid-turn')
  await assert.rejects(
    host.invokeWaterfall(
      hook,
      { value: 2 },
      {
        scopeAccess: 'active',
        scope: operation,
      }
    ),
    HookInvocationError
  )
  assert.equal(operation.resourceScope.state, 'disposed')
  await host.dispose()
})

test('guard stops at first deny, traces skipped Handlers, and rolls back', async () => {
  const hook = createHookRef<EventInput, Decision, 'guard'>({
    id: 'test.guard',
    version: 1,
    mode: 'guard',
  })
  const decisionOutputsFrozen: boolean[] = []
  const spec: GuardHookSpec<EventInput> = {
    ref: hook,
    scope: 'command',
    scopeAccess: 'active',
    inputSchema: eventSchema,
    decisionSchema,
    policy: guardPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: (input, output) => {
      if (output !== undefined) {
        decisionOutputsFrozen.push(Object.isFrozen(output))
        Reflect.set(output, 'code', 'mutated')
      }
      return {
        input: { event: input.event },
        ...(output === undefined ? {} : { output: { kind: output.kind } }),
      }
    },
    stability: 'experimental',
  }
  const traces: HookTraceEvent[] = []
  const called: string[] = []
  const host = createTestHost({ traceSink: (event) => traces.push(event) })
  host.defineHook(spec)
  host.register(extension('test.guard-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.guard-allow',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          called.push('allow')
          return { kind: 'allow' }
        },
      })
      api.handle(hook, {
        id: 'test.guard-deny',
        requiredServices: [],
        requiredCapabilities: [],
        after: ['test.guard-allow'],
        async handler() {
          called.push('deny')
          return {
            kind: 'deny' as const,
            code: 'blocked',
            message: 'Blocked.',
          }
        },
      })
      api.handle(hook, {
        id: 'test.guard-never',
        requiredServices: [],
        requiredCapabilities: [],
        after: ['test.guard-deny'],
        async handler() {
          called.push('never')
          return { kind: 'allow' }
        },
      })
    },
  })
  const operation = host.createScope('command', 'command-1')
  const result = await host.invokeGuard(
    hook,
    { event: 'execute' },
    {
      scopeAccess: 'active',
      scope: operation,
    }
  )
  assert.deepEqual(result, {
    kind: 'deny',
    code: 'blocked',
    message: 'Blocked.',
  })
  assert.deepEqual(called, ['allow', 'deny'])
  assert.deepEqual(decisionOutputsFrozen, [true, true])
  assert.equal(operation.resourceScope.state, 'disposed')
  assert.equal(
    traces.some(
      (event) =>
        event.kind === 'handler.skipped' &&
        event.handlerId === 'test.guard-never'
    ),
    true
  )
  await host.dispose()
})

test('guard Handler failures become an explicit deny outcome', async () => {
  const hook = createHookRef<EventInput, Decision, 'guard'>({
    id: 'test.guard-error',
    version: 1,
    mode: 'guard',
  })
  const host = createTestHost()
  host.defineHook({
    ref: hook,
    scope: 'command',
    scopeAccess: 'active',
    inputSchema: eventSchema,
    decisionSchema,
    policy: guardPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  host.register(extension('test.guard-error-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.guard-error-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          throw new Error('guard failed')
        },
      })
    },
  })
  const decision = await host.invokeGuard(
    hook,
    { event: 'execute' },
    {
      scopeAccess: 'active',
      scope: host.createScope('command', 'command-error'),
    }
  )
  assert.equal(decision.kind, 'deny')
  if (decision.kind === 'deny') {
    assert.equal(decision.code, 'hook_handler_error')
  }
  await host.dispose()
})

test('terminal observers receive no active services or resource registration', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.terminal',
    version: 1,
    mode: 'observe',
  })
  const host = createTestHost()
  host.defineHook(observeSpec(hook, notificationPolicyRef, 'terminal'))
  host.register(extension('test.terminal-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.terminal-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'terminal')
          assert.equal(context.scope.kind, 'portal')
          assert.equal('services' in context, false)
          assert.equal('defer' in context.scope, false)
        },
      })
    },
  })
  await host.invokeObserve(
    hook,
    { event: 'stopped' },
    {
      scopeAccess: 'terminal',
      scope: host.terminalScope('portal', 'portal-1', 42),
    }
  )
  await assert.rejects(
    host.invokeObserve(
      hook,
      { event: 'wrong' },
      {
        scopeAccess: 'active',
        scope: host.rootScope,
      }
    ),
    (error: unknown) =>
      hasCause(error, (item) => item instanceof HookScopeMismatchError)
  )
  await host.dispose()
})

test('timeouts abort the Handler signal and trace late settlement without unhandled rejection', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.timeout',
    version: 1,
    mode: 'observe',
  })
  const clock = new ManualHookClock()
  const traces: HookTraceEvent[] = []
  const release = Promise.withResolvers<void>()
  const observed: { signal: AbortSignal | null } = { signal: null }
  const host = createTestHost({
    clock,
    traceSink: (event) => traces.push(event),
  })
  host.defineHook(observeSpec(hook, notificationPolicyRef, 'active'))
  host.register(extension('test.timeout-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.timeout-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          observed.signal = context.signal
          await release.promise
        },
      })
    },
  })
  const invocation = host.invokeObserve(
    hook,
    { event: 'notify' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  await Promise.resolve()
  clock.advance(100)
  await invocation
  const handlerSignal = observed.signal
  assert(handlerSignal !== null)
  assert.equal(handlerSignal.aborted, true)
  assert.equal(
    traces.some((event) => event.kind === 'handler.timedOut'),
    true
  )
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    traces.some(
      (event) =>
        event.kind === 'handler.lateSettled' &&
        event.resultCategory === 'late_fulfilled_after_timeout'
    ),
    true
  )
  await host.dispose()
})

test('Handler deadline includes synchronous started diagnostics', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.started-diagnostics-deadline',
    version: 1,
    mode: 'observe',
  })
  const clock = new ManualHookClock()
  const traces: HookTraceEvent[] = []
  let redactions = 0
  let handlerCalls = 0
  const host = createTestHost({
    clock,
    traceSink: (event) => traces.push(event),
  })
  host.defineHook({
    ...observeSpec(hook, notificationPolicyRef, 'active'),
    redact() {
      redactions += 1
      if (redactions === 2) clock.advance(100)
      return {}
    },
  })
  host.register(extension('test.started-diagnostics-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.started-diagnostics-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          handlerCalls += 1
        },
      })
    },
  })
  await host.invokeObserve(
    hook,
    { event: 'notify' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  assert.equal(handlerCalls, 0)
  assert.equal(
    traces.some((event) => event.kind === 'handler.timedOut'),
    true
  )
  await host.dispose()
})

test('an already-cancelled activation does not invoke its Handler and rolls back', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.cancelled',
    version: 1,
    mode: 'observe',
  })
  let calls = 0
  const host = createTestHost()
  host.defineHook(observeSpec(hook, activationPolicyRef, 'active'))
  host.register(extension('test.cancelled-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.cancelled-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          calls += 1
        },
      })
    },
  })
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const operation = host.createScope('portal', 'cancelled-operation')
  await assert.rejects(
    host.invokeObserve(
      hook,
      { event: 'start' },
      {
        scopeAccess: 'active',
        scope: operation,
        signal: controller.signal,
      }
    ),
    HookInvocationError
  )
  assert.equal(calls, 0)
  assert.equal(operation.resourceScope.state, 'disposed')
  await host.dispose()
})

test('trace redactor and sink failures never alter Hook behavior', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.trace-failure',
    version: 1,
    mode: 'observe',
  })
  const host = createTestHost({
    traceSink() {
      throw new Error('sink failed')
    },
  })
  host.defineHook({
    ...observeSpec(hook, notificationPolicyRef, 'active'),
    redact() {
      throw new Error('redactor failed')
    },
  })
  host.register(extension('test.trace-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.trace-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {},
      })
    },
  })
  await host.invokeObserve(
    hook,
    { event: 'notify' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  await host.dispose()
})

test('asynchronous trace sink rejections are isolated', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.async-trace-failure',
    version: 1,
    mode: 'observe',
  })
  let traceCalls = 0
  const host = createTestHost({
    // Runtime callers can still supply this JavaScript-valid contract violation.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    async traceSink() {
      traceCalls += 1
      throw new Error('async sink failed')
    },
  })
  host.defineHook(observeSpec(hook, notificationPolicyRef, 'active'))
  await host.invokeObserve(
    hook,
    { event: 'notify' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(traceCalls, 2)
  await host.dispose()
})

test('validated patches are frozen before redaction or trace code can observe them', async () => {
  const hook = createHookRef<NumberInput, NumberPatch, 'waterfall'>({
    id: 'test.trace-patch-freeze',
    version: 1,
    mode: 'waterfall',
  })
  let outputWasFrozen = false
  const host = createTestHost({
    traceSink(event) {
      const output = event.data?.output
      if (isRecord(output)) Reflect.set(output, 'delta', 1000)
    },
  })
  host.defineHook({
    ref: hook,
    scope: 'turn',
    scopeAccess: 'active',
    inputSchema: numberSchema,
    patchSchema: numberPatchSchema,
    applyPatch: (current, patch) => ({ value: current.value + patch.delta }),
    policy: transformPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: (
      _input: Readonly<NumberInput>,
      output: NumberPatch | undefined
    ) => {
      if (output !== undefined) {
        outputWasFrozen = Object.isFrozen(output)
        Reflect.set(output, 'delta', 500)
      }
      return { ...(output === undefined ? {} : { output }) }
    },
    stability: 'experimental',
  })
  host.register(extension('test.trace-patch-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.trace-patch-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler() {
          return { delta: 2 }
        },
      })
    },
  })
  const result = await host.invokeWaterfall(
    hook,
    { value: 1 },
    {
      scopeAccess: 'active',
      scope: host.createScope('turn', 'trace-patch-turn'),
    }
  )
  assert.equal(outputWasFrozen, true)
  assert.deepEqual(result, { value: 3 })
  await host.dispose()
})

test('Handler context capabilities expire immediately after settlement', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.expiring-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.expiring-context',
    version: 1,
    mode: 'observe',
  })
  let retainedContext: ActiveHookInvocationContext | undefined
  const host = createTestHost()
  host.defineService(service)
  host.defineHook({
    ...observeSpec(hook, activationPolicyRef, 'active'),
    allowedServices: [service],
  })
  host.register(extension('test.expiring-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create() {
          return { value: 'service' }
        },
      })
      api.handle(hook, {
        id: 'test.expiring-handler',
        requiredServices: [service],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          retainedContext = context
          assert.equal((await context.services.get(service)).value, 'service')
        },
      })
    },
  })
  await host.invokeObserve(
    hook,
    { event: 'start' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  assert(retainedContext !== undefined)
  const settledContext = retainedContext
  assert.equal(settledContext.signal.aborted, true)
  assert.throws(
    () => settledContext.scope.defer('late', () => {}),
    ExtensionCapabilityExpiredError
  )
  await assert.rejects(
    settledContext.services.get(service),
    ExtensionCapabilityExpiredError
  )
  await host.dispose()
})

test('Manual Hook clock is shared with Service activation', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.manual-clock-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.manual-clock-service-hook',
    version: 1,
    mode: 'observe',
  })
  const clock = new ManualHookClock()
  let observedValue: string | undefined
  const host = createTestHost({ clock })
  host.defineService(service)
  host.defineHook({
    ...observeSpec(hook, activationPolicyRef, 'active'),
    allowedServices: [service],
  })
  host.register(extension('test.manual-clock-service-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create() {
          return { value: 'available' }
        },
      })
      api.handle(hook, {
        id: 'test.manual-clock-service-handler',
        requiredServices: [service],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          observedValue = (await context.services.get(service)).value
        },
      })
    },
  })
  await host.invokeObserve(
    hook,
    { event: 'start' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  assert.equal(observedValue, 'available')
  await host.dispose()
})

test('timeout revokes Hook context capabilities before abort listeners run', async () => {
  await verifyAbortListenerCapabilityRevocation('timeout')
})

test('caller cancellation revokes Hook context capabilities before abort listeners run', async () => {
  await verifyAbortListenerCapabilityRevocation('caller')
})

test('Service factory deadline is hard even when factory ignores cancellation', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.hanging-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.hanging-service-hook',
    version: 1,
    mode: 'observe',
  })
  const release = Promise.withResolvers<void>()
  const host = createTestHost()
  host.defineService(service)
  host.defineHook({
    ...observeSpec(hook, activationPolicyRef, 'active'),
    allowedServices: [service],
  })
  host.register(extension('test.hanging-service-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create() {
          await release.promise
          return { value: 'late' }
        },
      })
      api.handle(hook, {
        id: 'test.hanging-service-handler',
        requiredServices: [service],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          await context.services.get(service)
        },
      })
    },
  })
  const operation = host.createScope('portal', 'hanging-service-operation')
  await assert.rejects(
    host.invokeObserve(
      hook,
      { event: 'start' },
      {
        scopeAccess: 'active',
        scope: operation,
        deadline: Date.now() + 20,
      }
    ),
    HookInvocationError
  )
  assert.equal(operation.resourceScope.state, 'disposed')
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
})

test('Hook rollback observes the invocation deadline', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.rollback-deadline',
    version: 1,
    mode: 'observe',
  })
  const release = Promise.withResolvers<void>()
  const host = createTestHost()
  host.defineHook(observeSpec(hook, activationPolicyRef, 'active'))
  host.register(extension('test.rollback-deadline-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.rollback-deadline-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          context.scope.defer('hanging Hook rollback', async () => {
            await release.promise
          })
          throw new Error('start failed')
        },
      })
    },
  })
  const operation = host.createScope('portal', 'rollback-deadline-operation')
  const startedAt = Date.now()
  try {
    await assert.rejects(
      host.invokeObserve(
        hook,
        { event: 'start' },
        {
          scopeAccess: 'active',
          scope: operation,
          deadline: Date.now() + 50,
        }
      ),
      HookInvocationError
    )
    assert(
      Date.now() - startedAt < 500,
      'Hook rollback exceeded its invocation deadline.'
    )
  } finally {
    release.resolve()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
})

test('Hook rollback uses the injected clock instead of wall time', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.manual-rollback-deadline',
    version: 1,
    mode: 'observe',
  })
  const clock = new ManualHookClock()
  const disposerStarted = Promise.withResolvers<void>()
  const releaseDisposer = Promise.withResolvers<void>()
  const host = createTestHost({ clock })
  host.defineHook(observeSpec(hook, activationPolicyRef, 'active'))
  host.register(extension('test.manual-rollback-deadline-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.manual-rollback-deadline-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          context.scope.defer('manual clock Hook rollback', async () => {
            disposerStarted.resolve()
            await releaseDisposer.promise
          })
          throw new Error('start failed')
        },
      })
    },
  })
  const operation = host.createScope(
    'portal',
    'manual-rollback-deadline-operation'
  )
  const invocation = host.invokeObserve(
    hook,
    { event: 'start' },
    {
      scopeAccess: 'active',
      scope: operation,
      deadline: 30,
    }
  )
  let settled = false
  void invocation.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await disposerStarted.promise
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false)
  clock.advance(30)
  await assert.rejects(invocation, HookInvocationError)
  releaseDisposer.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
})

test('Hook rollback detects prestarted synchronous cleanup crossing its deadline', async () => {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: 'test.prestarted-synchronous-rollback',
    version: 1,
    mode: 'observe',
  })
  const host = createTestHost()
  host.defineHook(observeSpec(hook, activationPolicyRef, 'active'))
  const operation = host.createScope(
    'portal',
    'prestarted-synchronous-rollback-operation'
  )
  let prestartedDisposal: Promise<void> | undefined
  host.register(extension('test.prestarted-synchronous-rollback-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.prestarted-synchronous-rollback-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          context.scope.defer('blocking prestarted Hook cleanup', () => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
          })
          prestartedDisposal = operation.resourceScope.dispose({
            timeoutMs: 200,
          })
          throw new Error('start failed')
        },
      })
    },
  })

  let error: unknown
  try {
    await host.invokeObserve(
      hook,
      { event: 'start' },
      {
        scopeAccess: 'active',
        scope: operation,
        deadline: Date.now() + 5,
      }
    )
  } catch (caught) {
    error = caught
  }
  assert(error instanceof HookInvocationError)
  const rollbackFailure: unknown = error.cause
  assert(rollbackFailure instanceof AggregateError)
  assert(
    rollbackFailure.errors.some(
      (item) =>
        item instanceof Error &&
        item.message.includes('rollback exceeded its invocation deadline')
    )
  )
  assert(prestartedDisposal !== undefined)
  await prestartedDisposal
  await host.dispose()
})

test('already shallow-frozen input is recursively frozen before a Handler sees it', async () => {
  interface NestedInput {
    readonly nested: { readonly value: string }
  }
  const hook = createHookRef<NestedInput, void, 'observe'>({
    id: 'test.deep-freeze',
    version: 1,
    mode: 'observe',
  })
  const schema: RuntimeSchema<NestedInput> = {
    parse(value: unknown): NestedInput {
      if (!isRecord(value) || !hasStringValue(value.nested)) {
        throw new TypeError('Expected nested input.')
      }
      return { nested: value.nested }
    },
  }
  const host = createTestHost()
  host.defineHook({
    ref: hook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: schema,
    policy: activationPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  host.register(extension('test.deep-freeze-owner'), {
    register(api) {
      api.handle(hook, {
        id: 'test.deep-freeze-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(input) {
          assert.equal(Object.isFrozen(input), true)
          assert.equal(Object.isFrozen(input.nested), true)
        },
      })
    },
  })
  const nested = { value: 'immutable' }
  const input = Object.freeze({ nested })
  await host.invokeObserve(hook, input, {
    scopeAccess: 'active',
    scope: host.rootScope,
  })
  assert.equal(Object.isFrozen(nested), true)
  await host.dispose()
})

function observeSpec(
  ref: HookRef<EventInput, void, 'observe'>,
  policy: ObserveHookSpec<EventInput>['policy'],
  scopeAccess: 'active' | 'terminal'
): ObserveHookSpec<EventInput> {
  return {
    ref,
    scope: 'portal',
    scopeAccess,
    inputSchema: eventSchema,
    policy,
    allowedServices: [],
    allowedCapabilities: [],
    redact: (input) => ({ input: { event: input.event } }),
    stability: 'experimental',
  }
}

async function verifyAbortListenerCapabilityRevocation(
  trigger: 'timeout' | 'caller'
): Promise<void> {
  const hook = createHookRef<EventInput, void, 'observe'>({
    id: `test.${trigger}-capability-revocation`,
    version: 1,
    mode: 'observe',
  })
  const clock = new ManualHookClock()
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let deferError: unknown
  let acquireAttempt: Promise<unknown> | undefined
  let acquireFactoryCalls = 0
  const host = createTestHost({ clock })
  host.defineHook(observeSpec(hook, notificationPolicyRef, 'active'))
  host.register(extension(`test.${trigger}-capability-owner`), {
    register(api) {
      api.handle(hook, {
        id: `test.${trigger}-capability-handler`,
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          context.signal.addEventListener(
            'abort',
            () => {
              try {
                context.scope.defer('forbidden abort cleanup', () => {})
              } catch (error) {
                deferError = error
              }
              acquireAttempt = context.scope.acquire(
                'forbidden abort acquisition',
                () => {
                  acquireFactoryCalls += 1
                  return {}
                },
                () => {}
              )
              void acquireAttempt.catch(() => undefined)
            },
            { once: true }
          )
          started.resolve()
          await release.promise
        },
      })
    },
  })
  const invocation = host.invokeObserve(
    hook,
    { event: trigger },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
      ...(trigger === 'caller' ? { signal: controller.signal } : {}),
    }
  )
  await started.promise
  if (trigger === 'timeout') {
    clock.advance(100)
  } else {
    controller.abort(new Error('cancelled'))
  }
  await invocation
  assert(deferError instanceof ExtensionCapabilityExpiredError)
  assert(acquireAttempt !== undefined)
  await assert.rejects(acquireAttempt, ExtensionCapabilityExpiredError)
  assert.equal(acquireFactoryCalls, 0)
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
}

function hasCause(
  error: unknown,
  predicate: (error: Error) => boolean
): boolean {
  let current: unknown = error
  while (current instanceof Error) {
    if (predicate(current)) return true
    const cause: unknown = current.cause
    current = cause
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasStringValue(value: unknown): value is { readonly value: string } {
  return isRecord(value) && typeof value.value === 'string'
}
