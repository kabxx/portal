import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { parse as parseYaml } from 'yaml'

import {
  McpConfigError,
  McpDuplicateNameError,
  McpStoredConfigError,
  parseMcpConfig,
} from '../../src/mcp/mcp-config.ts'
import {
  redactMcpError,
  resolveMcpServerEnvironment,
} from '../../src/mcp/mcp-environment.ts'
import { McpLibrary } from '../../src/mcp/mcp-library.ts'

test('McpLibrary writes a root config object with servers keyed by name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-config-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  const library = new McpLibrary(configPath)

  try {
    await library.add('example', {
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
    })
    const document = parseYaml(await readFile(configPath, 'utf8'))

    assert.deepEqual(document.mcpServers, {
      example: {
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
      },
    })
    await assert.rejects(
      library.add('example', {
        transport: 'stdio',
        command: 'node',
      }),
      McpDuplicateNameError
    )

    await library.disable('example')
    assert.equal((await library.list()).servers[0]?.enabled, false)
    await library.enable('example')
    const enabledDocument = parseYaml(await readFile(configPath, 'utf8'))
    assert.equal(enabledDocument.mcpServers.example.enabled, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McpLibrary initializes a missing config without overwriting it later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-initialize-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  const library = new McpLibrary(configPath)

  try {
    await library.initialize()
    const document = parseYaml(await readFile(configPath, 'utf8'))
    assert.deepEqual(document.mcpServers, {})

    await writeFile(configPath, 'browser: [', 'utf8')
    await library.initialize()
    assert.equal(await readFile(configPath, 'utf8'), 'browser: [')
    await assert.rejects(
      library.set('example', {
        transport: 'stdio',
        command: 'node',
      }),
      McpStoredConfigError
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('McpLibrary preserves concurrent mutations in the MCP section', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-concurrent-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  const library = new McpLibrary(configPath)

  try {
    await Promise.all([
      library.add('alpha', {
        transport: 'streamable-http',
        url: 'https://alpha.example.com/mcp',
      }),
      library.add('beta', {
        transport: 'stdio',
        command: 'node',
        args: ['beta-server.js'],
      }),
    ])

    assert.deepEqual(
      (await library.list()).servers.map(({ name }) => name),
      ['alpha', 'beta']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP config isolates invalid servers and rejects non-object roots', () => {
  const parsed = parseMcpConfig({
    valid: { transport: 'stdio', command: 'node' },
    invalid: { transport: 'stdio' },
  })

  assert.deepEqual([...parsed.servers.keys()], ['valid'])
  assert.equal(parsed.issues.length, 1)
  assert.equal(parsed.issues[0]?.server, 'invalid')
  assert.throws(() => parseMcpConfig([]), McpConfigError)
})

test('MCP environment placeholders expand once and support literal escaping', () => {
  const resolved = resolveMcpServerEnvironment(
    {
      transport: 'stdio',
      command: '${env:COMMAND}',
      args: ['${env:NESTED}', '$${env:LITERAL}'],
      cwd: 'relative-directory',
      env: { TOKEN: '${env:TOKEN}' },
    },
    'C:\\portal\\data',
    {
      COMMAND: 'node',
      NESTED: '${env:SHOULD_NOT_EXPAND}',
      SHOULD_NOT_EXPAND: 'secret-command',
      TOKEN: 'secret-token',
    }
  )

  assert.equal(resolved.config.transport, 'stdio')
  if (resolved.config.transport !== 'stdio') {
    assert.fail('Expected stdio config')
  }
  assert.equal(resolved.config.command, 'node')
  assert.deepEqual(resolved.config.args, [
    '${env:SHOULD_NOT_EXPAND}',
    '${env:LITERAL}',
  ])
  assert.ok(path.isAbsolute(resolved.config.cwd ?? ''))
  assert.ok(resolved.redactions.includes('secret-token'))
  assert.equal(
    redactMcpError('request exposed secret-token', resolved.redactions),
    'request exposed [REDACTED]'
  )
  assert.throws(
    () =>
      resolveMcpServerEnvironment(
        { transport: 'stdio', command: '${env:MISSING}' },
        process.cwd(),
        {}
      ),
    /Environment variable is not set: MISSING/
  )
})
