import test from 'node:test'
import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  parsePortalConfig,
  PortalConfigError,
  readPortalConfig,
  updatePortalConfig,
} from '../../src/config/portal-config.ts'

test('ensurePortalConfig creates one YAML file with concrete defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-default-'))
  const configPath = path.join(root, 'data', 'config.yaml')

  try {
    const dataDirectory = path.join(root, 'data')
    const defaults = createDefaultPortalConfig(dataDirectory)
    const config = await ensurePortalConfig(configPath, defaults)
    const document = parseYaml(await readFile(configPath, 'utf8'))

    assert.deepEqual(config, defaults)
    assert.deepEqual(document, defaults)
    assert.equal(defaults.browser.name, 'edge')
    assert.equal(path.isAbsolute(defaults.browser.executablePath), true)
    assert.equal(
      defaults.browser.profilePath,
      path.join(dataDirectory, 'profiles', defaults.browser.name)
    )
    assert.equal(defaults.browser.remoteDebuggingPort, 9222)
    assert.deepEqual(defaults.agentInstructions, {
      claude: { global: false, local: true },
      codex: { global: false, local: true },
    })
    assert.deepEqual(defaults.api, {
      host: '127.0.0.1',
      port: 8787,
      token: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readPortalConfig parses YAML and strips a UTF-8 BOM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-read-'))
  const configPath = path.join(root, 'config.yaml')
  const executablePath = path.join(root, 'msedge.exe')
  const profilePath = path.join(root, 'profile')

  try {
    await writeFile(
      configPath,
      [
        '\uFEFFbrowser:',
        '  name: edge',
        `  executablePath: ${JSON.stringify(executablePath)}`,
        `  profilePath: ${JSON.stringify(profilePath)}`,
        '  remoteDebuggingPort: 9222',
        'mcp:',
        '  connectionStrategy: per-thread',
        '  servers: {}',
        'skills: []',
        '',
      ].join('\n'),
      'utf8'
    )

    assert.deepEqual(await readPortalConfig(configPath), {
      browser: {
        name: 'edge',
        executablePath,
        profilePath,
        remoteDebuggingPort: 9222,
      },
      agentInstructions: {
        claude: { global: false, local: true },
        codex: { global: false, local: true },
      },
      api: { host: '127.0.0.1', port: 8787, token: null },
      mcp: { connectionStrategy: 'per-thread', servers: {} },
      skills: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig writes a missing API section into an existing config', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-api-migration-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    const { api: _api, ...legacyConfig } = defaults
    await writeFile(configPath, stringifyYaml(legacyConfig), 'utf8')

    const config = await ensurePortalConfig(configPath, defaults)
    const document = parseYaml(await readFile(configPath, 'utf8'))

    assert.deepEqual(config.api, defaults.api)
    assert.deepEqual(document.api, defaults.api)
    assert.deepEqual(document.browser, defaults.browser)
    assert.deepEqual(document.mcp, defaults.mcp)
    assert.deepEqual(document.skills, defaults.skills)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig completes a partial API section without replacing its values', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-api-partial-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    await writeFile(
      configPath,
      stringifyYaml({ ...defaults, api: { host: 'localhost' } }),
      'utf8'
    )

    await ensurePortalConfig(configPath, defaults)
    const document = parseYaml(await readFile(configPath, 'utf8'))

    assert.deepEqual(document.api, {
      host: 'localhost',
      port: 8787,
      token: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig rejects invalid browser, MCP, and Skill sections', () => {
  const valid = createDefaultPortalConfig()

  assert.equal(
    parsePortalConfig({
      ...valid,
      browser: { ...valid.browser, executablePath: 'relative/msedge.exe' },
    }).browser.executablePath,
    'relative/msedge.exe'
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        browser: { ...valid.browser, executablePath: '' },
      }),
    /browser\.executablePath must be a non-empty string/
  )
  assert.equal(
    parsePortalConfig({
      ...valid,
      browser: { ...valid.browser, profilePath: 'relative/profile' },
    }).browser.profilePath,
    'relative/profile'
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        browser: { ...valid.browser, profilePath: '' },
      }),
    /browser\.profilePath must be a non-empty string/
  )
  assert.throws(
    () => parsePortalConfig({ ...valid, mcp: [] }),
    /mcp must be an object/
  )
  assert.throws(
    () => parsePortalConfig({ ...valid, skills: {} }),
    /skills must be an array/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        agentInstructions: {
          claude: { global: 'yes' },
          codex: { global: false, local: true },
        },
      }),
    /agentInstructions\.claude\.global must be a boolean/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        agentInstructions: {
          claude: { global: false, local: true },
          codex: { local: null },
        },
      }),
    /agentInstructions\.codex\.local must be a boolean/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        agentInstructions: {
          claude: { global: false, local: true, cursor: true },
          codex: { global: false, local: true },
        },
      }),
    /Unsupported agentInstructions\.claude fields: cursor/
  )
  assert.deepEqual(
    parsePortalConfig({
      ...valid,
      agentInstructions: {
        claude: { global: true, local: false },
        codex: { global: false, local: true },
      },
    }).agentInstructions,
    {
      claude: { global: true, local: false },
      codex: { global: false, local: true },
    }
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        instructions: {
          claude: { global: false, local: true },
          codex: { global: false, local: true },
        },
      }),
    /Unsupported config root fields: instructions/
  )
  assert.throws(
    () => parsePortalConfig({ ...valid, ui: {} }),
    /Unsupported config root fields: ui/
  )
})

test('concurrent section updates preserve both MCP and Skill changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-update-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()

  try {
    await ensurePortalConfig(configPath, defaults)
    await Promise.all([
      updatePortalConfig(
        configPath,
        (config) => {
          config.mcp = {
            connectionStrategy: 'per-thread',
            servers: {
              example: {
                transport: 'streamable-http',
                url: 'https://example.com/mcp',
              },
            },
          }
        },
        defaults
      ),
      updatePortalConfig(
        configPath,
        (config) => {
          config.skills = [
            {
              name: 'example-skill',
              directory: 'skills/example-skill',
              enabled: true,
            },
          ]
        },
        defaults
      ),
    ])

    const config = await readPortalConfig(configPath)
    assert.deepEqual(config?.mcp, {
      connectionStrategy: 'per-thread',
      servers: {
        example: {
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
        },
      },
    })
    assert.deepEqual(config?.skills, [
      {
        name: 'example-skill',
        directory: 'skills/example-skill',
        enabled: true,
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updatePortalConfig releases its lock after an update error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-lock-'))
  const configPath = path.join(root, 'config.yaml')
  const lockPath = `${configPath}.lock`
  const defaults = createDefaultPortalConfig()

  try {
    await assert.rejects(
      updatePortalConfig(
        configPath,
        () => {
          throw new Error('update failed')
        },
        defaults
      ),
      /update failed/
    )
    await assert.rejects(access(lockPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig reclaims a stale lock directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-stale-'))
  const configPath = path.join(root, 'config.yaml')
  const lockPath = `${configPath}.lock`
  const defaults = createDefaultPortalConfig()

  try {
    await mkdir(lockPath, { recursive: true })
    const staleTime = new Date(Date.now() - 31_000)
    await utimes(lockPath, staleTime, staleTime)

    await ensurePortalConfig(configPath, defaults)

    assert.deepEqual(await readPortalConfig(configPath), defaults)
    await assert.rejects(access(lockPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
