import test from 'node:test'
import assert from 'node:assert/strict'

import { ServeCommand } from '../../../src/cli-commands/commands/command-serve.ts'
import type { ListenerCommandController } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { createCliCommandContext } from '../../helpers/cli-command-context.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(
  controllers: {
    api?: ListenerCommandController
    mcpServer?: ListenerCommandController
  } = {}
) {
  const ui = new TerminalController()
  const { context, cleanup } = createCliCommandContext({ ui, ...controllers })
  return {
    cleanup,
    context,
    ui,
  }
}

function rejectWith(reason: unknown): Promise<never> {
  const { promise, reject } = Promise.withResolvers<never>()
  reject(reason)
  return promise
}

test('ServeCommand reports unavailable targets and target help', async (t) => {
  const { cleanup, context, ui } = createContext()
  t.after(cleanup)

  await ServeCommand.execute(context, [])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Listeners:/)

  await ServeCommand.execute(context, ['api', 'status'])
  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API is unavailable.')

  await ServeCommand.execute(context, ['mcp', 'status'])
  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server is unavailable.')
})

test('ServeCommand starts and stops both listener targets', async (t) => {
  const calls: string[] = []
  const controller = (target: string) => ({
    start: async () => {
      calls.push(`${target}:start`)
    },
    stop: async () => {
      calls.push(`${target}:stop`)
    },
    status: () => ({ running: true, address: null, auth: false }),
    token: () => null,
  })
  const { cleanup, context, ui } = createContext({
    api: controller('api'),
    mcpServer: controller('mcp'),
  })
  t.after(cleanup)

  assert.deepEqual(await ServeCommand.execute(context, ['api', 'start']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API server started.')

  assert.deepEqual(await ServeCommand.execute(context, ['api', 'stop']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API server stopped.')

  await ServeCommand.execute(context, ['mcp', 'start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server started.')

  await ServeCommand.execute(context, ['mcp', 'stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'MCP Server stopped.')
  assert.deepEqual(calls, ['api:start', 'api:stop', 'mcp:start', 'mcp:stop'])
})

test('ServeCommand warns but allows an unauthenticated non-loopback listener', async (t) => {
  const { cleanup, context, ui } = createContext({
    api: {
      start: async () => {},
      stop: async () => {},
      status: () => ({
        running: true,
        address: 'http://0.0.0.0:8787',
        auth: false,
      }),
      token: () => null,
    },
  })
  t.after(cleanup)

  await ServeCommand.execute(context, ['api', 'start'])

  assert.equal(latestTimelineEntry(ui)?.tone, 'warning')
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Authentication is disabled on a non-loopback listener.'
  )
})

test('ServeCommand reports start and stop failures', async (t) => {
  const failingController = {
    start: () => rejectWith(new Error('start failed')),
    stop: () => rejectWith('stop failed'),
    status: () => ({ running: false, address: null, auth: false }),
    token: () => null,
  }
  const { cleanup, context, ui } = createContext({
    api: failingController,
    mcpServer: failingController,
  })
  t.after(cleanup)

  assert.deepEqual(await ServeCommand.execute(context, ['api', 'start']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'start failed')

  assert.deepEqual(await ServeCommand.execute(context, ['api', 'stop']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'stop failed')

  assert.deepEqual(await ServeCommand.execute(context, ['mcp', 'start']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'start failed')

  assert.deepEqual(await ServeCommand.execute(context, ['mcp', 'stop']), {
    continue: true,
  })
  assert.equal(latestTimelineEntry(ui)?.body, 'stop failed')
})

test('ServeCommand renders token, status, and subcommand help', async (t) => {
  let token: string | null = null
  const { cleanup, context, ui } = createContext({
    api: {
      start: async () => {},
      stop: async () => {},
      token: () => token,
      status: () => ({
        running: true,
        address: 'http://127.0.0.1:3000',
        auth: true,
      }),
    },
  })
  t.after(cleanup)

  await ServeCommand.execute(context, ['api', 'token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')

  token = ''
  await ServeCommand.execute(context, ['api', 'token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')

  token = '   '
  await ServeCommand.execute(context, ['api', 'token'])
  assert.equal(latestTimelineEntry(ui)?.body, '   ')

  token = 'secret-token'
  await ServeCommand.execute(context, ['api', 'token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'secret-token')

  await ServeCommand.execute(context, ['api', 'status'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    [
      'Running: yes',
      'Address: http://127.0.0.1:3000',
      'Authentication: enabled',
    ].join('\n')
  )

  await ServeCommand.execute(context, ['api', 'unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Subcommands:/)
})
