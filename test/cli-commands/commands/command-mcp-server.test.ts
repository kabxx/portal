import assert from 'node:assert/strict'
import test from 'node:test'

import { McpServerCommand } from '../../../src/cli-commands/commands/command-mcp-server.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(mcpServer?: unknown) {
  const ui = new TerminalController()
  return {
    context: { ui, mcpServer } as CliCommandContext,
    ui,
  }
}

test('McpServerCommand reports an unavailable server', async () => {
  const { context, ui } = createContext()

  await McpServerCommand.execute(context, [])

  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server is unavailable.')
})

test('McpServerCommand starts, stops, and reports failures', async () => {
  const calls: string[] = []
  const { context, ui } = createContext({
    start: async () => calls.push('start'),
    stop: async () => calls.push('stop'),
    status: () => ({ running: true, address: null, auth: false }),
  })

  await McpServerCommand.execute(context, ['start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server started.')
  await McpServerCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server stopped.')
  assert.deepEqual(calls, ['start', 'stop'])

  const failed = createContext({
    start: async () => {
      throw new Error('start failed')
    },
    stop: async () => {
      throw new Error('stop failed')
    },
  })
  await McpServerCommand.execute(failed.context, ['start'])
  assert.equal(latestTimelineEntry(failed.ui)?.body, 'start failed')
  await McpServerCommand.execute(failed.context, ['stop'])
  assert.equal(latestTimelineEntry(failed.ui)?.body, 'stop failed')
})

test('McpServerCommand warns but allows an unauthenticated non-loopback listener', async () => {
  const { context, ui } = createContext({
    start: async () => {},
    status: () => ({
      running: true,
      address: 'http://0.0.0.0:8788/mcp',
      auth: false,
    }),
  })

  await McpServerCommand.execute(context, ['start'])

  assert.equal(latestTimelineEntry(ui)?.tone, 'warning')
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Authentication is disabled on a non-loopback listener.'
  )
})

test('McpServerCommand renders exact tokens, status, and help', async () => {
  let token: string | null = null
  const { context, ui } = createContext({
    token: () => token,
    status: () => ({
      running: true,
      address: 'http://127.0.0.1:8788/mcp',
      auth: true,
    }),
  })

  await McpServerCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')
  token = ''
  await McpServerCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')
  token = '   '
  await McpServerCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, '   ')

  await McpServerCommand.execute(context, ['status'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    [
      'Running: yes',
      'Address: http://127.0.0.1:8788/mcp',
      'Authentication: enabled',
    ].join('\n')
  )

  await McpServerCommand.execute(context, ['unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Subcommands:/)
})
