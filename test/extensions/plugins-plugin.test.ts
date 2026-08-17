import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'
import { createBuiltinCommandTestRuntime } from '../helpers/builtin-command-runtime.ts'

test('/plugins manages local packages through the typed service', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugins-command-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const base = await createPlugin(root, 'test.base')
  const dependent = await createPlugin(root, 'test.dependent', {
    dependencies: [{ id: 'test.base', versionRange: '^1.0.0' }],
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const runtime = createBuiltinCommandTestRuntime({ plugins: manager })
  t.after(async () => await runtime.close())

  await runtime.execute(`/plugins add "${base}" "${dependent}"`)
  assert.deepEqual(runtime.messages.at(-1)?.body, [
    'Installed test.base@1.0.0 for the next Portal generation.',
    'Installed test.dependent@1.0.0 for the next Portal generation.',
  ])
  await runtime.execute('/plugins diagnose')
  assert.equal(
    runtime.messages.at(-1)?.body,
    'Plugin store and installed packages are healthy.'
  )

  await writePluginManifest(base, 'test.base', { version: '1.1.0' })
  await runtime.execute('/plugins update test.base')
  assert.equal(
    runtime.messages.at(-1)?.body,
    'Updated test.base@1.1.0 for the next Portal generation.'
  )
  await assert.rejects(
    runtime.execute('/plugins remove test.base'),
    /required by installed plugin\(s\): test\.dependent/
  )
  await runtime.execute('/plugins remove test.dependent')
  await runtime.execute('/plugins remove test.base')
  assert.deepEqual(await manager.list(), [])
})

test('/plugins session routes cover package and contribution enablement', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugins-route-command-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const packageDirectory = await createPlugin(root, 'test.routes', {
    contributions: [
      { point: 'test.tools', id: 'test.tool', version: 1, dependencies: [] },
    ],
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const runtime = createBuiltinCommandTestRuntime({ plugins: manager })
  t.after(async () => await runtime.close())

  await runtime.execute(`/plugins add "${packageDirectory}"`)
  const cases: readonly {
    readonly input: string
    readonly check: (body: string | readonly string[] | undefined) => void
  }[] = [
    {
      input: '/plugins list',
      check: (body) => assert.deepEqual(body, ['enabled test.routes@1.0.0']),
    },
    {
      input: '/plugins inspect test.routes',
      check: (body) =>
        assert.deepEqual(body, [
          'test.routes@1.0.0',
          'Status: enabled',
          'Disabled contributions: (none)',
        ]),
    },
    {
      input: '/plugins disable test.routes',
      check: (body) =>
        assert.equal(
          body,
          'Plugin change recorded for the next Portal generation.'
        ),
    },
    {
      input: '/plugins enable test.routes',
      check: (body) =>
        assert.equal(
          body,
          'Plugin change recorded for the next Portal generation.'
        ),
    },
    {
      input: '/plugins disable-contribution test.routes test.tools test.tool',
      check: (body) =>
        assert.equal(
          body,
          'Plugin change recorded for the next Portal generation.'
        ),
    },
    {
      input: '/plugins inspect test.routes',
      check: (body) =>
        assert.deepEqual(body, [
          'test.routes@1.0.0',
          'Status: enabled',
          'Disabled contributions: test.tools:test.tool',
        ]),
    },
    {
      input: '/plugins enable-contribution test.routes test.tools test.tool',
      check: (body) =>
        assert.equal(
          body,
          'Plugin change recorded for the next Portal generation.'
        ),
    },
  ]
  for (const { input, check } of cases) {
    await runtime.execute(input)
    check(runtime.messages.at(-1)?.body)
  }
})

async function createPlugin(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const directory = path.join(root, id.replaceAll('.', '-'))
  await mkdir(directory, { recursive: true })
  await writePluginManifest(directory, id, overrides)
  await writeFile(
    path.join(directory, 'index.js'),
    'export default {}\n',
    'utf8'
  )
  return directory
}

async function writePluginManifest(
  directory: string,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const manifest = {
    id,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.js',
    dependencies: [],
    contributions: [],
    capabilities: [],
    ...overrides,
  }
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
}
