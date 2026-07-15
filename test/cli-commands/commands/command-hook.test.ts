import test from 'node:test'
import assert from 'node:assert/strict'

import { HookCommand } from '../../../src/cli-commands/commands/command-hook.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(hookCatalog?: unknown) {
  const ui = new TerminalController()
  return {
    context: { ui, hookCatalog } as CliCommandContext,
    ui,
  }
}

test('HookCommand reports unavailable Hooks', async () => {
  const { context, ui } = createContext()

  await HookCommand.execute(context, [])

  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'Hooks are not configured.')
})

test('HookCommand renders status by default', async () => {
  const { context, ui } = createContext({
    status: () => ({
      enabled: true,
      activeHandlers: 2,
      handlers: 3,
      revision: 'revision-1',
      loadedAt: 0,
    }),
  })

  await HookCommand.execute(context, [])

  assert.equal(
    latestTimelineEntry(ui)?.body,
    [
      'Hooks: enabled',
      'Handlers: 2/3 active',
      'Revision: revision-1',
      'Loaded: 1970-01-01T00:00:00.000Z',
    ].join('\n')
  )
})

test('HookCommand reloads and toggles Hooks for new turns', async () => {
  const toggles: boolean[] = []
  const { context, ui } = createContext({
    reload: async () => ({ handlers: [{ name: 'audit' }] }),
    setEnabled: async (enabled: boolean) => {
      toggles.push(enabled)
      return { enabled }
    },
  })

  await HookCommand.execute(context, ['reload'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Loaded 1 Hook handlers for new turns.'
  )

  await HookCommand.execute(context, ['enable'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Hooks are enabled for new turns.'
  )

  await HookCommand.execute(context, ['disable'])
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Hooks are disabled for new turns.'
  )
  assert.deepEqual(toggles, [true, false])
})

test('HookCommand reports unknown actions and operation failures', async () => {
  const { context, ui } = createContext({
    reload: async () => {
      throw new Error('reload failed')
    },
    setEnabled: async () => {
      throw 'toggle failed'
    },
  })

  await HookCommand.execute(context, ['unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Usage: \/hook/)

  await HookCommand.execute(context, ['reload'])
  assert.equal(latestTimelineEntry(ui)?.body, 'reload failed')

  await HookCommand.execute(context, ['enable'])
  assert.equal(latestTimelineEntry(ui)?.body, 'toggle failed')
})
