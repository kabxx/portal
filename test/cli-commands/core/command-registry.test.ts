import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CommandRegistry,
  tokenizeCommandInput,
} from '../../../src/cli-commands/core/command-registry.ts'
import { HelpCommand } from '../../../src/cli-commands/commands/command-help.ts'

test('CommandRegistry only registers primary command names', () => {
  const registry = new CommandRegistry([HelpCommand])

  assert.equal(registry.find('/help'), HelpCommand)
  assert.equal(registry.find('/h'), null)
})

test('tokenizeCommandInput preserves quoted headers, JSON, and stdio separators', () => {
  assert.deepEqual(
    tokenizeCommandInput(
      '/mcp add remote https://example.com/mcp --header "Authorization: Bearer ${env:TOKEN}"'
    ),
    [
      '/mcp',
      'add',
      'remote',
      'https://example.com/mcp',
      '--header',
      'Authorization: Bearer ${env:TOKEN}',
    ]
  )
  assert.deepEqual(
    tokenizeCommandInput(
      '/mcp prompt attach remote review {"focus":"error handling"}'
    ),
    [
      '/mcp',
      'prompt',
      'attach',
      'remote',
      'review',
      '{"focus":"error handling"}',
    ]
  )
  assert.deepEqual(tokenizeCommandInput('/mcp add local -- npx -y server'), [
    '/mcp',
    'add',
    'local',
    '--',
    'npx',
    '-y',
    'server',
  ])
  assert.throws(
    () => tokenizeCommandInput('/mcp add "unfinished'),
    /Unterminated/
  )
})
