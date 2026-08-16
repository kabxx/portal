import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import { runPluginsCli } from '../../src/bootstrap/plugins-command.ts'
import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'

class TextBuffer {
  public value = ''

  public write(text: string): void {
    this.value += text
  }
}

async function createPlugin(
  root: string,
  id: string,
  dependencies: readonly {
    readonly id: string
    readonly versionRange: string
  }[] = []
): Promise<string> {
  const directory = path.join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(
      {
        id,
        version: '1.0.0',
        apiVersion: 1,
        entry: 'index.js',
        dependencies,
        contributions: [],
        capabilities: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    path.join(directory, 'index.js'),
    'export default {}\n',
    'utf8'
  )
  return directory
}

test('plugins recovery CLI manages records without loading the plugin graph', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-plugins-cli-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const base = await createPlugin(root, 'test.base')
  const dependent = await createPlugin(root, 'test.dependent', [
    { id: 'test.base', versionRange: '^1.0.0' },
  ])
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'state', 'plugins.json')),
  })
  const output = new TextBuffer()
  const errorOutput = new TextBuffer()

  assert.equal(
    await runPluginsCli(['add', base, dependent], {
      manager,
      output,
      errorOutput,
    }),
    0
  )
  assert.match(output.value, /Installed test\.base@1\.0\.0/)
  assert.match(output.value, /Installed test\.dependent@1\.0\.0/)

  output.value = ''
  assert.equal(
    await runPluginsCli(['disable', 'test.base'], {
      manager,
      output,
      errorOutput,
    }),
    0
  )
  output.value = ''
  assert.equal(
    await runPluginsCli(['diagnose'], { manager, output, errorOutput }),
    0
  )
  assert.match(output.value, /test\.dependent \[disabled-dependency\]/)

  output.value = ''
  assert.equal(
    await runPluginsCli(['--json', 'list'], { manager, output, errorOutput }),
    0
  )
  const listed = z
    .array(z.object({ manifest: z.object({ id: z.string() }) }))
    .parse(JSON.parse(output.value))
  assert.deepEqual(
    listed.map((record) => record.manifest.id),
    ['test.base', 'test.dependent']
  )
  assert.equal(errorOutput.value, '')
})

test('plugins CLI reports operation and syntax failures with distinct exit codes', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-plugins-cli-errors-')
  )
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins.json')),
  })
  const output = new TextBuffer()
  const errorOutput = new TextBuffer()

  assert.equal(
    await runPluginsCli(['enable', 'missing.plugin'], {
      manager,
      output,
      errorOutput,
    }),
    1
  )
  assert.match(errorOutput.value, /not installed/)
  assert.equal(
    await runPluginsCli(['unknown'], { manager, output, errorOutput }),
    2
  )
})
