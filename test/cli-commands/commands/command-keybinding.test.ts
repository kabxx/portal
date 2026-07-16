import test from 'node:test'
import assert from 'node:assert/strict'

import { KeybindingCommand } from '../../../src/cli-commands/commands/command-keybinding.ts'
import type { CliCommandContext } from '../../../src/cli-commands/core/command-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(reset?: () => Promise<unknown>) {
  const ui = new TerminalController()
  return {
    context: {
      ui,
      keybindingCatalog: reset === undefined ? undefined : { reset },
    } as CliCommandContext,
    ui,
  }
}

test('KeybindingCommand requires the reset action', async () => {
  const { context, ui } = createContext(async () => undefined)
  await KeybindingCommand.execute(context, [])
  assert.equal(latestTimelineEntry(ui)?.body, 'Usage: /keybinding reset')
})

test('KeybindingCommand resets and reports success', async () => {
  let calls = 0
  const { context, ui } = createContext(async () => {
    calls += 1
  })
  await KeybindingCommand.execute(context, ['reset'])
  assert.equal(calls, 1)
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Restored platform-default keybindings.'
  )
})

test('KeybindingCommand reports unavailable catalogs and reset failures', async () => {
  const unavailable = createContext()
  await KeybindingCommand.execute(unavailable.context, ['reset'])
  assert.equal(
    latestTimelineEntry(unavailable.ui)?.body,
    'Keybindings are not configured.'
  )

  const failed = createContext(async () => {
    throw new Error('cannot write config')
  })
  await KeybindingCommand.execute(failed.context, ['reset'])
  assert.equal(latestTimelineEntry(failed.ui)?.body, 'cannot write config')
})
