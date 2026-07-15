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
  createDefaultAdvancedConfig,
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
    assert.equal(defaults.browser.engine, 'chromium')
    assert.equal(path.isAbsolute(defaults.browser.executablePath), true)
    assert.equal(
      defaults.browser.profilePath,
      path.join(dataDirectory, 'profiles', defaults.browser.engine)
    )
    assert.equal(defaults.browser.remoteDebuggingPort, 9222)
    assert.deepEqual(defaults.agentInstructions, {
      claude: { global: false, local: false },
      codex: { global: false, local: false },
    })
    assert.deepEqual(defaults.api, {
      host: '127.0.0.1',
      port: 8787,
      token: null,
    })
    assert.deepEqual(defaults.advanced, createDefaultAdvancedConfig())
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
        '  engine: chromium',
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
        engine: 'chromium',
        executablePath,
        profilePath,
        remoteDebuggingPort: 9222,
      },
      agentInstructions: {
        claude: { global: false, local: false },
        codex: { global: false, local: false },
      },
      api: { host: '127.0.0.1', port: 8787, token: null },
      mcp: { connectionStrategy: 'per-thread', servers: {} },
      skills: [],
      hooks: { enabled: false, maxDepth: 1, handlers: [] },
      advanced: createDefaultAdvancedConfig(),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig rejects browser.name without rewriting the file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-name-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const contents = stringifyYaml({
    ...defaults,
    browser: {
      name: 'edge',
      executablePath: defaults.browser.executablePath,
      profilePath: defaults.browser.profilePath,
      remoteDebuggingPort: defaults.browser.remoteDebuggingPort,
    },
  })

  try {
    await writeFile(configPath, contents, 'utf8')
    await assert.rejects(
      ensurePortalConfig(configPath, defaults),
      /Unsupported browser fields: name/
    )
    assert.equal(await readFile(configPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig writes advanced last with field comments and section spacing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-comments-'))
  const configPath = path.join(root, 'config.yaml')

  try {
    await ensurePortalConfig(configPath, createDefaultPortalConfig(root))
    const contents = await readFile(configPath, 'utf8')
    const advancedStart = contents.indexOf('\nadvanced:\n')
    const advancedContents = contents.slice(advancedStart)
    const advancedFields = [
      'startupTimeoutSeconds',
      'closeTimeoutSeconds',
      'requestStartWarningAfterSeconds',
      'blockedWarningEverySeconds',
      'responseStartTimeoutSeconds',
      'responseStallTimeoutSeconds',
      'restoreTimeoutSeconds',
      'historyLoadTimeoutSeconds',
      'historyPageTimeoutSeconds',
      'initializationAttemptLimit',
      'requestAttemptLimit',
      'cancelWaitTimeoutSeconds',
      'shutdownCloseTimeoutSeconds',
      'childRuntimeCloseTimeoutSeconds',
      'resultOutputLimitMB',
      'stopGraceSeconds',
      'stopTimeoutSeconds',
      'downloadTimeoutSeconds',
      'downloadLimitMB',
      'extractedSizeLimitMB',
      'fileCountLimit',
      'resourceFileCountLimit',
      'manifestSizeLimitKB',
      'redirectLimit',
      'requestBodyLimitKB',
      'requestTimeoutSeconds',
      'sseHeartbeatSeconds',
      'codexSizeLimitKB',
      'claudeSizeLimitKB',
      'importDepthLimit',
      'commandOutputLimitMB',
    ]

    assert.notEqual(advancedStart, -1)
    assert.match(
      contents,
      /\nhooks:[\s\S]+\n\n# Low-frequency runtime tuning and resource limits\.\nadvanced:\n/
    )
    assert.equal(contents.trimEnd().endsWith('commandOutputLimitMB: 1'), true)
    assert.equal((advancedContents.match(/\n\n  # /g) ?? []).length, 7)
    for (const field of advancedFields) {
      assert.match(
        advancedContents,
        new RegExp(`\\n    # [^\\n]+\\n    ${field}:`),
        `expected an English comment immediately above ${field}`
      )
    }
    assert.equal(
      (advancedContents.match(/\n    # [^\n]+\n    fileCountLimit:/g) ?? [])
        .length,
      2
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig can restore comments after first-run bootstrap writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-bootstrap-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    await writeFile(configPath, stringifyYaml(defaults), 'utf8')
    await ensurePortalConfig(configPath, defaults, {
      rewriteWithComments: true,
    })

    assert.match(
      await readFile(configPath, 'utf8'),
      /# Low-frequency runtime tuning and resource limits\.\nadvanced:/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig completes partial advanced settings from defaults', () => {
  const defaults = createDefaultPortalConfig()
  const parsed = parsePortalConfig({
    ...defaults,
    advanced: {
      command: { resultOutputLimitMB: 8 },
      api: { requestTimeoutSeconds: 12 },
    },
  })

  assert.deepEqual(parsed.advanced, {
    ...createDefaultAdvancedConfig(),
    command: {
      ...createDefaultAdvancedConfig().command,
      resultOutputLimitMB: 8,
    },
    api: {
      ...createDefaultAdvancedConfig().api,
      requestTimeoutSeconds: 12,
    },
  })
})

test('parsePortalConfig normalizes API tokens', () => {
  const valid = createDefaultPortalConfig()
  assert.equal(
    parsePortalConfig({
      ...valid,
      api: { ...valid.api, token: '  secret  ' },
    }).api.token,
    'secret'
  )
  assert.equal(
    parsePortalConfig({
      ...valid,
      api: { ...valid.api, token: '   ' },
    }).api.token,
    null
  )
  assert.equal(
    parsePortalConfig({
      ...valid,
      api: { ...valid.api, token: '' },
    }).api.token,
    null
  )
})

test('parsePortalConfig defaults missing instruction scope fields to false', () => {
  const defaults = createDefaultPortalConfig()
  const parsed = parsePortalConfig({
    ...defaults,
    agentInstructions: {
      claude: {},
      codex: { global: false, local: true },
    },
  })

  assert.deepEqual(parsed.agentInstructions, {
    claude: { global: false, local: false },
    codex: { global: false, local: true },
  })
})

test('ensurePortalConfig writes normalized API tokens back to disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-token-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        api: { ...defaults.api, token: '  secret  ' },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    assert.equal(
      parseYaml(await readFile(configPath, 'utf8')).api.token,
      'secret'
    )

    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        api: { ...defaults.api, token: '   ' },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    assert.equal(parseYaml(await readFile(configPath, 'utf8')).api.token, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig rejects the removed provider response timeout', () => {
  const config = structuredClone(createDefaultPortalConfig('data')) as any
  config.advanced.provider.responseTimeoutMinutes = 5

  assert.throws(
    () => parsePortalConfig(config),
    /Unsupported advanced\.provider fields: responseTimeoutMinutes/
  )
})

test('ensurePortalConfig rejects the removed provider response timeout without rewriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-timeout-'))
  const configPath = path.join(root, 'config.yaml')
  const config = structuredClone(createDefaultPortalConfig(root)) as any
  config.advanced.provider.responseTimeoutMinutes = 5
  const contents = stringifyYaml(config)

  try {
    await writeFile(configPath, contents, 'utf8')

    await assert.rejects(
      ensurePortalConfig(configPath, createDefaultPortalConfig(root)),
      /Unsupported advanced\.provider fields: responseTimeoutMinutes/
    )

    assert.equal(await readFile(configPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig rejects unknown and invalid advanced settings', () => {
  const valid = createDefaultPortalConfig()

  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        advanced: { ...valid.advanced, hidden: true },
      }),
    /Unsupported advanced fields: hidden/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        advanced: {
          ...valid.advanced,
          api: { ...valid.advanced.api, requestTimeoutSeconds: null },
        },
      }),
    /advanced\.api\.requestTimeoutSeconds must be a non-negative integer/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        advanced: {
          ...valid.advanced,
          command: { ...valid.advanced.command, stopGraceSeconds: 0 },
        },
      }),
    /advanced\.command\.stopGraceSeconds must be a positive number/
  )
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

  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        browser: { ...valid.browser, engine: 'firefox' },
      }),
    /browser\.engine must be "chromium"/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        browser: {
          name: 'edge',
          executablePath: valid.browser.executablePath,
          profilePath: valid.browser.profilePath,
          remoteDebuggingPort: valid.browser.remoteDebuggingPort,
        },
      }),
    /Unsupported browser fields: name/
  )
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
    assert.deepEqual(config?.hooks, defaults.hooks)
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
