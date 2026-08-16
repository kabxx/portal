import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  KernelBootstrap,
  PluginBootstrapError,
} from '../../src/bootstrap/kernel-bootstrap.ts'
import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'

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
