import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createContributionRef,
  createHookPolicyRef,
  createHookRef,
  createServiceRef,
  type ContributionSpec,
  type Decision,
} from '../../src/extensions/extension-contracts.ts'
import {
  AsyncExtensionRegistrationError,
  ExtensionResolutionError,
  HookPolicyMismatchError,
  UnknownRefError,
} from '../../src/extensions/extension-errors.ts'
import {
  freezeImmutableData,
  UnsupportedImmutableValueError,
} from '../../src/extensions/immutable-data.ts'
import {
  createTestHost,
  extension,
  notificationPolicyRef,
  objectSchema,
  stringField,
  transformPolicyRef,
} from './extension-test-fixtures.ts'

interface Item {
  readonly id: string
  readonly key: string
}

function createItemSpec(options: {
  readonly id: string
  readonly maxPerConflictKey: number | 'many'
  readonly ordering: 'none' | 'dependency-edges'
}): {
  readonly ref: ReturnType<typeof createContributionRef<Item>>
  readonly spec: ContributionSpec<Item>
} {
  const ref = createContributionRef<Item>({ id: options.id, version: 1 })
  return {
    ref,
    spec: {
      ref,
      schema: objectSchema((record) => ({
        id: stringField(record, 'id'),
        key: stringField(record, 'key'),
      })),
      identityOf: (item) => item.id,
      conflictKeyOf: (item) => item.key,
      maxPerConflictKey: options.maxPerConflictKey,
      selection: options.maxPerConflictKey === 1 ? 'single' : 'all',
      ordering: options.ordering,
      allowedServices: [],
      allowedCapabilities: [],
    },
  }
}

test('ContributionSpec enforces conflict cardinality and ordering policy', async () => {
  const cardinality = createItemSpec({
    id: 'test.cardinality.collect',
    maxPerConflictKey: 1,
    ordering: 'dependency-edges',
  })
  const cardinalityHost = createTestHost()
  cardinalityHost.defineContribution(cardinality.spec)
  cardinalityHost.register(extension('test.cardinality-owner'), {
    register(api) {
      for (const id of ['test.cardinality-one', 'test.cardinality-two']) {
        api.contribute(cardinality.ref, {
          id,
          value: { id, key: 'same-key' },
          requiredServices: [],
          requiredCapabilities: [],
        })
      }
    },
  })
  assert.throws(() => cardinalityHost.freeze(), ExtensionResolutionError)
  await cardinalityHost.dispose()

  const unordered = createItemSpec({
    id: 'test.unordered.collect',
    maxPerConflictKey: 'many',
    ordering: 'none',
  })
  const unorderedHost = createTestHost()
  unorderedHost.defineContribution(unordered.spec)
  unorderedHost.register(extension('test.unordered-owner'), {
    register(api) {
      api.contribute(unordered.ref, {
        id: 'test.unordered-item',
        value: { id: 'test.unordered-item', key: 'key' },
        requiredServices: [],
        requiredCapabilities: [],
        before: ['test.other-item'],
      })
    },
  })
  assert.throws(() => unorderedHost.freeze(), ExtensionResolutionError)
  await unorderedHost.dispose()
})

test('explicit contribution selection resolves one candidate per conflict key', async () => {
  const selected = createItemSpec({
    id: 'test.selected.collect',
    maxPerConflictKey: 'many',
    ordering: 'dependency-edges',
  })
  const host = createTestHost({
    contributionSelections: {
      'test.selected.collect': {
        shared: 'test.selected-two',
      },
    },
  })
  host.defineContribution({ ...selected.spec, selection: 'explicit-key' })
  host.register(extension('test.selection-owner'), {
    register(api) {
      for (const id of ['test.selected-one', 'test.selected-two']) {
        api.contribute(selected.ref, {
          id,
          value: { id, key: 'shared' },
          requiredServices: [],
          requiredCapabilities: [],
        })
      }
    },
  })
  assert.deepEqual(
    host.contributions(selected.ref).map((item) => item.id),
    ['test.selected-two']
  )
  await host.dispose()

  const missingSelection = createTestHost()
  missingSelection.defineContribution({
    ...selected.spec,
    selection: 'explicit-key',
  })
  missingSelection.register(extension('test.missing-selection'), {
    register(api) {
      api.contribute(selected.ref, {
        id: 'test.unselected',
        value: { id: 'test.unselected', key: 'shared' },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  assert.throws(() => missingSelection.freeze(), ExtensionResolutionError)
  await missingSelection.dispose()

  const emptySelection = createTestHost({
    contributionSelections: {
      'test.selected.collect': {
        missing: 'test.missing',
      },
    },
  })
  emptySelection.defineContribution({
    ...selected.spec,
    selection: 'explicit-key',
  })
  assert.throws(() => emptySelection.freeze(), ExtensionResolutionError)
  await emptySelection.dispose()
})

test('Contribution schema decodes each registration exactly once', async () => {
  const ref = createContributionRef<Item>({
    id: 'test.single-decode.collect',
    version: 1,
  })
  const baseSchema = objectSchema<Item>((record) => ({
    id: stringField(record, 'id'),
    key: stringField(record, 'key'),
  }))
  let parseCalls = 0
  const host = createTestHost()
  host.defineContribution({
    ref,
    schema: {
      parse(value: unknown): Item {
        parseCalls += 1
        if (parseCalls > 1) throw new Error('schema parsed more than once')
        return baseSchema.parse(value)
      },
    },
    identityOf: (item) => item.id,
    conflictKeyOf: (item) => item.key,
    maxPerConflictKey: 'many',
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: [],
    allowedCapabilities: [],
  })
  host.register(extension('test.single-decode-owner'), {
    register(api) {
      api.contribute(ref, {
        id: 'test.single-decode-item',
        value: { id: 'test.single-decode-item', key: 'shared' },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  assert.deepEqual(
    host.contributions(ref).map((item) => item.id),
    ['test.single-decode-item']
  )
  assert.equal(parseCalls, 1)
  await host.dispose()
})

test('immutable arrays reject decorated structure and freeze standard elements', () => {
  const nested = { value: 'stable' }
  const standard = [nested]
  freezeImmutableData(standard)
  assert.equal(Object.isFrozen(standard), true)
  assert.equal(Object.isFrozen(nested), true)

  const customProperty: unknown[] = []
  Reflect.defineProperty(customProperty, 'extra', {
    value: { mutable: true },
    configurable: true,
  })
  assert.throws(
    () => freezeImmutableData(customProperty),
    UnsupportedImmutableValueError
  )

  const accessor = [0]
  Reflect.defineProperty(accessor, '0', {
    get: () => 1,
    configurable: true,
  })
  assert.throws(
    () => freezeImmutableData(accessor),
    UnsupportedImmutableValueError
  )

  const symbolProperty: unknown[] = []
  Reflect.defineProperty(symbolProperty, Symbol('hidden'), {
    value: { mutable: true },
    configurable: true,
  })
  assert.throws(
    () => freezeImmutableData(symbolProperty),
    UnsupportedImmutableValueError
  )

  const customPrototype: unknown[] = []
  Reflect.setPrototypeOf(customPrototype, {})
  assert.throws(
    () => freezeImmutableData(customPrototype),
    UnsupportedImmutableValueError
  )
})

test('custom thenables are rejected as asynchronous Extension registration', async () => {
  const host = createTestHost()
  assert.throws(
    () =>
      host.register(extension('test.thenable'), {
        register() {
          return { then() {} }
        },
      }),
    AsyncExtensionRegistrationError
  )
  assert.equal(host.freeze().extensions.size, 0)
  await host.dispose()
})

test('HookPlanner rejects unknown policies, invalid mode policies, and terminal services', async () => {
  const inputSchema = objectSchema((record) => ({
    event: stringField(record, 'event'),
  }))
  const unknownPolicyHost = createTestHost()
  const unknownPolicyHook = createHookRef<
    { readonly event: string },
    void,
    'observe'
  >({ id: 'test.unknown-policy', version: 1, mode: 'observe' })
  unknownPolicyHost.defineHook({
    ref: unknownPolicyHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema,
    policy: createHookPolicyRef('test.missing-policy'),
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  assert.throws(() => unknownPolicyHost.freeze(), HookPolicyMismatchError)
  await unknownPolicyHost.dispose()

  const waterfallHost = createTestHost()
  const waterfallHook = createHookRef<
    { readonly event: string },
    { readonly event: string },
    'waterfall'
  >({ id: 'test.invalid-policy-mode', version: 1, mode: 'waterfall' })
  waterfallHost.defineHook({
    ref: waterfallHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema,
    patchSchema: inputSchema,
    applyPatch: (_current, patch) => patch,
    policy: notificationPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  assert.throws(() => waterfallHost.freeze(), ExtensionResolutionError)
  await waterfallHost.dispose()

  const service = createServiceRef<object>({
    id: 'test.terminal-service',
    version: 1,
    scope: 'portal',
  })
  const terminalHost = createTestHost()
  const terminalHook = createHookRef<
    { readonly event: string },
    void,
    'observe'
  >({ id: 'test.invalid-terminal', version: 1, mode: 'observe' })
  terminalHost.defineService(service)
  terminalHost.defineHook({
    ref: terminalHook,
    scope: 'portal',
    scopeAccess: 'terminal',
    inputSchema,
    policy: notificationPolicyRef,
    allowedServices: [service],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  assert.throws(() => terminalHost.freeze(), ExtensionResolutionError)
  await terminalHost.dispose()
})

test('freeze rejects duplicate global Handler IDs and missing Service providers', async () => {
  const firstHook = createHookRef<{ readonly event: string }, void, 'observe'>({
    id: 'test.duplicate-first',
    version: 1,
    mode: 'observe',
  })
  const secondHook = createHookRef<{ readonly event: string }, void, 'observe'>(
    { id: 'test.duplicate-second', version: 1, mode: 'observe' }
  )
  const inputSchema = objectSchema((record) => ({
    event: stringField(record, 'event'),
  }))
  const duplicateHost = createTestHost()
  for (const ref of [firstHook, secondHook]) {
    duplicateHost.defineHook({
      ref,
      scope: 'portal',
      scopeAccess: 'active',
      inputSchema,
      policy: notificationPolicyRef,
      allowedServices: [],
      allowedCapabilities: [],
      redact: () => ({}),
      stability: 'experimental',
    })
  }
  duplicateHost.register(extension('test.duplicate-handlers'), {
    register(api) {
      for (const ref of [firstHook, secondHook]) {
        api.handle(ref, {
          id: 'test.global-handler',
          requiredServices: [],
          requiredCapabilities: [],
          async handler() {},
        })
      }
    },
  })
  assert.throws(() => duplicateHost.freeze(), ExtensionResolutionError)
  await duplicateHost.dispose()

  const missingService = createServiceRef<object>({
    id: 'test.missing-provider',
    version: 1,
    scope: 'portal',
  })
  const serviceHook = createHookRef<
    { readonly event: string },
    void,
    'observe'
  >({ id: 'test.missing-provider-hook', version: 1, mode: 'observe' })
  const serviceHost = createTestHost()
  serviceHost.defineService(missingService)
  serviceHost.defineHook({
    ref: serviceHook,
    scope: 'portal',
    scopeAccess: 'active',
    inputSchema,
    policy: notificationPolicyRef,
    allowedServices: [missingService],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  serviceHost.register(extension('test.missing-provider-owner'), {
    register(api) {
      api.handle(serviceHook, {
        id: 'test.missing-provider-handler',
        requiredServices: [missingService],
        requiredCapabilities: [],
        async handler() {},
      })
    },
  })
  assert.throws(() => serviceHost.freeze(), ExtensionResolutionError)
  await serviceHost.dispose()
})

test('copied Ref keys cannot spoof canonical identity or alter Service scope', async () => {
  const portalService = createServiceRef<object>({
    id: 'test.canonical-service',
    version: 1,
    scope: 'portal',
  })
  const dependentService = createServiceRef<object>({
    id: 'test.canonical-dependent',
    version: 1,
    scope: 'portal',
  })
  const forgedService = Object.freeze({
    ...portalService,
    scope: 'thread' as const,
  })
  const host = createTestHost()
  host.defineService(portalService)
  host.defineService(dependentService)
  host.register(extension('test.ref-forgery'), {
    register(api) {
      api.provide(portalService, {
        dependencies: [],
        async create() {
          return {}
        },
      })
      api.provide(dependentService, {
        dependencies: [forgedService],
        async create() {
          return {}
        },
      })
    },
  })
  assert.throws(() => host.freeze(), UnknownRefError)
  await host.dispose()
})

test('resolved graph exposes read-only map views and immutable contribution data', async () => {
  const items = createItemSpec({
    id: 'test.immutable.collect',
    maxPerConflictKey: 'many',
    ordering: 'none',
  })
  const host = createTestHost()
  host.defineContribution(items.spec)
  host.register(extension('test.immutable-owner'), {
    register(api) {
      api.contribute(items.ref, {
        id: 'test.immutable-item',
        value: { id: 'test.immutable-item', key: 'key' },
        requiredServices: [],
        requiredCapabilities: [],
      })
    },
  })
  const graph = host.freeze()
  assert.equal(Reflect.get(graph.extensions, 'set'), undefined)
  assert.equal(Reflect.get(graph.servicePlan.providers, 'set'), undefined)
  assert.equal(Object.isFrozen(host.contributions(items.ref)[0]!.value), true)
  await host.dispose()
})

test('guard Hook specs require the canonical deny policy', async () => {
  const hook = createHookRef<{ readonly event: string }, Decision, 'guard'>({
    id: 'test.invalid-guard-policy',
    version: 1,
    mode: 'guard',
  })
  const host = createTestHost()
  host.defineHook({
    ref: hook,
    scope: 'command',
    scopeAccess: 'active',
    inputSchema: objectSchema((record) => ({
      event: stringField(record, 'event'),
    })),
    decisionSchema: {
      parse(): Decision {
        return { kind: 'allow' }
      },
    },
    policy: transformPolicyRef,
    allowedServices: [],
    allowedCapabilities: [],
    redact: () => ({}),
    stability: 'experimental',
  })
  assert.throws(() => host.freeze(), ExtensionResolutionError)
  await host.dispose()
})

test('stable IDs accept the camel-case lifecycle names fixed by the Hook Atlas', () => {
  assert.equal(
    createHookRef({
      id: 'portal.beforeStart',
      version: 1,
      mode: 'observe',
    }).id,
    'portal.beforeStart'
  )
  assert.throws(
    () =>
      createContributionRef({
        id: 'Portal.Commands',
        version: 1,
      }),
    /lowercase letters/
  )
})
