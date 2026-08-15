import assert from 'node:assert/strict'
import test from 'node:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  parsePortalConfig,
  readPortalConfig,
  readPortalKeybindings,
  resetPortalKeybindings,
  updatePortalConfig,
  withPortalConfigTransaction,
} from '../../src/config/portal-config.ts'
import { parseYamlRecord } from '../helpers/yaml.ts'

test('built-in config fixes implementation settings and uses sparse defaults', () => {
  const root = path.resolve('state')
  const config = createDefaultPortalConfig(root)

  assert.equal(config.browser.engine, 'chromium')
  assert.equal(
    config.browser.profilePath,
    path.join(root, 'profiles', 'chromium')
  )
  assert.equal(config.browser.remoteDebuggingPort, 0)
  assert.deepEqual(config.mcp, { host: '127.0.0.1', port: 8788 })
  assert.equal(config.projectInstructions, false)
})

test('missing and empty config use defaults without creating or rewriting files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-empty-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  try {
    assert.deepEqual(await ensurePortalConfig(configPath, defaults), defaults)
    await assert.rejects(access(configPath), { code: 'ENOENT' })

    await writeFile(configPath, '{}\n', 'utf8')
    const before = await stat(configPath)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(await ensurePortalConfig(configPath, defaults), defaults)
    assert.equal(await readFile(configPath, 'utf8'), '{}\n')
    assert.equal((await stat(configPath)).mtimeMs, before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sparse config resolves defaults and remains byte-for-byte unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-sparse-'))
  const configPath = path.join(root, 'config.yaml')
  const contents = [
    '# keep this comment',
    'browser:',
    '  executablePath: ./browser.exe',
    'projectInstructions: true',
    'mcp:',
    '  port: 9000',
    'keybindings:',
    '  input.submit: [ctrl+enter]',
    '',
  ].join('\n')
  try {
    await writeFile(configPath, contents, 'utf8')
    const config = await ensurePortalConfig(
      configPath,
      createDefaultPortalConfig(root)
    )
    assert.equal(config.browser.executablePath, './browser.exe')
    assert.equal(config.browser.remoteDebuggingPort, 0)
    assert.equal(config.projectInstructions, true)
    assert.equal(config.mcp.host, '127.0.0.1')
    assert.equal(config.mcp.port, 9000)
    assert.deepEqual(config.keybindings['input.submit'], ['ctrl+enter'])
    assert.equal(await readFile(configPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('strict parser rejects unknown and invalid public fields', () => {
  assert.throws(
    () => parsePortalConfig({ advanced: {} }),
    /Unsupported config root fields/
  )
  assert.throws(
    () => parsePortalConfig({ browser: { profilePath: 'elsewhere' } }),
    /Unsupported browser fields/
  )
  assert.throws(
    () => parsePortalConfig({ mcp: { token: 'secret' } }),
    /Unsupported mcp fields/
  )
  assert.throws(
    () => parsePortalConfig({ mcp: { port: 0 } }),
    /mcp\.port must be an integer/
  )
  assert.throws(
    () => parsePortalConfig({ projectInstructions: 'yes' }),
    /projectInstructions must be a boolean/
  )
})

test('file errors report only location, path, and documentation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-error-'))
  const configPath = path.join(root, 'config.yaml')
  const secret = 'never-echo-this-secret'
  const contents = `mcp:\n  host: ${secret}: invalid\n`
  try {
    await writeFile(configPath, contents, 'utf8')
    await assert.rejects(ensurePortalConfig(configPath), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Invalid YAML at line 2, column/)
      assert.match(error.message, new RegExp(escapeRegExp(configPath)))
      assert.match(error.message, /Documentation:/)
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    })
    assert.equal(await readFile(configPath, 'utf8'), contents)

    await writeFile(configPath, 'mcp:\n  port: 0\n', 'utf8')
    await assert.rejects(
      updatePortalConfig(configPath, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /mcp\.port/)
        assert.match(error.message, new RegExp(escapeRegExp(configPath)))
        assert.match(error.message, /Documentation:/)
        return true
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AST updates preserve user comments and untouched formatting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-ast-'))
  const configPath = path.join(root, 'config.yaml')
  try {
    await writeFile(
      configPath,
      [
        '# root comment',
        'mcp:',
        '  # custom host',
        '  host: localhost',
        'keybindings:',
        '  # keep keybinding formatting',
        '  input.submit: [ctrl+enter]',
        '',
      ].join('\n'),
      'utf8'
    )
    await updatePortalConfig(configPath, (config) => {
      config.projectInstructions = true
    })
    const contents = await readFile(configPath, 'utf8')
    assert.match(contents, /# root comment/)
    assert.match(contents, /# custom host\n {2}host: localhost/)
    assert.match(
      contents,
      /# keep keybinding formatting\n {2}input\.submit: \[ ctrl\+enter \]/
    )
    assert.match(contents, /projectInstructions: true/)
    assert.equal(
      (await readPortalConfig(configPath))?.projectInstructions,
      true
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('keybinding reset stores only overrides and removes defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-keys-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root).keybindings
  try {
    const changed = structuredClone(defaults)
    changed['input.submit'] = ['ctrl+enter']
    await resetPortalKeybindings(configPath, changed)
    const raw = parseYamlRecord(await readFile(configPath, 'utf8'))
    assert.deepEqual(raw.keybindings, { 'input.submit': ['ctrl+enter'] })
    assert.deepEqual(
      (await readPortalKeybindings(configPath))['input.submit'],
      ['ctrl+enter']
    )

    await resetPortalKeybindings(configPath, defaults)
    assert.deepEqual(parseYamlRecord(await readFile(configPath, 'utf8')), {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Portal rejects unsupported fields without rewriting or exposing values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-breaking-'))
  const configPath = path.join(root, 'config.yaml')
  const secret = 'never-print-this-value'
  const cases: Array<[string, RegExp]> = [
    ['listeners:\n  mcp:\n    port: 8788\n', /listeners/],
    ['advanced:\n  runtime:\n    spawnDepthLimit: 7\n', /advanced/],
    ['skills:\n  example:\n    directory: ./skill\n', /skills/],
    [
      'mcpServers:\n  private:\n    url: https://example.invalid\n',
      /mcpServers/,
    ],
    ['agentInstructions:\n  codex:\n    global: true\n', /agentInstructions/],
    [`mcp:\n  token: ${secret}\n`, /mcp/],
    [`browser:\n  profilePath: ${secret}\n`, /browser/],
  ]
  try {
    for (const [contents, expected] of cases) {
      await writeFile(configPath, contents, 'utf8')
      await assert.rejects(ensurePortalConfig(configPath), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, expected)
        assert.match(error.message, /Config:/)
        assert.match(error.message, /Documentation:/)
        assert.doesNotMatch(error.message, new RegExp(secret))
        return true
      })
      assert.equal(await readFile(configPath, 'utf8'), contents)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config rejects directory and symbolic-link paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-file-'))
  const directoryPath = path.join(root, 'directory.yaml')
  const targetPath = path.join(root, 'target.yaml')
  const linkPath = path.join(root, 'link.yaml')
  try {
    await mkdir(directoryPath)
    await assert.rejects(
      ensurePortalConfig(directoryPath),
      /Config path must be a regular file/
    )

    await writeFile(targetPath, '{}\n', 'utf8')
    try {
      await symlink(targetPath, linkPath, 'file')
    } catch (error) {
      if (isPermissionError(error)) {
        t.diagnostic('File symlinks are unavailable in this environment')
        return
      }
      throw error
    }
    await assert.rejects(
      ensurePortalConfig(linkPath),
      /Config path must be a regular file/
    )
    assert.equal(await readFile(targetPath, 'utf8'), '{}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config rejects symbolic-link lock directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-lock-dir-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  const lockDirectory = path.join(root, 'data', '.locks')
  const externalDirectory = path.join(root, 'external-locks')
  try {
    await mkdir(path.dirname(lockDirectory), { recursive: true })
    await mkdir(externalDirectory)
    await symlink(
      externalDirectory,
      lockDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await assert.rejects(
      ensurePortalConfig(configPath),
      /Config lock directory path must be a regular directory/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config rejects symbolic-link lock files without changing their targets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-lock-file-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  const lockDirectory = path.join(root, 'data', '.locks')
  const lockPath = path.join(lockDirectory, 'config.lock')
  const targetPath = path.join(root, 'external.lock')
  try {
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(targetPath, 'external lock target', 'utf8')
    const before = await stat(targetPath)
    try {
      await symlink(targetPath, lockPath, 'file')
    } catch (error) {
      if (isPermissionError(error)) {
        t.diagnostic('File symlinks are unavailable in this environment')
        return
      }
      throw error
    }
    await assert.rejects(
      ensurePortalConfig(configPath),
      /Config lock path must be a regular file/
    )
    assert.equal(await readFile(targetPath, 'utf8'), 'external lock target')
    assert.equal((await stat(targetPath)).mode, before.mode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('no-op config updates and keybinding resets preserve bytes and mtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-noop-'))
  const configPath = path.join(root, 'config.yaml')
  const contents = '# keep\nmcp:\n  host: localhost\n'
  try {
    await writeFile(configPath, contents, 'utf8')
    const before = await stat(configPath)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await updatePortalConfig(configPath, () => {})
    await resetPortalKeybindings(
      configPath,
      createDefaultPortalConfig(root).keybindings
    )
    assert.equal(await readFile(configPath, 'utf8'), contents)
    assert.equal((await stat(configPath)).mtimeMs, before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config transactions require explicit completion and serialize updates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-tx-'))
  const configPath = path.join(root, 'config.yaml')
  try {
    await assert.rejects(
      withPortalConfigTransaction(configPath, () => {}),
      /must call commit\(\) or noChange\(\)/
    )
    await withPortalConfigTransaction(configPath, (transaction) =>
      transaction.noChange()
    )
    await Promise.all([
      updatePortalConfig(configPath, (config) => {
        config.mcp.port = 9001
      }),
      updatePortalConfig(configPath, (config) => {
        config.projectInstructions = true
      }),
    ])
    const config = await readPortalConfig(configPath)
    assert.equal(config?.mcp.port, 9001)
    assert.equal(config?.projectInstructions, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  )
}
