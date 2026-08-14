import test from 'node:test'
import assert from 'node:assert/strict'

import { McpCommand } from '../../../src/cli-commands/commands/command-mcp.ts'
import type { ListenerCommandController } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { createCliCommandContext } from '../../helpers/cli-command-context.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(mcpServer?: ListenerCommandController) {
  const ui = new TerminalController()
  const { context, cleanup } = createCliCommandContext({
    ui,
    ...(mcpServer === undefined ? {} : { mcpServer }),
  })
  return { cleanup, context, ui }
}

function rejectWith(reason: unknown): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>()
  reject(reason)
  return promise
}

test('McpCommand reports unavailable server and renders help', async (t) => {
  const { cleanup, context, ui } = createContext()
  t.after(cleanup)

  await McpCommand.execute(context, [])
  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server is unavailable.')
})

test('McpCommand starts and stops the server', async (t) => {
  const calls: string[] = []
  const { cleanup, context, ui } = createContext({
    start: async () => {
      calls.push('start')
    },
    stop: async () => {
      calls.push('stop')
    },
    status: () => ({ running: true, address: null, auth: false }),
  })
  t.after(cleanup)

  await McpCommand.execute(context, ['start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server started.')
  await McpCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server stopped.')
  assert.deepEqual(calls, ['start', 'stop'])
})

test('McpCommand reports start and stop failures', async (t) => {
  const { cleanup, context, ui } = createContext({
    start: () => rejectWith(new Error('start failed')),
    stop: () => rejectWith('stop failed'),
    status: () => ({ running: false, address: null, auth: false }),
  })
  t.after(cleanup)

  await McpCommand.execute(context, ['start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'start failed')
  await McpCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'stop failed')
})

test('McpCommand reports status and authentication without exposing tokens', async (t) => {
  let authenticationConfigured = false
  const { cleanup, context, ui } = createContext({
    start: async () => {},
    stop: async () => {},
    status: () => ({
      running: true,
      address: 'http://127.0.0.1:8788/mcp',
      auth: authenticationConfigured,
    }),
  })
  t.after(cleanup)

  await McpCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')
  authenticationConfigured = true
  await McpCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication configured.')
  await McpCommand.execute(context, ['status'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    [
      'Running: yes',
      'Address: http://127.0.0.1:8788/mcp',
      'Authentication: enabled',
    ].join('\n')
  )
  await McpCommand.execute(context, ['unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Subcommands:/)
})
