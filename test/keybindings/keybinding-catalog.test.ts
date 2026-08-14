import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  KeybindingCatalog,
  shouldReloadKeybindings,
} from '../../src/keybindings/keybinding-catalog.ts'
import { createDefaultKeybindings } from '../../src/keybindings/keybinding-config.ts'

test('watch filename filtering accepts directory rescan events', () => {
  const configPath = path.join('data', 'config.yaml')
  assert.equal(shouldReloadKeybindings(null, configPath), true)
  assert.equal(shouldReloadKeybindings('config.yaml', configPath), true)
  assert.equal(
    shouldReloadKeybindings(Buffer.from('config.yaml'), configPath),
    true
  )
  assert.equal(shouldReloadKeybindings('threads.db', configPath), false)
})

test('catalog watches sparse atomic replacements and keeps last-good bindings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-watch-'))
  const configPath = path.join(root, 'config.yaml')
  const issues: string[] = []
  const catalog = new KeybindingCatalog(
    configPath,
    createDefaultKeybindings('win32'),
    (_level, message) => issues.push(message),
    'win32',
    25
  )
  try {
    catalog.start()
    const temporaryPath = path.join(root, '.config.yaml.tmp')
    await writeFile(
      temporaryPath,
      'keybindings:\n  input.submit: [ctrl+enter]\n',
      'utf8'
    )
    await rename(temporaryPath, configPath)
    await waitFor(
      () => catalog.snapshot().bindings['input.submit'][0] === 'ctrl+enter'
    )

    const revision = catalog.snapshot().revision
    await writeFile(configPath, 'keybindings:\n  input.submit: []\n', 'utf8')
    await waitFor(() => issues.length === 1)
    assert.equal(catalog.snapshot().revision, revision)
  } finally {
    catalog.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('reset removes sparse overrides and preserves unrelated comments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-reset-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultKeybindings()
  try {
    await writeFile(
      configPath,
      '# keep\nmcp:\n  host: localhost\nkeybindings:\n  input.submit: []\n',
      'utf8'
    )
    const catalog = new KeybindingCatalog(configPath, defaults, () => {})
    await catalog.reset()
    assert.deepEqual(catalog.snapshot().bindings, defaults)
    const contents = await readFile(configPath, 'utf8')
    assert.match(contents, /# keep/)
    assert.match(contents, /host: localhost/)
    assert.doesNotMatch(contents, /keybindings:/)
    const beforeNoop = await stat(configPath)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await catalog.reset()
    assert.equal((await stat(configPath)).mtimeMs, beforeNoop.mtimeMs)
    catalog.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('serialized reload and reset recover without a stale snapshot rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-race-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultKeybindings()
  try {
    await writeFile(configPath, 'keybindings:\n  input.submit: []\n', 'utf8')
    const catalog = new KeybindingCatalog(configPath, defaults, () => {})
    const reload = catalog.reload()
    const reset = catalog.reset()
    await assert.rejects(reload)
    await reset
    assert.deepEqual(catalog.snapshot().bindings, defaults)
    catalog.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stop prevents queued watcher work from swapping or warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-stop-'))
  const configPath = path.join(root, 'config.yaml')
  const issues: string[] = []
  try {
    const defaults = createDefaultKeybindings('linux')
    const catalog = new KeybindingCatalog(
      configPath,
      defaults,
      (_level, message) => issues.push(message),
      'linux',
      50
    )
    const revision = catalog.snapshot().revision
    catalog.start()
    await writeFile(configPath, 'invalid: [', 'utf8')
    catalog.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(catalog.snapshot().revision, revision)
    assert.deepEqual(issues, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for keybinding watcher')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
