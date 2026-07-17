import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
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

function parseConfigYaml(value: string): Record<string, unknown> {
  const document: unknown = parseYaml(value)
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    throw new Error('Expected the YAML document root to be an object.')
  }
  return document as Record<string, unknown>
}

function readConfigSection(
  document: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const section = document[name]
  if (
    section === null ||
    typeof section !== 'object' ||
    Array.isArray(section)
  ) {
    throw new Error(`Expected ${name} to be an object.`)
  }
  return section as Record<string, unknown>
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
    assert.deepEqual(defaults.listeners, {
      api: { host: '127.0.0.1', port: 8787, token: null },
      mcp: { host: '127.0.0.1', port: 8788, token: null },
    })
    assert.deepEqual(defaults.mcpServers, {})
    assert.deepEqual(defaults.skills, {})
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
      agentInstructions: {
        claude: { global: false, local: false },
        codex: { global: false, local: false },
      },
      listeners: {
        api: { host: '127.0.0.1', port: 8787, token: null },
        mcp: { host: '127.0.0.1', port: 8788, token: null },
      },
      mcpServers: {},
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
    assert.notEqual(keybindingsStart, -1)
    assert.ok(keybindingsStart < advancedStart)
    assert.match(
      contents,
      /\nhooks:[\s\S]+\n\n# Low-frequency runtime tuning and resource limits\.\nadvanced:\n/
    )
    assert.equal(contents.trimEnd().endsWith('commandOutputLimitMB: 1'), true)
    assert.equal((advancedContents.match(/\n\n {2}# /g) ?? []).length, 7)
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

test('parsePortalConfig preserves API and MCP Server tokens exactly', () => {
  const valid = createDefaultPortalConfig()
  for (const token of [null, '', '   ', '  secret  ']) {
    const parsed = parsePortalConfig({
      ...valid,
      listeners: {
        api: { ...valid.listeners.api, token },
        mcp: { ...valid.listeners.mcp, token },
      },
    })
    assert.equal(parsed.listeners.api.token, token)
    assert.equal(parsed.listeners.mcp.token, token)
  }
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

test('ensurePortalConfig preserves API and MCP Server tokens on disk', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-config-token-'))
  const configPath = path.join(root, 'config.yaml')
  const defaults = createDefaultPortalConfig(root)

  try {
    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        listeners: {
          api: { ...defaults.listeners.api, token: '  secret  ' },
          mcp: { ...defaults.listeners.mcp, token: '   ' },
        },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    let document = parseConfigYaml(await readFile(configPath, 'utf8'))
    let listeners = readConfigSection(document, 'listeners')
    assert.equal(readConfigSection(listeners, 'api').token, '  secret  ')
    assert.equal(readConfigSection(listeners, 'mcp').token, '   ')

    await writeFile(
      configPath,
      stringifyYaml({
        ...defaults,
        listeners: {
          api: { ...defaults.listeners.api, token: '' },
          mcp: { ...defaults.listeners.mcp, token: '' },
        },
      }),
      'utf8'
    )
    await ensurePortalConfig(configPath, defaults)
    document = parseConfigYaml(await readFile(configPath, 'utf8'))
    listeners = readConfigSection(document, 'listeners')
    assert.equal(readConfigSection(listeners, 'api').token, '')
    assert.equal(readConfigSection(listeners, 'mcp').token, '')
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
      document: { ...defaults, api: defaults.listeners.api },
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
    assert.deepEqual(document.mcpServers, defaults.mcpServers)
    assert.deepEqual(document.skills, defaults.skills)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensurePortalConfig completes a partial listener without replacing its values', async () => {
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
          ...defaults.listeners,
          api: { host: 'localhost' },
        },
      }),
      'utf8'
    )

    await ensurePortalConfig(configPath, defaults)
    const document = parseConfigYaml(await readFile(configPath, 'utf8'))
    const listeners = readConfigSection(document, 'listeners')

    assert.deepEqual(readConfigSection(listeners, 'api'), {
      host: 'localhost',
      port: 8787,
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
      listeners: { api: defaults.listeners.api },
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
    /mcpServers must be an object keyed by name/
  )
  assert.throws(
    () => parsePortalConfig({ ...valid, skills: [] }),
    /skills must be an object keyed by name/
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

test('parsePortalConfig rejects invalid listener settings', () => {
  const valid = createDefaultPortalConfig()

  assert.throws(
    () =>
      parsePortalConfig({
        ...valid,
        listeners: {
          ...valid.listeners,
          api: { ...valid.listeners.api, host: '   ' },
        },
      }),
    /listeners\.api\.host must be a non-empty string/
  )
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
          config.mcpServers = {
            example: {
              transport: 'streamable-http',
              url: 'https://example.com/mcp',
            },
          }
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
    assert.deepEqual(config?.mcpServers, {
      example: {
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
      },
    })
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
        config.listeners.api.port = 9001
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.api.port, 9001)
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
          config.listeners.api.port = 9002
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
        config.listeners.api.port = 9002
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.api.port, 9002)
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
        config.listeners.api.port = 9003
      },
      defaults
    )
    assert.equal((await readPortalConfig(configPath))?.listeners.api.port, 9003)
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
        config.listeners.api.port = 9004
      },
      defaults
    )

    assert.equal((await readPortalConfig(configPath))?.listeners.api.port, 9004)
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
