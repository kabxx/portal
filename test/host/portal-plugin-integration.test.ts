import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PortalHost } from '../../src/host/portal-host.ts'
import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'

async function createPlugin(root: string): Promise<string> {
  const directory = path.join(root, 'installed-plugin')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(
      {
        id: 'test.portal-plugin',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'index.mjs',
        dependencies: [],
        contributions: [],
        capabilities: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    path.join(directory, 'index.mjs'),
    `export const portalPlugin = {
  descriptor: {
    id: 'test.portal-plugin',
    version: '1.0.0',
    dependencies: [],
    capabilities: []
  },
  extension: { register() {} }
};
`,
    'utf8'
  )
  return directory
}

test('PortalHost consumes installed direct-load packages through the unified catalog', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-host-plugin-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const pluginDirectory = await createPlugin(root)
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.addLocalDirectory(pluginDirectory)

  const preparedHost = await PortalHost.prepare({
    profile: 'exec',
    cwd: root,
    dataDirectory: root,
  })
  host = preparedHost
  assert.deepEqual(
    preparedHost.prepared.pluginPlan.extensions.map(
      (extension) => extension.packageId
    ),
    ['test.portal-plugin']
  )
  assert.equal(preparedHost.prepared.pluginPlan.snapshot.packages.length, 1)
})
