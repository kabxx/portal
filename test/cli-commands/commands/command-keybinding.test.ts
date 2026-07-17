import test from 'node:test'
import assert from 'node:assert/strict'

import { KeybindingCommand } from '../../../src/cli-commands/commands/command-keybinding.ts'
import {
  createDefaultKeybindings,
  createKeybindingSnapshot,
} from '../../../src/keybindings/keybinding-config.ts'
import { KeybindingCatalog } from '../../../src/keybindings/keybinding-catalog.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { createCliCommandContext } from '../../helpers/cli-command-context.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(reset?: () => Promise<void>) {
  const ui = new TerminalController()
  const defaults = createDefaultKeybindings(process.platform)
  const keybindingCatalog =
    reset === undefined
      ? undefined
      : new KeybindingCatalog('test-data/keybindings.json', defaults, () => {})
  if (keybindingCatalog !== undefined && reset !== undefined) {
    const resetKeybindings = reset
    keybindingCatalog.reset = async () => {
      await resetKeybindings()
      return createKeybindingSnapshot(defaults)
    }
  }
  const fixture = createCliCommandContext({
    ui,
    ...(keybindingCatalog === undefined ? {} : { keybindingCatalog }),
  })
  return {
    cleanup: () => {
      keybindingCatalog?.stop()
      fixture.cleanup()
    },
    context: fixture.context,
    ui,
  }
}

test('KeybindingCommand requires the reset action', async (t) => {
  const { cleanup, context, ui } = createContext(async () => undefined)
  t.after(cleanup)
  await KeybindingCommand.execute(context, [])
  assert.equal(latestTimelineEntry(ui)?.body, 'Usage: /keybinding reset')
})

test('KeybindingCommand resets and reports success', async (t) => {
  let calls = 0
  const { cleanup, context, ui } = createContext(async () => {
    calls += 1
  })
  t.after(cleanup)
  await KeybindingCommand.execute(context, ['reset'])
  assert.equal(calls, 1)
  assert.equal(
    latestTimelineEntry(ui)?.body,
    'Restored platform-default keybindings.'
  )
})

test('KeybindingCommand reports unavailable catalogs and reset failures', async (t) => {
  const unavailable = createContext()
  t.after(unavailable.cleanup)
  await KeybindingCommand.execute(unavailable.context, ['reset'])
  assert.equal(
    latestTimelineEntry(unavailable.ui)?.body,
    'Keybindings are not configured.'
  )

  const failed = createContext(async () => {
    throw new Error('cannot write config')
  })
  t.after(failed.cleanup)
  await KeybindingCommand.execute(failed.context, ['reset'])
  assert.equal(latestTimelineEntry(failed.ui)?.body, 'cannot write config')
})
