import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  createDefaultAdvancedConfig,
  createDefaultPortalConfig,
  ensurePortalConfig,
  parsePortalConfig,
  readPortalConfig,
  updatePortalConfig,
  withPortalConfigTransaction,
} from '../../src/config/portal-config.ts'
import { createDefaultKeybindings } from '../../src/keybindings/keybinding-config.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfigYaml(value: string): Record<string, unknown> {
  const document: unknown = parseYaml(value)
  if (!isRecord(document)) {
    throw new Error('Expected the YAML document root to be an object.')
  }
  return document
}

function readConfigSection(
  document: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const section = document[name]
  if (!isRecord(section)) {
    throw new Error(`Expected ${name} to be an object.`)
  }
  return section
}

test('ensurePortalConfig creates one YAML file with concrete defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-default-'))
  const configPath = path.join(root, 'data', 'config.yaml')

  try {
    const dataDirectory = path.join(root, 'data')
    const defaults = createDefaultPortalConfig(dataDirectory)
    const config = await ensurePortalConfig(configPath, defaults)
    const rawDocument = parseConfigYaml(await readFile(configPath, 'utf8'))
    const document = parsePortalConfig(rawDocument)

    assert.deepEqual(config, defaults)
    assert.deepEqual(rawDocument, defaults)
    assert.deepEqual(document, defaults)
    assert.equal(defaults.advanced.runtime.spawnDepthLimit, 5)
    assert.equal(defaults.browser.engine, 'chromium')
    assert.equal(path.isAbsolute(defaults.browser.executablePath), true)
    assert.equal(
      defaults.browser.profilePath,
      path.join(dataDirectory, 'profiles', defaults.browser.engine)
    )
    assert.equal(defaults.browser.remoteDebuggingPort, 9222)
    assert.equal(defaults.projectInstructions, false)
    assert.deepEqual(defaults.listeners, {
      mcp: { host: '127.0.0.1', port: 8788, token: null },
    })
    assert.deepEqual(defaults.skills, {})
    assert.deepEqual(defaults.advanced, createDefaultAdvancedConfig())
    assert.equal(defaults.advanced.provider.restoreTimeoutSeconds, 180)
    assert.equal(document.advanced.provider.restoreTimeoutSeconds, 180)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'ensurePortalConfig enforces private POSIX config and lock permissions',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-mode-'))
    const dataDirectory = path.join(root, 'data')
    const configPath = path.join(dataDirectory, 'config.yaml')

    try {
      const defaults = createDefaultPortalConfig(dataDirectory)
      await ensurePortalConfig(configPath, defaults)
      assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700)
      assert.equal((await stat(configPath)).mode & 0o777, 0o600)
      assert.equal(
        (await stat(path.join(dataDirectory, '.locks'))).mode & 0o777,
        0o700
      )
      assert.equal(
        (await stat(path.join(dataDirectory, '.locks', 'config.lock'))).mode &
          0o777,
        0o600
      )

      await chmod(dataDirectory, 0o755)
      await chmod(configPath, 0o644)
      await chmod(path.join(dataDirectory, '.locks'), 0o755)
      await chmod(path.join(dataDirectory, '.locks', 'config.lock'), 0o644)
      await ensurePortalConfig(configPath, defaults)
      assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700)
      assert.equal((await stat(configPath)).mode & 0o777, 0o600)
      assert.equal(
        (await stat(path.join(dataDirectory, '.locks'))).mode & 0o777,
        0o700
      )
      assert.equal(
        (await stat(path.join(dataDirectory, '.locks', 'config.lock'))).mode &
          0o777,
        0o600
      )

      await chmod(configPath, 0o400)
      await ensurePortalConfig(configPath, defaults, {
        rewriteWithComments: true,
      })
      assert.equal((await stat(configPath)).mode & 0o777, 0o400)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

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
        'mcpServers: {}',
        'skills: {}',
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
      projectInstructions: false,
      listeners: {
        mcp: { host: '127.0.0.1', port: 8788, token: null },
      },
      skills: {},
      hooks: { enabled: false, maxDepth: 1, handlers: [] },
      keybindings: createDefaultKeybindings(),
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
    const keybindingsStart = contents.indexOf('\nkeybindings:\n')
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
      'spawnDepthLimit',
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
      'commandOutputLimitMB',
    ]

    assert.notEqual(advancedStart, -1)
    assert.notEqual(keybindingsStart, -1)
    assert.ok(keybindingsStart < advancedStart)
    assert.match(
      contents,
      /\nhooks:[\s\S]+\n\n# Low-frequency runtime tuning and resource limits\.\nadvanced:\n/
    )
    assert.equal(contents.trimEnd().endsWith('commandOutputLimitMB: 1'), true)
    assert.equal((advancedContents.match(/\n\n {2}# /g) ?? []).length, 5)
    for (const field of advancedFields) {
      assert.match(
        advancedContents,
        new RegExp(`\\n    # [^\\n]+\\n    ${field}:`),
        `expected an English comment immediately above ${field}`
      )
    }
    assert.equal(
      (advancedContents.match(/\n {4}# [^\n]+\n {4}fileCountLimit:/g) ?? [])
        .length,
      1
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

test('ensurePortalConfig migrates partial keybindings to the complete table', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-keybindings-migration-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        keybindings: { 'input.submit': ['ctrl+enter'] },
      }),
      'utf8'
    )

    const config = await ensurePortalConfig(configPath, defaults)
    const contents = await readFile(configPath, 'utf8')
    const document = parseConfigYaml(contents)
    const keybindings = readConfigSection(document, 'keybindings')

    assert.deepEqual(config.keybindings['input.submit'], ['ctrl+enter'])
    assert.deepEqual(keybindings, config.keybindings)
    assert.deepEqual(Object.keys(keybindings), [
      ...Object.keys(createDefaultKeybindings()),
    ])
    assert.ok(
      contents.indexOf('\nkeybindings:') < contents.indexOf('\nadvanced:')
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
    },
  })

  assert.deepEqual(parsed.advanced, {
    ...createDefaultAdvancedConfig(),
    command: {
      ...createDefaultAdvancedConfig().command,
      resultOutputLimitMB: 8,
    },
  })
})

test('ensurePortalConfig adds the managed spawn depth limit to older files', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-spawn-depth-migration-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const { spawnDepthLimit: _spawnDepthLimit, ...previousRuntimeConfig } =
    defaults.advanced.runtime

  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        advanced: {
          ...defaults.advanced,
          runtime: previousRuntimeConfig,
        },
      }),
      'utf8'
    )

    const config = await ensurePortalConfig(configPath, defaults)
    const document = parseConfigYaml(await readFile(configPath, 'utf8'))
    const advanced = readConfigSection(document, 'advanced')
    const runtime = readConfigSection(advanced, 'runtime')

    assert.equal(config.advanced.runtime.spawnDepthLimit, 5)
    assert.equal(runtime.spawnDepthLimit, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig validates the spawn depth limit', () => {
  const valid = createDefaultPortalConfig()

  for (const spawnDepthLimit of [0, 1, 5, 32]) {
    const parsed = parsePortalConfig({
      ...valid,
      advanced: {
        ...valid.advanced,
        runtime: { ...valid.advanced.runtime, spawnDepthLimit },
      },
    })
    assert.equal(parsed.advanced.runtime.spawnDepthLimit, spawnDepthLimit)
  }

  for (const spawnDepthLimit of [-1, 1.5, 33]) {
    assert.throws(
      () =>
        parsePortalConfig({
          ...valid,
          advanced: {
            ...valid.advanced,
            runtime: { ...valid.advanced.runtime, spawnDepthLimit },
          },
        }),
      /advanced\.runtime\.spawnDepthLimit must be an integer from 0 to 32/
    )
  }
})

test('parsePortalConfig preserves the MCP Server token exactly', () => {
  const valid = createDefaultPortalConfig()
  for (const token of [null, '', '   ', '  secret  ']) {
    const parsed = parsePortalConfig({
      ...valid,
      listeners: {
        mcp: { ...valid.listeners.mcp, token },
      },
    })
    assert.equal(parsed.listeners.mcp.token, token)
  }
})

test('parsePortalConfig rejects non-empty outbound MCP config without exposing values', () => {
  const secret = 'do-not-print-this-secret'
  const valid = createDefaultPortalConfig()

  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        mcpServers: {
          private: {
            transport: 'streamable-http',
            url: `https://example.invalid/${secret}`,
            headers: { Authorization: secret },
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(
        error.message,
        /Outbound MCP clients are no longer supported/
      )
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    }
  )
})

test('parsePortalConfig defaults project instructions to false', () => {
  const defaults = createDefaultPortalConfig()
  const { projectInstructions: _projectInstructions, ...withoutSetting } =
    defaults
  const parsed = parsePortalConfig(withoutSetting)

  assert.equal(parsed.projectInstructions, false)
})

test('ensurePortalConfig migrates removed network and instruction settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-token-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const { projectInstructions: _projectInstructions, ...legacyDefaults } =
    defaults

  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...legacyDefaults,
        agentInstructions: {
          claude: { global: false, local: false },
          codex: { global: false, local: false },
        },
        mcpServers: {},
        listeners: {
          api: {
            host: '127.0.0.1',
            port: 8787,
            token: '${env:PORTAL_API_TOKEN}',
          },
          mcp: {
            ...defaults.listeners.mcp,
            token: '$${env:LITERAL_MCP_TOKEN}',
          },
        },
        advanced: {
          ...defaults.advanced,
          api: {
            requestBodyLimitKB: 256,
            requestTimeoutSeconds: 0,
            sseHeartbeatSeconds: 15,
          },
          instructions: {
            codexSizeLimitKB: 32,
            claudeSizeLimitKB: 96,
            fileCountLimit: 128,
            importDepthLimit: 4,
          },
        },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    let document = parseConfigYaml(await readFile(configPath, 'utf8'))
    let listeners = readConfigSection(document, 'listeners')
    assert.equal(Object.hasOwn(document, 'mcpServers'), false)
    assert.equal(Object.hasOwn(document, 'agentInstructions'), false)
    assert.equal(document.projectInstructions, false)
    assert.equal(Object.hasOwn(listeners, 'api'), false)
    const advanced = readConfigSection(document, 'advanced')
    assert.equal(Object.hasOwn(advanced, 'api'), false)
    assert.equal(Object.hasOwn(advanced, 'instructions'), false)
    assert.equal(
      readConfigSection(listeners, 'mcp').token,
      '$${env:LITERAL_MCP_TOKEN}'
    )

    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        listeners: {
          mcp: { ...defaults.listeners.mcp, token: '' },
        },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    document = parseConfigYaml(await readFile(configPath, 'utf8'))
    listeners = readConfigSection(document, 'listeners')
    assert.equal(readConfigSection(listeners, 'mcp').token, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parsePortalConfig rejects enabled legacy instruction sources', () => {
  const defaults = createDefaultPortalConfig()

  assert.throws(
    () =>
      parsePortalConfig({
        ...defaults,
        agentInstructions: {
          claude: { global: false, local: true },
          codex: { global: false, local: false },
        },
      }),
    /Legacy project instruction sources were enabled/
  )
})

test('ensurePortalConfig preserves rejected outbound MCP config without exposing values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-mcp-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const secret = 'do-not-print-this-secret'
  const contents = stringifyYaml({
    ...defaults,
    mcpServers: {
      private: {
        transport: 'streamable-http',
        url: `https://example.invalid/${secret}`,
        headers: { Authorization: secret },
      },
    },
  })

  try {
    await writeFile(configPath, contents, 'utf8')
    await assert.rejects(
      async () => await ensurePortalConfig(configPath, defaults),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(
          error.message,
          /Outbound MCP clients are no longer supported/
        )
        assert.doesNotMatch(error.message, new RegExp(secret))
        return true
      }
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
          command: { ...valid.advanced.command, stopGraceSeconds: 0 },
        },
      }),
    /advanced\.command\.stopGraceSeconds must be a positive number/
  )
})

test('ensurePortalConfig preserves files with unsupported advanced fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-invalid-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const config = {
    ...defaults,
    advanced: { ...defaults.advanced, hidden: true },
  }
  const contents = stringifyYaml(config)

  try {
    await writeFile(configPath, contents, 'utf8')

    await assert.rejects(
      ensurePortalConfig(configPath, createDefaultPortalConfig(root)),
      /Unsupported advanced fields: hidden/
    )
    assert.equal(await readFile(configPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig rejects legacy fields and array skills without rewriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-legacy-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)
  const cases: Array<{
    document: Record<string, unknown>
    message: RegExp
  }> = [
    {
      document: { ...defaults, api: {} },
      message: /Unsupported config root fields: api/,
    },
    {
      document: { ...defaults, mcpServer: defaults.listeners.mcp },
      message: /Unsupported config root fields: mcpServer/,
    },
    {
      document: { ...defaults, mcp: { servers: {} } },
      message: /Unsupported config root fields: mcp/,
    },
    {
      document: { ...defaults, skills: [] },
      message: /skills must be an object keyed by name/,
    },
  ]

  try {
    for (const { document, message } of cases) {
      const contents = stringifyYaml(document)
      await writeFile(configPath, contents, 'utf8')
      await assert.rejects(ensurePortalConfig(configPath, defaults), message)
      assert.equal(await readFile(configPath, 'utf8'), contents)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig writes a missing listeners section into an existing config', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-api-migration-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    const { listeners: _listeners, ...partialConfig } = defaults
    await writeFile(configPath, stringifyYaml(partialConfig), 'utf8')

    const config = await ensurePortalConfig(configPath, defaults)
    const document = parseConfigYaml(await readFile(configPath, 'utf8'))

    assert.deepEqual(config.listeners, defaults.listeners)
    assert.deepEqual(document.listeners, defaults.listeners)
    assert.deepEqual(document.browser, defaults.browser)
    assert.deepEqual(document.skills, defaults.skills)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig completes a partial MCP listener without replacing its values', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-api-partial-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        listeners: {
          mcp: { host: 'localhost' },
        },
      }),
      'utf8'
    )

    await ensurePortalConfig(configPath, defaults)
    const document = parseConfigYaml(await readFile(configPath, 'utf8'))
    const listeners = readConfigSection(document, 'listeners')

    assert.deepEqual(readConfigSection(listeners, 'mcp'), {
      host: 'localhost',
      port: 8788,
      token: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig writes a missing MCP listener section', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-config-mcp-server-migration-')
  )
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    const partialConfig = {
      ...defaults,
      listeners: {},
    }
    await writeFile(configPath, stringifyYaml(partialConfig), 'utf8')

    const config = await ensurePortalConfig(configPath, defaults)
    const document = parseConfigYaml(await readFile(configPath, 'utf8'))
    const listeners = readConfigSection(document, 'listeners')

    assert.deepEqual(config.listeners.mcp, defaults.listeners.mcp)
    assert.deepEqual(
      readConfigSection(listeners, 'mcp'),
      defaults.listeners.mcp
    )
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
  assert.equal(
    parsePortalConfig({
      ...valid,
      browser: { ...valid.browser, remoteDebuggingPort: 0 },
    }).browser.remoteDebuggingPort,
    0
  )
  for (const remoteDebuggingPort of [-1, 65_536, 1.5, null, '9222']) {
    assert.throws(
      () =>
        parsePortalConfig({
          ...valid,
          browser: { ...valid.browser, remoteDebuggingPort },
        }),
      /browser\.remoteDebuggingPort must be an integer from 0 to 65535/
    )
  }
  assert.throws(
    () => parsePortalConfig({ ...valid, mcpServers: [] }),
    /Outbound MCP clients are no longer supported/
  )
  assert.throws(
    () => parsePortalConfig({ ...valid, skills: [] }),
    /skills must be an object keyed by name/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        projectInstructions: 'yes',
      }),
    /projectInstructions must be a boolean/
  )
  assert.equal(
    parsePortalConfig({
      ...valid,
      projectInstructions: true,
    }).projectInstructions,
    true
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

test('parsePortalConfig rejects invalid MCP listener settings', () => {
  const valid = createDefaultPortalConfig()

  assert.equal(
    parsePortalConfig({
      ...valid,
      listeners: {
        ...valid.listeners,
        mcp: { ...valid.listeners.mcp, host: '   ' },
      },
    }).listeners.mcp.host,
    '   '
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        listeners: {
          ...valid.listeners,
          mcp: { ...valid.listeners.mcp, host: '' },
        },
      }),
    /listeners\.mcp\.host must be a non-empty string/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        listeners: {
          ...valid.listeners,
          mcp: { ...valid.listeners.mcp, port: 0 },
        },
      }),
    /listeners\.mcp\.port must be an integer from 1 to 65535/
  )
  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        listeners: {
          ...valid.listeners,
          mcp: { ...valid.listeners.mcp, token: 123 },
        },
      }),
    /listeners\.mcp\.token must be a string or null/
  )
})

test('concurrent aliased config updates preserve both section changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-update-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()

  try {
    await ensurePortalConfig(configPath, defaults)
    await Promise.all([
      updatePortalConfig(
        configPath,
        (config) => {
          config.listeners.mcp.port = 9000
        },
        defaults
      ),
      updatePortalConfig(
        path.relative(process.cwd(), configPath),
        (config) => {
          config.skills = {
            'example-skill': {
              directory: 'skills/example-skill',
              enabled: true,
            },
          }
        },
        defaults
      ),
    ])

    const config = await readPortalConfig(configPath)
    assert.equal(config?.listeners.mcp.port, 9000)
    assert.deepEqual(config?.skills, {
      'example-skill': {
        directory: 'skills/example-skill',
        enabled: true,
      },
    })
    assert.deepEqual(config?.hooks, defaults.hooks)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updatePortalConfig releases its lock after an update error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-lock-'))
  const configPath = path.join(root, 'config.yaml')
  const lockPath = path.join(root, '.locks', 'config.lock')
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
    await access(lockPath)
    await updatePortalConfig(
      configPath,
      (config) => {
        config.listeners.mcp.port = 9001
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.mcp.port, 9001)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cross-process config lock times out without deleting the lock file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-timeout-'))
  const configPath = path.join(root, 'config.yaml')
  const lockPath = path.join(root, '.locks', 'config.lock')
  const defaults = createDefaultPortalConfig()
  let holder: ChildProcessWithoutNullStreams | undefined

  try {
    await ensurePortalConfig(configPath, defaults)
    holder = await startConfigLockHolder(configPath)

    await assert.rejects(
      updatePortalConfig(
        configPath,
        (config) => {
          config.listeners.mcp.port = 9002
        },
        defaults
      ),
      /Timed out waiting for config lock/
    )

    await access(lockPath)
    holder.stdin.end('release\n')
    await waitForChildExit(holder)
    holder = undefined

    await updatePortalConfig(
      configPath,
      (config) => {
        config.listeners.mcp.port = 9002
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.mcp.port, 9002)
  } finally {
    await terminateChild(holder)
    await rm(root, { recursive: true, force: true })
  }
})

test('terminating a config lock holder releases the native lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-kill-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()
  let holder: ChildProcessWithoutNullStreams | undefined

  try {
    await ensurePortalConfig(configPath, defaults)
    holder = await startConfigLockHolder(configPath)
    holder.kill('SIGKILL')
    await waitForChildExit(holder)
    holder = undefined

    await updatePortalConfig(
      configPath,
      (config) => {
        config.listeners.mcp.port = 9003
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.mcp.port, 9003)
  } finally {
    await terminateChild(holder)
    await rm(root, { recursive: true, force: true })
  }
})

test('config transactions require an explicit commit or noChange', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-tx-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()

  try {
    await assert.rejects(
      withPortalConfigTransaction(configPath, () => {}, defaults),
      /must call commit\(\) or noChange\(\)/
    )
    assert.equal(await readPortalConfig(configPath), null)

    await withPortalConfigTransaction(
      configPath,
      (transaction) => transaction.noChange(),
      defaults
    )
    assert.equal(await readPortalConfig(configPath), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config transactions can only be completed once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-tx-once-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()

  try {
    await withPortalConfigTransaction(
      configPath,
      async (transaction) => {
        await transaction.commit()
        await assert.rejects(
          transaction.commit(),
          /Config transaction has already been completed/
        )
        assert.throws(
          () => transaction.noChange(),
          /Config transaction has already been completed/
        )
      },
      defaults
    )
    assert.deepEqual(await readPortalConfig(configPath), defaults)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config updates keep the atomic write path free of temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-atomic-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig()

  try {
    await ensurePortalConfig(configPath, defaults)
    await updatePortalConfig(
      configPath,
      (config) => {
        config.listeners.mcp.port = 9004
      },
      defaults
    )

    assert.equal((await readPortalConfig(configPath))?.listeners.mcp.port, 9004)
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith('.tmp')),
      []
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const LOCK_HOLDER_FIXTURE = fileURLToPath(
  new URL('../fixtures/config-lock-holder.ts', import.meta.url)
)
const CHILD_TIMEOUT_MS = 10_000

async function startConfigLockHolder(
  configPath: string
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', LOCK_HOLDER_FIXTURE, configPath],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `Config lock holder did not become ready. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
          )
        )
      }, CHILD_TIMEOUT_MS)
      const onData = () => {
        if (stdout.includes('ready\n')) {
          cleanup()
          resolve()
        }
      }
      const onExit = () => {
        cleanup()
        reject(
          new Error(
            `Config lock holder exited before ready. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
          )
        )
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        child.off('error', onError)
      }
      child.stdout.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
      onData()
    })
    return child
  } catch (error) {
    await terminateChild(child)
    throw error
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for config lock holder to exit'))
    }, CHILD_TIMEOUT_MS)
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit()
    }
  })
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams | undefined
): Promise<void> {
  if (child === undefined) {
    return
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  await waitForChildExit(child)
}
