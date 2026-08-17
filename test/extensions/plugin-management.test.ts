import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PluginManifestError,
  parsePluginManifest,
} from '../../src/extensions/plugin-manifest.ts'
import {
  digestDirectory,
  PluginManager,
  PluginManagerError,
} from '../../src/extensions/plugin-manager.ts'
import {
  JsonPluginStore,
  PluginStoreError,
} from '../../src/extensions/plugin-store.ts'
import { firstPartyPluginRecords } from '../../src/bootstrap/first-party-plugins.ts'
import type {
  BuiltInPluginRecord,
  PluginContributionDeclaration,
} from '../../src/extensions/plugin-contracts.ts'

function manifest(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    version: '1.2.3',
    apiVersion: 1,
    entry: 'index.js',
    dependencies: [],
    contributions: [],
    capabilities: [],
    ...overrides,
  }
}

async function createPlugin(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const directory = path.join(root, id.replaceAll('.', '-'))
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(manifest(id, overrides), null, 2)}\n`,
    'utf8'
  )
  await writeFile(
    path.join(directory, 'index.js'),
    'export default {}\n',
    'utf8'
  )
  return directory
}

test('plugin manifests are strictly validated and semver checked', () => {
  const parsed = parsePluginManifest(
    manifest('test.manifest', {
      version: '2.0.0',
      dependencies: [{ id: 'test.base', versionRange: '^1.0.0' }],
      contributions: [
        {
          point: 'test.commands',
          id: 'test.command',
          version: 1,
          dependencies: [
            {
              packageId: 'test.base',
              point: 'test.commands',
              id: 'test.base-command',
              version: 1,
            },
          ],
        },
      ],
    })
  )

  assert.equal(parsed.version, '2.0.0')
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.dependencies), true)

  assert.throws(
    () =>
      parsePluginManifest(
        manifest('test.missing-package-dependency', {
          contributions: [
            {
              point: 'test.commands',
              id: 'test.command',
              version: 1,
              dependencies: [
                {
                  packageId: 'test.undeclared',
                  point: 'test.commands',
                  id: 'test.target',
                  version: 1,
                },
              ],
            },
          ],
        })
      ),
    /requires package dependency test\.undeclared/
  )

  assert.throws(
    () =>
      parsePluginManifest({ ...manifest('test.unknown'), unexpected: true }),
    PluginManifestError
  )
  assert.throws(
    () =>
      parsePluginManifest(manifest('test.bad-version', { version: 'latest' })),
    /semantic version/
  )
  assert.throws(
    () =>
      parsePluginManifest(manifest('test.bad-entry', { entry: '../index.js' })),
    /traversal/
  )
  assert.throws(
    () =>
      parsePluginManifest(
        manifest('test.duplicate', {
          capabilities: ['portal.read', 'portal.read'],
        })
      ),
    /duplicates/
  )
})

test('plugin manager commits local installation and detects source tampering', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugin-management-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const packageDirectory = await createPlugin(root, 'test.base')
  const store = new JsonPluginStore(path.join(root, 'state', 'plugins.json'))
  const manager = new PluginManager({
    store,
    clock: () => Date.UTC(2026, 0, 2),
  })

  const record = await manager.addLocalDirectory(packageDirectory)
  assert.equal(record.manifest.id, 'test.base')
  assert.equal((await manager.list()).length, 1)
  assert.equal((await manager.resolveEnabled()).packages.length, 1)

  await writeFile(
    path.join(packageDirectory, 'payload.txt'),
    'tampered\n',
    'utf8'
  )
  const diagnostics = await manager.diagnose()
  assert.deepEqual(
    diagnostics.map((item) => item.code),
    ['digest-mismatch']
  )
  assert.equal((await manager.resolveEnabled()).packages.length, 0)
})

test('disabled damaged plugins remain diagnosable without blocking startup resolution', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugin-disabled-damaged-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const packageDirectory = await createPlugin(root, 'test.damaged')
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.addLocalDirectory(packageDirectory)
  await writeFile(path.join(packageDirectory, 'index.js'), 'tampered\n', 'utf8')

  assert.equal(await manager.disable('test.damaged'), true)
  assert.deepEqual(
    (await manager.diagnose()).map(({ code }) => code),
    ['digest-mismatch']
  )
  const resolved = await manager.resolveEnabled()
  assert.deepEqual(resolved.packages, [])
  assert.deepEqual(resolved.diagnostics, [])
})

test('plugin digest includes executable content under data directories', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugin-data-digest-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const packageDirectory = await createPlugin(root, 'test.data-digest')
  const dataDirectory = path.join(packageDirectory, 'data')
  await mkdir(dataDirectory)
  await writeFile(
    path.join(dataDirectory, 'code.js'),
    'export const value = 1\n',
    'utf8'
  )
  const before = await digestDirectory(packageDirectory)
  await writeFile(
    path.join(dataDirectory, 'code.js'),
    'export const value = 2\n',
    'utf8'
  )
  const after = await digestDirectory(packageDirectory)

  assert.notEqual(after, before)
})

test('plugin installation validates dependency closure, versions, and cycles atomically', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugin-resolution-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const baseDirectory = await createPlugin(root, 'test.base', {
    version: '1.4.0',
  })
  const dependentDirectory = await createPlugin(root, 'test.dependent', {
    dependencies: [{ id: 'test.base', versionRange: '^1.0.0' }],
  })
  const cycleADirectory = await createPlugin(root, 'test.cycle-a', {
    dependencies: [{ id: 'test.cycle-b', versionRange: '*' }],
  })
  const cycleBDirectory = await createPlugin(root, 'test.cycle-b', {
    dependencies: [{ id: 'test.cycle-a', versionRange: '*' }],
  })

  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await assert.rejects(
    manager.addLocalDirectory(dependentDirectory),
    /missing plugin/
  )
  assert.equal((await manager.list()).length, 0)
  await manager.addLocalDirectories([baseDirectory, dependentDirectory])
  await assert.rejects(
    manager.addLocalDirectories([cycleADirectory, cycleBDirectory]),
    /dependency cycle/
  )

  const resolved = await manager.resolveEnabled()
  assert.deepEqual(
    resolved.packages.map((item) => item.manifest.id),
    ['test.base', 'test.dependent']
  )
  assert.deepEqual(resolved.diagnostics, [])
  assert.equal((await manager.list()).length, 2)
})

test('plugin removal rejects installed dependents and preserves the store', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugin-remove-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const baseDirectory = await createPlugin(root, 'test.base')
  const dependentDirectory = await createPlugin(root, 'test.dependent', {
    dependencies: [{ id: 'test.base', versionRange: '^1.0.0' }],
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.addLocalDirectories([baseDirectory, dependentDirectory])

  await assert.rejects(
    manager.remove('test.base'),
    /required by installed plugin\(s\): test\.dependent/
  )
  assert.deepEqual(
    (await manager.list()).map(({ manifest: record }) => record.id),
    ['test.base', 'test.dependent']
  )
  assert.equal(await manager.remove('test.dependent'), true)
  assert.equal(await manager.remove('test.base'), true)
  assert.equal(await manager.remove('test.missing'), false)
})

test('every plugin manifest declares one direct-load entry module', () => {
  const withoutEntry = manifest('test.no-entry')
  delete withoutEntry.entry
  assert.throws(() => parsePluginManifest(withoutEntry), /entry/)
})

test('plugin update preserves trust and requires explicit capability expansion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugin-update-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const packageDirectory = await createPlugin(root, 'test.update', {
    version: '1.0.0',
    capabilities: ['portal.read'],
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
    clock: () => Date.UTC(2026, 0, 2),
  })
  await manager.addLocalDirectory(packageDirectory)

  await writeFile(
    path.join(packageDirectory, 'portal.plugin.json'),
    `${JSON.stringify(
      manifest('test.update', {
        version: '2.0.0',
        capabilities: ['portal.read', 'portal.write'],
      }),
      null,
      2
    )}\n`,
    'utf8'
  )
  await assert.rejects(
    manager.updateLocalDirectory('test.update'),
    /new capabilities/
  )
  const updated = await manager.updateLocalDirectory('test.update', {
    allowCapabilityExpansion: true,
  })
  assert.equal(updated?.manifest.version, '2.0.0')
  assert.deepEqual(updated?.trust.capabilities, ['portal.read', 'portal.write'])

  await writeFile(
    path.join(packageDirectory, 'portal.plugin.json'),
    `${JSON.stringify(
      manifest('test.update', {
        version: '1.0.0',
        capabilities: ['portal.read', 'portal.write'],
      }),
      null,
      2
    )}\n`,
    'utf8'
  )
  await assert.rejects(
    manager.updateLocalDirectory('test.update'),
    /cannot downgrade/
  )
})

test('plugin store writes atomically and rejects malformed records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugin-store-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const storePath = path.join(root, 'nested', 'plugins.json')
  const store = new JsonPluginStore(storePath)
  assert.deepEqual(await store.read(), [])
  await store.replace([])
  assert.match(await readFile(storePath, 'utf8'), /"schemaVersion": 1/)

  await writeFile(
    storePath,
    JSON.stringify({ schemaVersion: 1, packages: [{ invalid: true }] }),
    'utf8'
  )
  await assert.rejects(store.read(), PluginStoreError)
})

test('plugin store repair preserves malformed input and restores an empty store', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugin-store-repair-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const storePath = path.join(root, 'plugins.json')
  const malformed = '{"schemaVersion":1,"packages":['
  await writeFile(storePath, malformed, 'utf8')
  const manager = new PluginManager({ store: new JsonPluginStore(storePath) })

  assert.deepEqual(
    (await manager.diagnose()).map(({ packageId, code }) => ({
      packageId,
      code,
    })),
    [{ packageId: '<store>', code: 'invalid-record' }]
  )
  const repaired = await manager.repairStore()
  assert.notEqual(repaired.backupPath, null)
  assert.equal(await readFile(repaired.backupPath!, 'utf8'), malformed)
  assert.deepEqual(await manager.list(), [])
  assert.match(await readFile(storePath, 'utf8'), /"packages": \[\]/)
})

test('plugin digest rejects symlinked package roots and entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugin-digest-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))

  const packageDirectory = await createPlugin(root, 'test.symlink')
  const target = path.join(root, 'outside.txt')
  await writeFile(target, 'outside\n', 'utf8')
  try {
    await symlink(target, path.join(packageDirectory, 'linked.txt'), 'file')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      t.skip('Creating symbolic links is not permitted on this Windows host.')
      return
    }
    throw error
  }
  await assert.rejects(digestDirectory(packageDirectory), PluginManagerError)
})

test('disabling a bundled dependency removes its dependents from the effective graph', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugin-cascade-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())

  assert.equal(await manager.disable('portal.commands'), true)
  const resolved = await manager.resolveEnabled()
  const ids = resolved.packages.map(({ manifest }) => manifest.id)
  assert.equal(ids.includes('portal.commands'), false)
  assert.equal(ids.includes('portal.tool.run-command'), false)
  assert.equal(ids.includes('portal.tool.apply-patch'), true)
  assert.equal(
    resolved.diagnostics.some(
      ({ packageId, code }) =>
        packageId === 'portal.tool.run-command' &&
        code === 'disabled-dependency'
    ),
    true
  )
})

test('contribution disablement cascades without mutating persisted selections and restores on enable', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-contribution-cascade-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())

  await manager.setContributionEnabled(
    'portal.agent.default',
    'agents.collect',
    'portal.agent.default',
    false
  )
  const disabled = await manager.resolveEnabled()
  for (const [packageId, point, contributionId] of [
    ['portal.agent.default', 'agents.collect', 'portal.agent.default'],
    ['portal.tool.spawn', 'tools.collect', 'portal.tool.spawn'],
    ['portal.surface.exec', 'surfaces.collect', 'portal.exec'],
  ] as const) {
    const record = disabled.packages.find(
      ({ manifest: packageManifest }) => packageManifest.id === packageId
    )
    assert.equal(
      record?.disabledContributions.some(
        ({ point: disabledPoint, id }) =>
          disabledPoint === point && id === contributionId
      ),
      true
    )
  }
  assert.deepEqual(
    (await manager.inspect('portal.surface.exec'))?.disabledContributions,
    []
  )

  await manager.setContributionEnabled(
    'portal.agent.default',
    'agents.collect',
    'portal.agent.default',
    true
  )
  const restored = await manager.resolveEnabled()
  assert.deepEqual(
    restored.packages.find(
      ({ manifest: packageManifest }) =>
        packageManifest.id === 'portal.surface.exec'
    )?.disabledContributions,
    []
  )
})

test('missing and cyclic contribution dependencies are diagnosed and disabled', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-contribution-invalid-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const missing = builtInRecord('test.contribution.missing', [
    contributionDeclaration('test.items', 'test.source', [
      {
        packageId: 'test.contribution.missing',
        point: 'test.items',
        id: 'test.target',
        version: 1,
      },
    ]),
  ])
  const cycle = builtInRecord('test.contribution.cycle', [
    contributionDeclaration('test.items', 'test.a', [
      {
        packageId: 'test.contribution.cycle',
        point: 'test.items',
        id: 'test.b',
        version: 1,
      },
    ]),
    contributionDeclaration('test.items', 'test.b', [
      {
        packageId: 'test.contribution.cycle',
        point: 'test.items',
        id: 'test.a',
        version: 1,
      },
    ]),
  ])
  await manager.synchronizeBuiltIns([missing, cycle])

  const resolved = await manager.resolveEnabled()
  assert.equal(
    resolved.diagnostics.some(
      ({ code }) => code === 'missing-contribution-dependency'
    ),
    true
  )
  assert.equal(
    resolved.diagnostics.filter(
      ({ code }) => code === 'contribution-dependency-cycle'
    ).length,
    2
  )
  assert.deepEqual(
    resolved.packages.flatMap(({ disabledContributions }) =>
      disabledContributions.map(({ id }) => id)
    ),
    ['test.source', 'test.a', 'test.b']
  )
  const diagnosed = await manager.diagnose()
  assert.equal(
    diagnosed.some(({ code }) => code === 'missing-contribution-dependency'),
    true
  )
  assert.equal(
    diagnosed.filter(({ code }) => code === 'contribution-dependency-cycle')
      .length,
    2
  )
})

function builtInRecord(
  id: string,
  contributions: readonly PluginContributionDeclaration[]
): BuiltInPluginRecord {
  return Object.freeze({
    manifest: Object.freeze({
      id,
      version: '1.0.0',
      apiVersion: 1,
      entry: 'built-in',
      dependencies: Object.freeze([]),
      contributions: Object.freeze([...contributions]),
      capabilities: Object.freeze([]),
    }),
    source: Object.freeze({
      kind: 'built-in' as const,
      locator: `portal:built-in/${id}`,
      digest: 'a'.repeat(64),
    }),
    trust: Object.freeze({
      capabilities: Object.freeze([]),
      updatePolicy: 'pinned' as const,
      capabilityExpansion: 'deny' as const,
    }),
    disabledContributions: Object.freeze([]),
  })
}

function contributionDeclaration(
  point: string,
  id: string,
  dependencies: PluginContributionDeclaration['dependencies']
): PluginContributionDeclaration {
  return Object.freeze({ point, id, version: 1, dependencies })
}
