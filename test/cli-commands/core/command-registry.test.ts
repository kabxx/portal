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

test('tokenizeCommandInput preserves quotes, JSON, and stdio separators', () => {
  assert.deepEqual(
    tokenizeCommandInput(
      '/example add remote https://example.com/service --header "Authorization: Bearer ${env:TOKEN}"'
    ),
    [
      '/example',
      'add',
      'remote',
      'https://example.com/service',
      '--header',
      'Authorization: Bearer ${env:TOKEN}',
    ]
  )
  assert.deepEqual(
    tokenizeCommandInput(
      '/example prompt attach remote review {"focus":"error handling"}'
    ),
    [
      '/example',
      'prompt',
      'attach',
      'remote',
      'review',
      '{"focus":"error handling"}',
    ]
  )
  assert.deepEqual(
    tokenizeCommandInput('/example add local -- npx -y server'),
    ['/example', 'add', 'local', '--', 'npx', '-y', 'server']
  )
  assert.throws(
    () => tokenizeCommandInput('/example add "unfinished'),
    /Unterminated/
  )
})
