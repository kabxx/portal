import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'

import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  readPortalKeybindings,
} from '../../src/config/portal-config.ts'
import {
  KeybindingCatalog,
  shouldReloadKeybindings,
} from '../../src/keybindings/keybinding-catalog.ts'
import { createDefaultKeybindings } from '../../src/keybindings/keybinding-config.ts'

type MutablePortalDocument = Record<string, unknown> & {
  keybindings: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePortalDocument(value: string): MutablePortalDocument {
  const document = parseRecord(value)
  const keybindings = document.keybindings
  if (!isRecord(keybindings)) {
    throw new Error('Expected keybindings to be an object.')
  }
  return Object.assign(document, {
    keybindings,
  })
}

function parseRecord(value: string): Record<string, unknown> {
  const document: unknown = parse(value)
  if (!isRecord(document)) {
    throw new Error('Expected the YAML document root to be an object.')
  }
  return document
}

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

test('keybindings-only reads ignore unrelated restart-owned settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-read-'))
  const configPath = path.join(root, 'config.yaml')
  try {
    await writeFile(
      configPath,
      stringify({
        browser: 'invalid until restart',
        keybindings: { 'input.submit': ['ctrl+enter'] },
      }),
      'utf8'
    )
    assert.deepEqual(
      (await readPortalKeybindings(configPath))['input.submit'],
      ['ctrl+enter']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('catalog watches atomic replacements and keeps last-good bindings on errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-watch-'))
  const configPath = path.join(root, 'config.yaml')
  const issues: string[] = []
  let catalog: KeybindingCatalog | null = null
  try {
    const defaults = createDefaultPortalConfig(root)
    await ensurePortalConfig(configPath, defaults)
    catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
      (_level, message) => issues.push(message),
      'win32',
      25
    )
    const activeCatalog = catalog
    activeCatalog.start()

    const document = parsePortalDocument(await readFile(configPath, 'utf8'))
    document.keybindings['input.submit'] = ['ctrl+enter']
    const temporaryPath = path.join(root, '.config.yaml.tmp')
    await writeFile(temporaryPath, stringify(document), 'utf8')
    await rename(temporaryPath, configPath)
    await waitFor(
      () =>
        activeCatalog.snapshot().bindings['input.submit'][0] === 'ctrl+enter'
    )

    const lastGoodRevision = activeCatalog.snapshot().revision
    document.keybindings['input.submit'] = []
    await writeFile(configPath, stringify(document), 'utf8')
    await waitFor(() => issues.length === 1)
    assert.equal(activeCatalog.snapshot().revision, lastGoodRevision)

    await writeFile(configPath, stringify(document), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(issues.length, 1)
  } finally {
    catalog?.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('reset repairs invalid keybindings, preserves comments, and keeps advanced last', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-reset-'))
  const configPath = path.join(root, 'config.yaml')
  try {
    const defaults = createDefaultPortalConfig(root)
    await ensurePortalConfig(configPath, defaults)
    let contents = await readFile(configPath, 'utf8')
    contents = contents
      .replace(
        '# Browser launch and profile settings.',
        '# keep browser comment'
      )
      .replace(/input\.submit:\n(?:\s+-[^\n]*\n)+/, 'input.submit: []\n')
    await writeFile(configPath, contents, 'utf8')

    const catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
      () => {},
      'darwin'
    )
    await catalog.reset()
    const resetContents = await readFile(configPath, 'utf8')
    const resetDocument = parsePortalDocument(resetContents)

    assert.match(resetContents, /# keep browser comment/)
    assert.ok(
      resetContents.indexOf('\nkeybindings:') <
        resetContents.indexOf('\nadvanced:')
    )
    assert.equal(
      resetContents.trimEnd().endsWith('commandOutputLimitMB: 1'),
      true
    )
    assert.deepEqual(
      resetDocument.keybindings,
      createDefaultKeybindings('darwin')
    )
    catalog.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reset restores keybindings immediately before an advanced section moved by the user', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-keybinding-reset-order-')
  )
  const configPath = path.join(root, 'config.yaml')
  try {
    const defaults = createDefaultPortalConfig(root)
    const document = parseRecord(stringify(defaults))
    const advanced = document.advanced
    delete document.advanced
    document.advanced = advanced
    const skills = document.skills
    delete document.skills
    document.skills = skills
    await writeFile(configPath, stringify(document), 'utf8')

    const catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
      () => {}
    )
    await catalog.reset()
    const resetDocument = parseRecord(await readFile(configPath, 'utf8'))

    assert.deepEqual(Object.keys(resetDocument).slice(-2), [
      'keybindings',
      'advanced',
    ])
    catalog.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('serialized reload and reset recover without a stale snapshot rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-keybinding-race-'))
  const configPath = path.join(root, 'config.yaml')
  try {
    const defaults = createDefaultPortalConfig(root)
    await ensurePortalConfig(configPath, defaults)
    const document = parsePortalDocument(await readFile(configPath, 'utf8'))
    document.keybindings['input.submit'] = []
    await writeFile(configPath, stringify(document), 'utf8')
    const catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
      () => {},
      'linux'
    )

    const reload = catalog.reload()
    const reset = catalog.reset()
    await assert.rejects(reload)
    await reset
    assert.deepEqual(
      catalog.snapshot().bindings,
      createDefaultKeybindings('linux')
    )
    catalog.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reset rejects unrelated invalid config without modifying the file', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-keybinding-reset-invalid-')
  )
  const configPath = path.join(root, 'config.yaml')
  try {
    const defaults = createDefaultPortalConfig(root)
    const document = {
      ...defaults,
      browser: { ...defaults.browser, engine: 'firefox' },
    }
    const contents = stringify(document)
    await writeFile(configPath, contents, 'utf8')
    const catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
      () => {}
    )

    await assert.rejects(catalog.reset(), /browser\.engine must be "chromium"/)
    assert.equal(await readFile(configPath, 'utf8'), contents)
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
    const defaults = createDefaultPortalConfig(root)
    await ensurePortalConfig(configPath, defaults)
    const catalog = new KeybindingCatalog(
      configPath,
      defaults.keybindings,
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for keybinding watcher')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
