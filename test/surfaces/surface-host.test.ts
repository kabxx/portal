import assert from 'node:assert/strict'
import test from 'node:test'

import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ServiceContainer } from '../../src/extensions/service-container.ts'
import { ExtensionResourceScope } from '../../src/extensions/scope-registration.ts'
import type {
  ExtensionDescriptor,
  ExtensionModule,
} from '../../src/extensions/extension-contracts.ts'
import { createServiceRef } from '../../src/extensions/extension-contracts.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { canonicalHookPolicies } from '../../src/extensions/hook-policies.ts'
import {
  defineSurfaceHost,
  surfaceActivationBindings,
  surfaceContributions,
  surfaceFeatureActivationBindings,
  surfaceFeatureContributions,
  type SurfaceHostEvent,
  type SurfaceInstance,
  type SurfaceKernelBinding,
} from '../../src/surfaces/surface-extension.ts'
import { SurfaceHost } from '../../src/surfaces/surface-host.ts'
import type { SurfacePortActions } from '../../src/surfaces/surface-port.ts'
import type { CommandSessionRuntime } from '../../src/cli-commands/core/command-runtime.ts'

const descriptor: ExtensionDescriptor = Object.freeze({
  id: 'test.surface',
  version: '1.0.0',
  dependencies: Object.freeze([]),
  capabilities: Object.freeze([]),
})

test('SurfaceHost resolves, activates, and disposes a same-owner Surface', async () => {
  const activation = deferred<void>()
  const completed = deferred<void>()
  let closeCount = 0
  let observedInput: unknown
  const module: ExtensionModule = {
    register(api) {
      api.contribute(surfaceContributions, {
        id: 'test.surface.tui',
        value: {
          id: 'test.surface.tui',
          label: 'Test TUI',
          kind: 'interactive',
          sessionIntent: 'interactive',
          activationBindingId: 'test.surface.tui.activate',
        },
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceActivationBindings, {
        id: 'test.surface.tui.activate',
        targetId: 'test.surface.tui',
        binding: async (input, context): Promise<SurfaceInstance> => {
          observedInput = input
          assert.equal(context.surfaceId, 'test.surface.tui')
          assert.equal(context.host.generation, 'test-generation')
          activation.resolve()
          return {
            done: completed.promise,
            api: Object.freeze({ kind: 'test-api' }),
            close: async () => {
              closeCount += 1
            },
          }
        },
      })
    },
  }
  const root = new ResourceScope('surface host test')
  const portalScope = new ExtensionResourceScope('portal', 'portal', root)
  const { host } = createHost(portalScope, module)
  host.bindKernel(createKernelBinding())

  assert.deepEqual(
    host.list().map(({ id }) => id),
    ['test.surface.tui']
  )
  assert.equal(host.sessionIntent('test.surface.tui'), 'interactive')
  const surface = await host.activate('test.surface.tui', { answer: 42 })
  await activation.promise
  assert.deepEqual(observedInput, { answer: 42 })
  assert.deepEqual(surface.api, { kind: 'test-api' })
  await surface.close()
  await surface.close()
  assert.equal(closeCount, 1)
  completed.resolve()
  await root.dispose()
})

test('SurfaceHost shares one pending activation for concurrent callers', async () => {
  const release = deferred<void>()
  const done = deferred<void>()
  let activations = 0
  let closes = 0
  const module: ExtensionModule = {
    register(api) {
      api.contribute(surfaceContributions, {
        id: 'test.surface.concurrent',
        value: {
          id: 'test.surface.concurrent',
          label: 'Concurrent Surface',
          kind: 'listener',
          sessionIntent: 'automation',
          activationBindingId: 'test.surface.concurrent.activate',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(surfaceActivationBindings, {
        id: 'test.surface.concurrent.activate',
        targetId: 'test.surface.concurrent',
        binding: async () => {
          activations += 1
          await release.promise
          return {
            done: done.promise,
            close: async () => {
              closes += 1
            },
          }
        },
      })
    },
  }
  const root = new ResourceScope('concurrent surface test')
  const portalScope = new ExtensionResourceScope('portal', 'portal', root)
  const { host } = createHost(portalScope, module)
  host.bindKernel(createKernelBinding())

  const first = host.activate('test.surface.concurrent', null)
  const second = host.activate('test.surface.concurrent', null)
  await Promise.resolve()
  assert.equal(activations, 1)
  release.resolve()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left, right)
  await left.close()
  assert.equal(closes, 1)
  done.resolve()
  await root.dispose()
})

test('SurfaceHost keeps a failed close visible and retryable', async () => {
  let closes = 0
  const module: ExtensionModule = {
    register(api) {
      api.contribute(surfaceContributions, {
        id: 'test.surface.close-failure',
        value: {
          id: 'test.surface.close-failure',
          label: 'Failing Surface',
          kind: 'listener',
          sessionIntent: 'automation',
          activationBindingId: 'test.surface.close-failure.activate',
        },
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(surfaceActivationBindings, {
        id: 'test.surface.close-failure.activate',
        targetId: 'test.surface.close-failure',
        binding: () => ({
          done: new Promise<void>(() => undefined),
          close: () => {
            closes += 1
            if (closes === 1) throw new Error('surface close failed')
          },
        }),
      })
    },
  }
  const root = new ResourceScope('failed surface close test')
  const portalScope = new ExtensionResourceScope('portal', 'portal', root)
  const { host } = createHost(portalScope, module)
  host.bindKernel(createKernelBinding())
  const surface = await host.activate('test.surface.close-failure', null)

  await assert.rejects(surface.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.match(String(error.errors[0]), /surface close failed/)
    return true
  })
  await surface.close()
  assert.equal(closes, 2)
  await root.dispose()
})

test('SurfaceHost rejects unknown Surfaces without executing a binding', async () => {
  const root = new ResourceScope('unknown surface test')
  const portalScope = new ExtensionResourceScope('portal', 'portal', root)
  const { host } = createHost(portalScope)
  host.bindKernel(createKernelBinding())
  await assert.rejects(
    host.activate('missing.surface', null),
    /Unknown or disabled Surface/
  )
  await root.dispose()
})

test('SurfaceHost grants feature services without exposing them to the Surface', async () => {
  const featureService = createServiceRef<{ readonly value: string }>({
    id: 'test.surface.feature-service',
    version: 1,
    scope: 'portal',
  })
  const surfaceModule: ExtensionModule = {
    register(api) {
      api.contribute(surfaceContributions, {
        id: 'test.surface.listener',
        value: {
          id: 'test.surface.listener',
          label: 'Test listener',
          kind: 'listener',
          sessionIntent: 'automation',
          activationBindingId: 'test.surface.listener.activate',
        },
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceActivationBindings, {
        id: 'test.surface.listener.activate',
        targetId: 'test.surface.listener',
        binding: (_input, context) => {
          assert.deepEqual(context.features.list(), [
            {
              id: 'test.surface.listener.feature',
              owner: 'test.surface-feature',
              api: { value: 'granted' },
            },
          ])
          return { done: new Promise(() => {}), close: () => {} }
        },
      })
    },
  }
  const featureModule: ExtensionModule = {
    register(api) {
      api.provide(featureService, {
        dependencies: Object.freeze([]),
        create: async () => Object.freeze({ value: 'granted' }),
      })
      api.contribute(surfaceFeatureContributions, {
        id: 'test.surface.listener.feature',
        value: {
          id: 'test.surface.listener.feature',
          targetSurfaceId: 'test.surface.listener',
          activationBindingId: 'test.surface.listener.feature.activate',
        },
        requiredServices: Object.freeze([featureService]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceFeatureActivationBindings, {
        id: 'test.surface.listener.feature.activate',
        targetId: 'test.surface.listener.feature',
        binding: async (context) => await context.services.get(featureService),
      })
    },
  }
  const root = new ResourceScope('surface feature test')
  const portalScope = new ExtensionResourceScope('portal', 'portal', root)
  const registry = new ExtensionRegistry({
    generation: 'test-generation',
    policies: canonicalHookPolicies,
  })
  registry.defineService(featureService)
  defineSurfaceHost(registry, {
    allowedFeatureServices: Object.freeze([featureService]),
  })
  registry.register(descriptor, surfaceModule)
  registry.register(
    Object.freeze({
      id: 'test.surface-feature',
      version: '1.0.0',
      dependencies: Object.freeze(['test.surface']),
      capabilities: Object.freeze([]),
    }),
    featureModule
  )
  const graph = registry.freeze()
  const host = new SurfaceHost({
    graph,
    parent: portalScope,
    services: new ServiceContainer(graph.servicePlan),
  })
  host.bindKernel(createKernelBinding())
  const surface = await host.activate('test.surface.listener', null)
  await surface.close()
  await root.dispose()
})

function createHost(
  portalScope: ExtensionResourceScope,
  module?: ExtensionModule
): { readonly host: SurfaceHost } {
  const registry = new ExtensionRegistry({
    generation: 'test-generation',
    policies: canonicalHookPolicies,
  })
  defineSurfaceHost(registry)
  if (module !== undefined) registry.register(descriptor, module)
  const graph = registry.freeze()
  const services = new ServiceContainer(graph.servicePlan)
  return {
    host: new SurfaceHost({ graph, parent: portalScope, services }),
  }
}

function createKernelBinding(): SurfaceKernelBinding {
  return {
    // The fake is never called by this contract test.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    port: Object.freeze({}) as SurfacePortActions,
    events: {
      subscribe(_listener: (event: SurfaceHostEvent) => void) {
        return () => {}
      },
    },
    commands: {
      openSession: () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return Object.freeze({}) as unknown as CommandSessionRuntime
      },
      catalog: () => Object.freeze([]),
      completionSnapshot: () => Object.freeze({ entries: Object.freeze([]) }),
      bindPresentation: () => {},
    },
    snapshot: Object.freeze({
      generation: 'test-generation',
      cwd: 'C:/workspace',
      dataDirectory: 'C:/data',
      configPath: 'C:/data/config.yaml',
    }),
    requestStop: () => {},
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
