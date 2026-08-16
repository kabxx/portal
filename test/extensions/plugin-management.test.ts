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
        { point: 'test.commands', id: 'test.command', version: 1 },
      ],
    })
  )

  assert.equal(parsed.version, '2.0.0')
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.dependencies), true)

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
