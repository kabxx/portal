import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createContributionRef,
  createExecutableBindingRef,
  createHookRef,
  createServiceRef,
  type ContributionSpec,
  type ExecutableBindingSpec,
  type HookHandlerRegistration,
  type ObserveHookSpec,
  type RuntimeSchema,
} from '../../src/extensions/extension-contracts.ts'
import {
  AsyncExtensionRegistrationError,
  CapabilityNotGrantedError,
  DuplicateContributionIdError,
  DuplicateExecutableBindingIdError,
  DuplicateExtensionIdError,
  ExtensionRegistrationError,
  ExtensionResolutionError,
  ExecutableBindingValidationError,
  GraphResolutionError,
  RegistryFrozenError,
  ServiceAccessDeniedError,
  ServiceActivationError,
  ExtensionCapabilityExpiredError,
} from '../../src/extensions/extension-errors.ts'
import { ServiceContainer } from '../../src/extensions/service-container.ts'
import {
  activationPolicyRef,
  createTestHost,
  extension,
  ManualHookClock,
  objectSchema,
  stringField,
} from './extension-test-fixtures.ts'

interface ItemContribution {
  readonly id: string
  readonly group: string
  readonly label: string
}

const itemsRef = createContributionRef<ItemContribution>({
  id: 'test.items.collect',
  version: 1,
})

const itemSpec: ContributionSpec<ItemContribution> = {
  ref: itemsRef,
  schema: objectSchema((record) => ({
    id: stringField(record, 'id'),
    group: stringField(record, 'group'),
    label: stringField(record, 'label'),
  })),
  identityOf: (value) => value.id,
  conflictKeyOf: (value) => value.group,
  maxPerConflictKey: 'many',
  selection: 'all',
  ordering: 'dependency-edges',
  allowedServices: [],
  allowedCapabilities: [],
}

type TestExecutableBinding = (value: string) => string

const itemBindingRef = createExecutableBindingRef<TestExecutableBinding>({
  id: 'test.item-bindings',
  version: 1,
  kind: 'test-handler',
  targetContribution: itemsRef,
})

const itemBindingSpec: ExecutableBindingSpec<TestExecutableBinding> = {
  ref: itemBindingRef,
  targetContribution: itemsRef,
  cardinality: 'exactly-one-per-target',
  ownership: 'same-owner',
  capture(binding) {
    if (typeof binding !== 'function') {
      throw new TypeError('test binding must be a function')
    }
    return binding
  },
}

test('ExtensionRegistry commits registration atomically and rejects async registration', async () => {
  const host = createTestHost()
  host.defineContribution(itemSpec)

  assert.throws(
    () =>
      host.register(extension('test.broken'), {
        register(api) {
          api.contribute(itemsRef, {
            id: 'test.shared-item',
            value: {
              id: 'test.shared-item',
              group: 'shared',
              label: 'discarded',
            },
            requiredServices: [],
            requiredCapabilities: [],
          })
          throw new Error('registration failed')
        },
      }),
    ExtensionRegistrationError
  )

  host.register(extension('test.good'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.shared-item',
        value: {
          id: 'test.shared-item',
          group: 'shared',
          label: 'committed',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  assert.throws(
    () =>
      host.register(extension('test.async'), {
        register() {
          return Promise.reject(new Error('async registration failed'))
        },
      }),
    AsyncExtensionRegistrationError
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(
    host.contributions(itemsRef).map((item) => item.value.label),
    ['committed']
  )
  await host.dispose()
})

test('Extension registration API expires synchronously and frozen registries reject writes', async () => {
  const host = createTestHost()
  host.defineContribution(itemSpec)
  let lateRegistration:
    Parameters<Parameters<typeof host.register>[1]['register']>[0] | undefined
  host.register(extension('test.owner'), {
    register(api) {
      lateRegistration = api
    },
  })
  assert(lateRegistration !== undefined)
  const expiredApi = lateRegistration
  assert.throws(
    () =>
      expiredApi.contribute(itemsRef, {
        id: 'test.late',
        value: { id: 'test.late', group: 'late', label: 'late' },
        requiredServices: [],
        requiredCapabilities: [],
      }),
    ExtensionRegistrationError
  )
  host.freeze()
  assert.throws(
    () => host.register(extension('test.after-freeze'), { register() {} }),
    RegistryFrozenError
  )
  await host.dispose()
})

test('Executable bindings register transactionally and resolve one-to-one with contributions', async () => {
  const host = createTestHost()
  host.defineContribution(itemSpec)
  host.defineExecutableBinding(itemBindingSpec)

  assert.throws(
    () =>
      host.register(extension('test.failed-binding-owner'), {
        register(api) {
          api.contribute(itemsRef, {
            id: 'test.bound-item',
            value: {
              id: 'test.bound-item',
              group: 'bound',
              label: 'discarded',
            },
            requiredServices: [],
            requiredCapabilities: [],
          })
          api.bind(itemBindingRef, {
            id: 'test.bound-handler',
            targetId: 'test.bound-item',
            binding: (value) => `discarded:${value}`,
          })
          throw new Error('discard binding transaction')
        },
      }),
    ExtensionRegistrationError
  )

  host.register(extension('test.binding-owner'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.bound-item',
        value: {
          id: 'test.bound-item',
          group: 'bound',
          label: 'committed',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(itemBindingRef, {
        id: 'test.bound-handler',
        targetId: 'test.bound-item',
        binding: (value) => `committed:${value}`,
      })
    },
  })

  const [binding] = host.executableBindings(itemBindingRef)
  assert.equal(binding?.owner, 'test.binding-owner')
  assert.equal(binding?.targetId, 'test.bound-item')
  assert.equal(binding?.binding('value'), 'committed:value')
  await host.dispose()
})

test('Executable binding specs enforce runtime ownership and cardinality contracts', async () => {
  for (const invalid of [
    { ...itemBindingSpec, cardinality: 'many' },
    { ...itemBindingSpec, ownership: 'cross-owner' },
    { ...itemBindingSpec, capture: undefined },
  ]) {
    const host = createTestHost()
    host.defineContribution(itemSpec)
    assert.throws(() => {
      // @ts-expect-error Exercise the JavaScript runtime boundary.
      host.defineExecutableBinding(invalid)
    }, ExtensionResolutionError)
    await host.dispose()
  }
})

test('Executable binding resolution rejects missing, duplicate, orphan, and cross-owner bindings', async () => {
  const createBindingHost = () => {
    const host = createTestHost()
    host.defineContribution(itemSpec)
    host.defineExecutableBinding(itemBindingSpec)
    return host
  }
  const contribution = {
    id: 'test.binding-target',
    value: {
      id: 'test.binding-target',
      group: 'binding-target',
      label: 'target',
    },
    requiredServices: [],
    requiredCapabilities: [],
  } as const

  const missingHost = createBindingHost()
  missingHost.register(extension('test.missing-binding'), {
    register(api) {
      api.contribute(itemsRef, contribution)
    },
  })
  assert.throws(() => missingHost.freeze(), ExtensionResolutionError)
  await missingHost.dispose()

  const duplicateHost = createBindingHost()
  duplicateHost.register(extension('test.duplicate-binding'), {
    register(api) {
      api.contribute(itemsRef, contribution)
      api.bind(itemBindingRef, {
        id: 'test.binding-one',
        targetId: contribution.id,
        binding: (value) => value,
      })
      api.bind(itemBindingRef, {
        id: 'test.binding-two',
        targetId: contribution.id,
        binding: (value) => value,
      })
    },
  })
  assert.throws(() => duplicateHost.freeze(), ExtensionResolutionError)
  await duplicateHost.dispose()

  const orphanHost = createBindingHost()
  orphanHost.register(extension('test.orphan-binding'), {
    register(api) {
      api.bind(itemBindingRef, {
        id: 'test.orphan-handler',
        targetId: 'test.missing-target',
        binding: (value) => value,
      })
    },
  })
  assert.throws(() => orphanHost.freeze(), ExecutableBindingValidationError)
  await orphanHost.dispose()

  const ownerHost = createBindingHost()
  ownerHost.register(extension('test.target-owner'), {
    register(api) {
      api.contribute(itemsRef, contribution)
    },
  })
  ownerHost.register(
    extension('test.binding-substitute', {
      dependencies: ['test.target-owner'],
    }),
    {
      register(api) {
        api.bind(itemBindingRef, {
          id: 'test.substitute-handler',
          targetId: contribution.id,
          binding: (value) => value,
        })
      },
    }
  )
  assert.throws(() => ownerHost.freeze(), ExecutableBindingValidationError)
  await ownerHost.dispose()
})

test('Executable binding IDs are global and captured callables cannot be hot-swapped', async () => {
  const host = createTestHost()
  host.defineContribution(itemSpec)
  host.defineExecutableBinding(itemBindingSpec)
  const mutable = {
    execute(value: string) {
      return `captured:${value}`
    },
  }
  host.register(extension('test.first-binding'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.first-bound-item',
        value: {
          id: 'test.first-bound-item',
          group: 'first-bound',
          label: 'first',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(itemBindingRef, {
        id: 'test.shared-binding-id',
        targetId: 'test.first-bound-item',
        binding: mutable.execute.bind(mutable),
      })
    },
  })
  host.register(extension('test.second-binding'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.second-bound-item',
        value: {
          id: 'test.second-bound-item',
          group: 'second-bound',
          label: 'second',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(itemBindingRef, {
        id: 'test.shared-binding-id',
        targetId: 'test.second-bound-item',
        binding: (value) => value,
      })
    },
  })
  assert.throws(() => host.freeze(), DuplicateExecutableBindingIdError)
  await host.dispose()

  const captureHost = createTestHost()
  captureHost.defineContribution(itemSpec)
  captureHost.defineExecutableBinding(itemBindingSpec)
  captureHost.register(extension('test.captured-binding'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.captured-item',
        value: {
          id: 'test.captured-item',
          group: 'captured',
          label: 'captured',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(itemBindingRef, {
        id: 'test.captured-handler',
        targetId: 'test.captured-item',
        binding: mutable.execute.bind(mutable),
      })
    },
  })
  const [captured] = captureHost.executableBindings(itemBindingRef)
  mutable.execute = (value) => `mutated:${value}`
  assert.equal(captured?.binding('value'), 'captured:value')
  await captureHost.dispose()
})

test('Contribution resolution is deterministic across registration order and extension dependencies', async () => {
  const host = createTestHost()
  host.defineContribution(itemSpec)
  host.register(extension('test.dependent', { dependencies: ['test.base'] }), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.dependent-item',
        value: {
          id: 'test.dependent-item',
          group: 'dependent',
          label: 'dependent',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  host.register(extension('test.base'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.base-item',
        value: {
          id: 'test.base-item',
          group: 'base',
          label: 'base',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  host.register(extension('test.ordered'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.first-item',
        value: {
          id: 'test.first-item',
          group: 'first',
          label: 'first',
        },
        requiredServices: [],
        requiredCapabilities: [],
        before: ['test.base-item'],
      })
    },
  })

  assert.deepEqual(
    host.contributions(itemsRef).map((item) => item.id),
    ['test.first-item', 'test.base-item', 'test.dependent-item']
  )
  await host.dispose()
})

test('Contribution resolution rejects duplicate IDs, conflicts, missing targets, and dependency cycles', async () => {
  const duplicateHost = createTestHost()
  duplicateHost.defineContribution(itemSpec)
  for (const owner of ['test.one', 'test.two']) {
    duplicateHost.register(extension(owner), {
      register(api) {
        api.contribute(itemsRef, {
          id: 'test.duplicate',
          value: {
            id: 'test.duplicate',
            group: owner,
            label: owner,
          },
          requiredServices: [],
          requiredCapabilities: [],
        })
      },
    })
  }
  assert.throws(() => duplicateHost.freeze(), DuplicateContributionIdError)
  await duplicateHost.dispose()

  const missingTargetHost = createTestHost()
  missingTargetHost.defineContribution(itemSpec)
  missingTargetHost.register(extension('test.owner'), {
    register(api) {
      api.contribute(itemsRef, {
        id: 'test.item',
        value: { id: 'test.item', group: 'one', label: 'one' },
        requiredServices: [],
        requiredCapabilities: [],
        after: ['test.missing'],
      })
    },
  })
  assert.throws(() => missingTargetHost.freeze(), GraphResolutionError)
  await missingTargetHost.dispose()

  const cycleHost = createTestHost()
  cycleHost.register(extension('test.one', { dependencies: ['test.two'] }), {
    register() {},
  })
  cycleHost.register(extension('test.two', { dependencies: ['test.one'] }), {
    register() {},
  })
  assert.throws(() => cycleHost.freeze(), GraphResolutionError)
  await cycleHost.dispose()
})

test('Extension and capability contracts reject duplicate owners and ungranted requirements', async () => {
  const duplicateHost = createTestHost()
  duplicateHost.register(extension('test.same'), { register() {} })
  assert.throws(
    () => duplicateHost.register(extension('test.same'), { register() {} }),
    DuplicateExtensionIdError
  )
  await duplicateHost.dispose()

  const capabilityRef = createContributionRef<ItemContribution>({
    id: 'test.capability-items.collect',
    version: 1,
  })
  const capabilityHost = createTestHost()
  capabilityHost.defineContribution({
    ...itemSpec,
    ref: capabilityRef,
    allowedCapabilities: ['filesystem.read'],
  })
  capabilityHost.register(extension('test.untrusted'), {
    register(api) {
      api.contribute(capabilityRef, {
        id: 'test.capability-item',
        value: {
          id: 'test.capability-item',
          group: 'capability',
          label: 'capability',
        },
        requiredServices: [],
        requiredCapabilities: ['filesystem.read'],
      })
    },
  })
  assert.throws(() => capabilityHost.freeze(), CapabilityNotGrantedError)
  await capabilityHost.dispose()
})

test('Service factories resolve declared dependencies once and dispose with their scope', async () => {
  const order: string[] = []
  const baseService = createServiceRef<{ readonly value: string }>({
    id: 'test.base-service',
    version: 1,
    scope: 'portal',
  })
  const combinedService = createServiceRef<{ readonly value: string }>({
    id: 'test.combined-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<{ readonly run: string }, void, 'observe'>({
    id: 'test.service-hook',
    version: 1,
    mode: 'observe',
  })
  const hookSpec: ObserveHookSpec<{ readonly run: string }> = {
    ref: hook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: objectSchema((record) => ({
      run: stringField(record, 'run'),
    })),
    policy: activationPolicyRef,
    allowedServices: [combinedService],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  }
  const host = createTestHost()
  host.defineService(baseService)
  host.defineService(combinedService)
  host.defineHook(hookSpec)
  host.register(extension('test.services'), {
    register(api) {
      api.provide(baseService, {
        dependencies: [],
        async create(context) {
          order.push('base-create')
          context.scope.defer('base-cleanup', () => {
            order.push('base-close')
          })
          return { value: 'base' }
        },
      })
      api.provide(combinedService, {
        dependencies: [baseService],
        async create(context) {
          const base = await context.services.get(baseService)
          order.push('combined-create')
          context.scope.defer('combined-cleanup', () => {
            order.push('combined-close')
          })
          return { value: `${base.value}+combined` }
        },
      })
      api.handle(hook, {
        id: 'test.service-handler',
        requiredServices: [combinedService],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          const first = await context.services.get(combinedService)
          const second = await context.services.get(combinedService)
          assert.equal(first, second)
          assert.equal(first.value, 'base+combined')
        },
      })
    },
  })

  await host.invokeObserve(
    hook,
    { run: 'one' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  await host.invokeObserve(
    hook,
    { run: 'two' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  assert.deepEqual(order, ['base-create', 'combined-create'])
  await host.dispose()
  assert.deepEqual(order, [
    'base-create',
    'combined-create',
    'combined-close',
    'base-close',
  ])
})

test('Service access is limited to declared Handler requirements and failed factories roll back', async () => {
  const cleanup: string[] = []
  const hiddenService = createServiceRef<{ readonly value: string }>({
    id: 'test.hidden-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<{ readonly run: string }, void, 'observe'>({
    id: 'test.denied-service-hook',
    version: 1,
    mode: 'observe',
  })
  const host = createTestHost()
  host.defineService(hiddenService)
  host.defineHook({
    ref: hook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: objectSchema((record) => ({
      run: stringField(record, 'run'),
    })),
    policy: activationPolicyRef,
    allowedServices: [hiddenService],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  host.register(extension('test.denied-service'), {
    register(api) {
      api.provide(hiddenService, {
        dependencies: [],
        async create(context) {
          context.scope.defer('failed-factory-cleanup', () => {
            cleanup.push('factory-cleanup')
          })
          throw new Error('factory failed')
        },
      })
      api.handle(hook, {
        id: 'test.denied-service-handler',
        requiredServices: [],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          await context.services.get(hiddenService)
        },
      })
    },
  })
  const operation = host.createScope('portal', 'denied-operation')
  await assert.rejects(
    host.invokeObserve(
      hook,
      { run: 'denied' },
      {
        scopeAccess: 'active',
        scope: operation,
      }
    ),
    (error: unknown) =>
      hasCause(error, (item) => item instanceof ServiceAccessDeniedError)
  )
  assert.equal(operation.resourceScope.state, 'disposed')
  assert.equal(cleanup.length, 0)

  const failingHook = createHookRef<{ readonly run: string }, void, 'observe'>({
    id: 'test.failing-service-hook',
    version: 1,
    mode: 'observe',
  })
  const failingHost = createTestHost()
  failingHost.defineService(hiddenService)
  failingHost.defineHook({
    ref: failingHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: objectSchema((record) => ({
      run: stringField(record, 'run'),
    })),
    policy: activationPolicyRef,
    allowedServices: [hiddenService],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  failingHost.register(extension('test.failing-service'), {
    register(api) {
      api.provide(hiddenService, {
        dependencies: [],
        async create(context) {
          context.scope.defer('failed-factory-cleanup', () => {
            cleanup.push('factory-cleanup')
          })
          throw new Error('factory failed')
        },
      })
      api.handle(failingHook, {
        id: 'test.failing-service-handler',
        requiredServices: [hiddenService],
        requiredCapabilities: [],
        async handler(_input, context) {
          assert.equal(context.scopeAccess, 'active')
          await context.services.get(hiddenService)
        },
      })
    },
  })
  await assert.rejects(
    failingHost.invokeObserve(
      failingHook,
      { run: 'fail' },
      {
        scopeAccess: 'active',
        scope: failingHost.createScope('portal', 'failed-operation'),
      }
    ),
    (error: unknown) =>
      hasCause(error, (item) => item instanceof ServiceActivationError)
  )
  assert.deepEqual(cleanup, ['factory-cleanup'])
  await Promise.all([host.dispose(), failingHost.dispose()])
})

test('Service resolution rejects scope inversion and service dependency cycles', async () => {
  const portalService = createServiceRef<object>({
    id: 'test.portal-service',
    version: 1,
    scope: 'portal',
  })
  const threadService = createServiceRef<object>({
    id: 'test.thread-service',
    version: 1,
    scope: 'thread',
  })
  const inversionHost = createTestHost()
  inversionHost.defineService(portalService)
  inversionHost.defineService(threadService)
  inversionHost.register(extension('test.inversion'), {
    register(api) {
      api.provide(threadService, {
        dependencies: [],
        async create() {
          return {}
        },
      })
      api.provide(portalService, {
        dependencies: [threadService],
        async create() {
          return {}
        },
      })
    },
  })
  assert.throws(() => inversionHost.freeze(), ExtensionResolutionError)
  await inversionHost.dispose()

  const first = createServiceRef<object>({
    id: 'test.cycle-first',
    version: 1,
    scope: 'portal',
  })
  const second = createServiceRef<object>({
    id: 'test.cycle-second',
    version: 1,
    scope: 'portal',
  })
  const cycleHost = createTestHost()
  cycleHost.defineService(first)
  cycleHost.defineService(second)
  cycleHost.register(extension('test.service-cycle'), {
    register(api) {
      api.provide(first, {
        dependencies: [second],
        async create() {
          return {}
        },
      })
      api.provide(second, {
        dependencies: [first],
        async create() {
          return {}
        },
      })
    },
  })
  assert.throws(() => cycleHost.freeze(), GraphResolutionError)
  await cycleHost.dispose()
})

test('freeze captures factory, Handler, and schema methods against later object mutation', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.captured-service',
    version: 1,
    scope: 'portal',
  })
  const hook = createHookRef<{ readonly run: string }, void, 'observe'>({
    id: 'test.captured-hook',
    version: 1,
    mode: 'observe',
  })
  const schema: RuntimeSchema<{ readonly run: string }> = objectSchema(
    (record) => ({ run: stringField(record, 'run') })
  )
  const calls: string[] = []
  const factory = {
    dependencies: [] as const,
    async create() {
      calls.push('original-factory')
      return { value: 'original' }
    },
  }
  const registration = {
    id: 'test.captured-handler',
    requiredServices: [service],
    requiredCapabilities: [],
    async handler(_input, context) {
      assert.equal(context.scopeAccess, 'active')
      calls.push((await context.services.get(service)).value)
      calls.push('original-handler')
    },
  } satisfies HookHandlerRegistration<{ readonly run: string }, void>
  const host = createTestHost()
  host.defineService(service)
  host.defineHook({
    ref: hook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema: schema,
    policy: activationPolicyRef,
    allowedServices: [service],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  host.register(extension('test.captured-owner'), {
    register(api) {
      api.provide(service, factory)
      api.handle(hook, registration)
    },
  })
  schema.parse = () => {
    throw new Error('mutated schema')
  }
  factory.create = async () => {
    calls.push('mutated-factory')
    return { value: 'mutated' }
  }
  registration.handler = async () => {
    calls.push('mutated-handler')
  }

  await host.invokeObserve(
    hook,
    { run: 'captured' },
    {
      scopeAccess: 'active',
      scope: host.rootScope,
    }
  )
  assert.deepEqual(calls, ['original-factory', 'original', 'original-handler'])
  const provider = host.freeze().servicePlan.providers.get(service.key)
  assert(provider !== undefined)
  assert.equal(Object.isFrozen(provider), true)
  await host.dispose()
})

test('ServiceAccessor rejects cached instances after its resource scope closes', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.closed-scope-service',
    version: 1,
    scope: 'portal',
  })
  const host = createTestHost()
  host.defineService(service)
  host.register(extension('test.closed-scope-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create() {
          return { value: 'available' }
        },
      })
    },
  })
  const graph = host.freeze()
  const accessor = new ServiceContainer(graph.servicePlan).createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
  })
  assert.equal((await accessor.get(service)).value, 'available')
  await host.dispose()
  await assert.rejects(accessor.get(service), ExtensionCapabilityExpiredError)
})

test('Service activation rollback observes the caller deadline', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.rollback-deadline-service',
    version: 1,
    scope: 'portal',
  })
  const release = Promise.withResolvers<void>()
  const host = createTestHost()
  host.defineService(service)
  host.register(extension('test.rollback-deadline-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create(context) {
          context.scope.defer('hanging rollback', async () => {
            await release.promise
          })
          throw new Error('activation failed')
        },
      })
    },
  })
  const graph = host.freeze()
  const accessor = new ServiceContainer(graph.servicePlan).createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Date.now() + 50,
  })
  const startedAt = Date.now()
  await assert.rejects(accessor.get(service), ServiceActivationError)
  assert(
    Date.now() - startedAt < 500,
    'Service rollback exceeded its caller deadline.'
  )
  release.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
})

test('Service rollback uses the injected clock instead of wall time', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.manual-rollback-service',
    version: 1,
    scope: 'portal',
  })
  const clock = new ManualHookClock()
  const disposerStarted = Promise.withResolvers<void>()
  const releaseDisposer = Promise.withResolvers<void>()
  const host = createTestHost({ clock })
  host.defineService(service)
  host.register(extension('test.manual-rollback-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create(context) {
          context.scope.defer('manual clock rollback', async () => {
            disposerStarted.resolve()
            await releaseDisposer.promise
          })
          throw new Error('activation failed')
        },
      })
    },
  })
  const graph = host.freeze()
  const accessor = new ServiceContainer(graph.servicePlan, {
    clock,
  }).createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: 30,
  })
  const activation = accessor.get(service)
  let settled = false
  void activation.then(
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
  await assert.rejects(activation, ServiceActivationError)
  releaseDisposer.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await host.dispose()
})

test('Service activation that settles after its absolute deadline rolls back', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.synchronous-deadline-service',
    version: 1,
    scope: 'portal',
  })
  let factoryCalls = 0
  let firstFactorySignal: AbortSignal | undefined
  const host = createTestHost()
  host.defineService(service)
  host.register(extension('test.synchronous-deadline-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create(context) {
          factoryCalls += 1
          if (factoryCalls === 1) {
            firstFactorySignal = context.signal
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
          }
          return { value: `call-${factoryCalls}` }
        },
      })
    },
  })
  const graph = host.freeze()
  const services = new ServiceContainer(graph.servicePlan)
  const expiredAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Date.now() + 5,
  })
  await assert.rejects(expiredAccessor.get(service), ServiceActivationError)
  assert(firstFactorySignal !== undefined)
  assert.equal(firstFactorySignal.aborted, true)

  const retryAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
  })
  assert.deepEqual(await retryAccessor.get(service), { value: 'call-2' })
  assert.equal(factoryCalls, 2)
  await host.dispose()
})

test('Service rollback detects prestarted synchronous cleanup crossing its deadline', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.prestarted-synchronous-service',
    version: 1,
    scope: 'portal',
  })
  const host = createTestHost()
  let parentDisposal: Promise<void> | undefined
  host.defineService(service)
  host.register(extension('test.prestarted-synchronous-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create(context) {
          context.scope.defer('blocking prestarted cleanup', () => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
          })
          parentDisposal = host.rootScope.resourceScope.dispose({
            timeoutMs: 200,
          })
          throw new Error('activation failed')
        },
      })
    },
  })
  const graph = host.freeze()
  const accessor = new ServiceContainer(graph.servicePlan).createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Date.now() + 5,
  })

  let error: unknown
  try {
    await accessor.get(service)
  } catch (caught) {
    error = caught
  }
  assert(error instanceof ServiceActivationError)
  const rollbackFailure: unknown = error.cause
  assert(rollbackFailure instanceof AggregateError)
  assert(
    rollbackFailure.errors.some(
      (item) =>
        item instanceof Error &&
        item.message.includes('rollback exceeded its activation deadline')
    )
  )
  assert(parentDisposal !== undefined)
  await parentDisposal
  await host.dispose()
})

test('cached Service activation applies each accessor signal and deadline independently', async () => {
  const pendingService = createServiceRef<{ readonly value: string }>({
    id: 'test.shared-pending-service',
    version: 1,
    scope: 'portal',
  })
  const expiredService = createServiceRef<{ readonly value: string }>({
    id: 'test.expired-request-service',
    version: 1,
    scope: 'portal',
  })
  const factoryStarted = Promise.withResolvers<void>()
  const releaseFactory = Promise.withResolvers<void>()
  let pendingFactoryCalls = 0
  let expiredFactoryCalls = 0
  const host = createTestHost()
  host.defineService(pendingService)
  host.defineService(expiredService)
  host.register(extension('test.shared-pending-owner'), {
    register(api) {
      api.provide(pendingService, {
        dependencies: [],
        async create() {
          pendingFactoryCalls += 1
          factoryStarted.resolve()
          await releaseFactory.promise
          return { value: 'shared' }
        },
      })
      api.provide(expiredService, {
        dependencies: [],
        async create() {
          expiredFactoryCalls += 1
          return { value: 'unexpected' }
        },
      })
    },
  })
  const graph = host.freeze()
  const services = new ServiceContainer(graph.servicePlan)
  const longAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [pendingService],
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
  })
  const sharedActivation = longAccessor.get(pendingService)
  await factoryStarted.promise

  const shortAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [pendingService],
    signal: new AbortController().signal,
    deadline: Date.now() + 30,
  })
  const shortStartedAt = Date.now()
  await assert.rejects(shortAccessor.get(pendingService), /deadline exceeded/)
  assert(Date.now() - shortStartedAt < 500)

  const cancelController = new AbortController()
  const cancelledAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [pendingService],
    signal: cancelController.signal,
    deadline: Number.POSITIVE_INFINITY,
  })
  const cancelledRequest = cancelledAccessor.get(pendingService)
  cancelController.abort(new Error('request cancelled'))
  await assert.rejects(cancelledRequest, /request cancelled/)
  assert.equal(pendingFactoryCalls, 1)

  const expiredAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [expiredService],
    signal: new AbortController().signal,
    deadline: Date.now() - 1,
  })
  await assert.rejects(expiredAccessor.get(expiredService), /deadline exceeded/)
  assert.equal(expiredFactoryCalls, 0)

  releaseFactory.resolve()
  assert.deepEqual(await sharedActivation, { value: 'shared' })
  await host.dispose()
})

test('pending Service dependencies use the shared runtime clock and caller deadline', async () => {
  const dependency = createServiceRef<{ readonly value: string }>({
    id: 'test.pending-clock-dependency',
    version: 1,
    scope: 'portal',
  })
  const dependent = createServiceRef<{ readonly value: string }>({
    id: 'test.pending-clock-dependent',
    version: 1,
    scope: 'portal',
  })
  const clock = new ManualHookClock()
  const dependencyStarted = Promise.withResolvers<void>()
  const releaseDependency = Promise.withResolvers<void>()
  let dependentFactoryCalls = 0
  const host = createTestHost({ clock })
  host.defineService(dependency)
  host.defineService(dependent)
  host.register(extension('test.pending-clock-owner'), {
    register(api) {
      api.provide(dependency, {
        dependencies: [],
        async create() {
          dependencyStarted.resolve()
          await releaseDependency.promise
          return { value: 'dependency' }
        },
      })
      api.provide(dependent, {
        dependencies: [dependency],
        async create() {
          dependentFactoryCalls += 1
          return { value: 'dependent' }
        },
      })
    },
  })
  const graph = host.freeze()
  const services = new ServiceContainer(graph.servicePlan, { clock })
  const dependencyAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [dependency],
    signal: new AbortController().signal,
    deadline: 1000,
  })
  const sharedDependency = dependencyAccessor.get(dependency)
  await dependencyStarted.promise

  const dependentAccessor = services.createAccessor({
    scope: host.rootScope,
    allowedServices: [dependent],
    signal: new AbortController().signal,
    deadline: 50,
  })
  const dependentRequest = dependentAccessor.get(dependent)
  clock.advance(50)
  await assert.rejects(dependentRequest, ServiceActivationError)
  assert.equal(dependentFactoryCalls, 0)

  releaseDependency.resolve()
  assert.deepEqual(await sharedDependency, { value: 'dependency' })
  await host.dispose()
})

test('Service rollback races disposal already started by its parent scope', async () => {
  const service = createServiceRef<{ readonly value: string }>({
    id: 'test.prestarted-rollback-service',
    version: 1,
    scope: 'portal',
  })
  const factoryStarted = Promise.withResolvers<void>()
  const releaseFactory = Promise.withResolvers<void>()
  const disposerStarted = Promise.withResolvers<void>()
  const releaseDisposer = Promise.withResolvers<void>()
  const host = createTestHost()
  host.defineService(service)
  host.register(extension('test.prestarted-rollback-owner'), {
    register(api) {
      api.provide(service, {
        dependencies: [],
        async create(context) {
          context.scope.defer('prestarted hanging rollback', async () => {
            disposerStarted.resolve()
            await releaseDisposer.promise
          })
          factoryStarted.resolve()
          await releaseFactory.promise
          return { value: 'late' }
        },
      })
    },
  })
  const graph = host.freeze()
  const accessor = new ServiceContainer(graph.servicePlan).createAccessor({
    scope: host.rootScope,
    allowedServices: [service],
    signal: new AbortController().signal,
    deadline: Date.now() + 100,
  })
  const activation = accessor.get(service)
  await factoryStarted.promise
  const startedAt = Date.now()
  const parentDisposal = host.rootScope.resourceScope.dispose({
    timeoutMs: 500,
  })
  await disposerStarted.promise
  try {
    await assert.rejects(activation, ServiceActivationError)
    assert(
      Date.now() - startedAt < 300,
      'Service rollback waited for the parent disposal timeout.'
    )
  } finally {
    releaseFactory.resolve()
    releaseDisposer.resolve()
    await parentDisposal
  }
  await host.dispose()
})

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
