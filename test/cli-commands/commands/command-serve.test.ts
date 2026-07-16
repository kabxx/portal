import test from 'node:test'
import assert from 'node:assert/strict'

import { ServeCommand } from '../../../src/cli-commands/commands/command-serve.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(api?: unknown) {
  const ui = new TerminalController()
  return {
    context: { ui, api } as CliCommandContext,
    ui,
  }
}

test('ServeCommand reports an unavailable API', async () => {
  const { context, ui } = createContext()

  await ServeCommand.execute(context, [])

  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API is unavailable.')
})

test('ServeCommand starts and stops the API', async () => {
  const calls: string[] = []
  const { context, ui } = createContext({
    start: async () => calls.push('start'),
    stop: async () => calls.push('stop'),
    status: () => ({ running: true, address: null, auth: false }),
  })

  await ServeCommand.execute(context, ['start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API server started.')

  await ServeCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'HTTP API server stopped.')
  assert.deepEqual(calls, ['start', 'stop'])
})

test('ServeCommand warns but allows an unauthenticated non-loopback listener', async () => {
  const { context, ui } = createContext({
    start: async () => {},
    status: () => ({
      running: true,
      address: 'http://0.0.0.0:8787',
      auth: false,
    }),
  })

  await ServeCommand.execute(context, ['start'])

  assert.equal(latestTimelineEntry(ui)?.tone, 'warning')
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Authentication is disabled on a non-loopback listener.'
  )
})

test('ServeCommand reports start and stop failures', async () => {
  const { context, ui } = createContext({
    start: async () => {
      throw new Error('start failed')
    },
    stop: async () => {
      throw new Error('stop failed')
    },
  })

  await ServeCommand.execute(context, ['start'])
  assert.equal(latestTimelineEntry(ui)?.body, 'start failed')

  await ServeCommand.execute(context, ['stop'])
  assert.equal(latestTimelineEntry(ui)?.body, 'stop failed')
})

test('ServeCommand renders token, status, and subcommand help', async () => {
  let token: string | null = null
  const { context, ui } = createContext({
    token: () => token,
    status: () => ({
      running: true,
      address: 'http://127.0.0.1:3000',
      auth: true,
    }),
  })

  await ServeCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')

  token = ''
  await ServeCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'Authentication disabled.')

  token = '   '
  await ServeCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, '   ')

  token = 'secret-token'
  await ServeCommand.execute(context, ['token'])
  assert.equal(latestTimelineEntry(ui)?.body, 'secret-token')

  await ServeCommand.execute(context, ['status'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    [
      'Running: yes',
      'Address: http://127.0.0.1:3000',
      'Authentication: enabled',
    ].join('\n')
  )

  await ServeCommand.execute(context, ['unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Subcommands:/)
})
