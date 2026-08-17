import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  KernelBootstrap,
  PluginBootstrapError,
} from '../../src/bootstrap/kernel-bootstrap.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
  type ExtensionRegistrationApi,
} from '../../src/extensions/extension-contracts.ts'
import { CapabilityNotGrantedError } from '../../src/extensions/extension-errors.ts'
import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'
import type { BuiltInPluginDefinition } from '../../src/bootstrap/kernel-bootstrap.ts'
import type { BuiltInPluginRecord } from '../../src/extensions/plugin-contracts.ts'
import { createTestHost } from './extension-test-fixtures.ts'

interface PluginFixtureOptions {
  readonly dependencies?: readonly {
    readonly id: string
    readonly versionRange: string
  }[]
  readonly apiVersion?: number
  readonly descriptorId?: string
  readonly marker?: string
}

async function createPlugin(
  root: string,
  id: string,
  options: PluginFixtureOptions = {}
): Promise<string> {
  const dependencies = options.dependencies ?? []
  const directory = path.join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(
      {
        id,
        version: '1.0.0',
        apiVersion: options.apiVersion ?? 1,
        entry: 'index.mjs',
        dependencies,
        contributions: [],
        capabilities: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  const markerStatement =
    options.marker === undefined
      ? ''
      : `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(options.marker)}, ${JSON.stringify(`${id}\n`)}, 'utf8');`
  await writeFile(
    path.join(directory, 'index.mjs'),
    `${markerStatement}\nexport const portalPlugin = {\n  descriptor: ${JSON.stringify(
      {
        id: options.descriptorId ?? id,
        version: '1.0.0',
        dependencies: dependencies.map((dependency) => dependency.id),
        capabilities: [],
      }
    )},\n  extension: { register() {} }\n};\n`,
    'utf8'
  )
  return directory
}

test('KernelBootstrap validates every record before direct-loading plugins in dependency order', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-kernel-bootstrap-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const marker = path.join(root, 'load-order.txt')
  const base = await createPlugin(root, 'test.base', { marker })
  const dependent = await createPlugin(root, 'test.dependent', {
    marker,
    dependencies: [{ id: 'test.base', versionRange: '^1.0.0' }],
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.addLocalDirectories([dependent, base])

  const plan = await new KernelBootstrap({ manager }).prepare()
  assert.deepEqual(
    plan.extensions.map((extension) => extension.packageId),
    ['test.base', 'test.dependent']
  )
  assert.equal(await readFile(marker, 'utf8'), 'test.base\ntest.dependent\n')
  assert.equal(plan.extensions[0]?.descriptor.id, 'test.base')
})

test('KernelBootstrap executes no plugin code when graph validation fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-kernel-no-exec-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const marker = path.join(root, 'executed.txt')
  const plugin = await createPlugin(root, 'test.unsupported', {
    apiVersion: 2,
    marker,
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
    supportedApiVersion: 1,
  })
  await manager.addLocalDirectory(plugin)

  await assert.rejects(
    new KernelBootstrap({ manager }).prepare(),
    (error: unknown) =>
      error instanceof PluginBootstrapError &&
      error.diagnostics.some(
        (diagnostic) => diagnostic.code === 'api-version-unsupported'
      )
  )
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' })
})

test('KernelBootstrap rejects a loaded descriptor that differs from its manifest', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-kernel-descriptor-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const plugin = await createPlugin(root, 'test.expected', {
    descriptorId: 'test.impersonated',
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.addLocalDirectory(plugin)

  await assert.rejects(
    new KernelBootstrap({ manager }).prepare(),
    /descriptor does not match manifest/
  )
})

test('KernelBootstrap does not instantiate a disabled bundled plugin', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-kernel-builtin-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const manifest = Object.freeze({
    id: 'test.bundled',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'built-in',
    dependencies: Object.freeze([]),
    contributions: Object.freeze([]),
    capabilities: Object.freeze([]),
  })
  const record: BuiltInPluginRecord = Object.freeze({
    manifest,
    source: Object.freeze({
      kind: 'built-in',
      locator: 'portal:built-in/test.bundled',
      digest: '0'.repeat(64),
    }),
    trust: Object.freeze({
      capabilities: Object.freeze([]),
      updatePolicy: 'pinned',
      capabilityExpansion: 'deny',
    }),
    disabledContributions: Object.freeze([]),
  })
  let loadCalls = 0
  const definition: BuiltInPluginDefinition = Object.freeze({
    record,
    load: async () => {
      loadCalls += 1
      return {
        packageId: manifest.id,
        descriptor: {
          id: manifest.id,
          version: manifest.version,
          dependencies: [],
          capabilities: [],
        },
        module: { register() {} },
      }
    },
  })

  await manager.synchronizeBuiltIns([record])
  await manager.disable(manifest.id)
  const plan = await new KernelBootstrap({
    manager,
    builtIns: [definition],
  }).prepare()

  assert.equal(loadCalls, 0)
  assert.deepEqual(plan.extensions, [])
  assert.equal((await manager.inspect(manifest.id))?.enabled, false)
})

test('KernelBootstrap applies persisted capability grants to graph enforcement', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-kernel-grants-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const contributionRef = createContributionRef<{ readonly id: string }>({
    id: 'test.granted-items.collect',
    version: 1,
  })
  const manifest = Object.freeze({
    id: 'test.partial-grant',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'built-in',
    dependencies: Object.freeze([]),
    contributions: Object.freeze([
      Object.freeze({
        point: contributionRef.id,
        id: 'test.restricted-item',
        version: contributionRef.version,
      }),
    ]),
    capabilities: Object.freeze(['portal.allowed', 'portal.restricted']),
  })
  const record: BuiltInPluginRecord = Object.freeze({
    manifest,
    source: Object.freeze({
      kind: 'built-in',
      locator: 'portal:built-in/test.partial-grant',
      digest: '1'.repeat(64),
    }),
    trust: Object.freeze({
      capabilities: Object.freeze(['portal.allowed']),
      updatePolicy: 'pinned',
      capabilityExpansion: 'deny',
    }),
    disabledContributions: Object.freeze([]),
  })
  const definition: BuiltInPluginDefinition = Object.freeze({
    record,
    load: async () => ({
      packageId: manifest.id,
      descriptor: {
        id: manifest.id,
        version: manifest.version,
        dependencies: [],
        capabilities: manifest.capabilities,
      },
      module: {
        register(api: ExtensionRegistrationApi) {
          api.contribute(contributionRef, {
            id: 'test.restricted-item',
            value: { id: 'test.restricted-item' },
            requiredServices: [],
            requiredCapabilities: ['portal.restricted'],
          })
        },
      },
    }),
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const plan = await new KernelBootstrap({
    manager,
    builtIns: [definition],
  }).prepare()
  assert.deepEqual(plan.extensions[0]?.descriptor.capabilities, [
    'portal.allowed',
  ])

  const host = createTestHost()
  host.defineContribution({
    ref: contributionRef,
    schema: {
      parse(value) {
        if (
          value === null ||
          typeof value !== 'object' ||
          !('id' in value) ||
          typeof value.id !== 'string'
        ) {
          throw new TypeError('Expected an item with a string ID.')
        }
        return { id: value.id }
      },
    },
    identityOf: (value) => value.id,
    conflictKeyOf: (value) => value.id,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'none',
    allowedServices: [],
    allowedCapabilities: ['portal.restricted'],
  })
  const [registration] = plan.extensions
  assert.ok(registration)
  host.register(registration.descriptor, registration.module)
  assert.throws(() => host.freeze(), CapabilityNotGrantedError)
  await host.dispose()
})

test('KernelBootstrap filters a disabled contribution and its executable binding', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-kernel-contribution-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const contributionRef = createContributionRef<{ readonly id: string }>({
    id: 'test.filter-items.collect',
    version: 1,
  })
  const bindingRef = createExecutableBindingRef<() => string>({
    id: 'test.filter-items.bind',
    version: 1,
    kind: 'test-filter',
  })
  const contributionId = 'test.filtered-item'
  const declaration = Object.freeze({
    point: contributionRef.id,
    id: contributionId,
    version: contributionRef.version,
  })
  const manifest = Object.freeze({
    id: 'test.contribution-filter',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'built-in',
    dependencies: Object.freeze([]),
    contributions: Object.freeze([declaration]),
    capabilities: Object.freeze([]),
  })
  const record: BuiltInPluginRecord = Object.freeze({
    manifest,
    source: Object.freeze({
      kind: 'built-in',
      locator: 'portal:built-in/test.contribution-filter',
      digest: '2'.repeat(64),
    }),
    trust: Object.freeze({
      capabilities: Object.freeze([]),
      updatePolicy: 'pinned',
      capabilityExpansion: 'deny',
    }),
    disabledContributions: Object.freeze([]),
  })
  const definition: BuiltInPluginDefinition = Object.freeze({
    record,
    load: async () => ({
      packageId: manifest.id,
      descriptor: {
        id: manifest.id,
        version: manifest.version,
        dependencies: [],
        capabilities: [],
      },
      module: {
        register(api: ExtensionRegistrationApi) {
          api.contribute(contributionRef, {
            id: contributionId,
            value: { id: contributionId },
            requiredServices: [],
            requiredCapabilities: [],
          })
          api.bind(bindingRef, {
            id: 'test.filtered-item.binding',
            targetId: contributionId,
            binding: () => 'filtered',
          })
        },
      },
    }),
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.synchronizeBuiltIns([record])
  await manager.setContributionEnabled(
    manifest.id,
    declaration.point,
    declaration.id,
    false
  )
  const plan = await new KernelBootstrap({
    manager,
    builtIns: [definition],
  }).prepare()
  const forwarded = { contributions: 0, bindings: 0 }
  const api: ExtensionRegistrationApi = {
    provide() {},
    contribute() {
      forwarded.contributions += 1
    },
    bind() {
      forwarded.bindings += 1
    },
    handle() {},
  }
  plan.extensions[0]!.module.register(api)

  assert.deepEqual(forwarded, { contributions: 0, bindings: 0 })
})
