import test from 'node:test'
import assert from 'node:assert/strict'

import { HookCommand } from '../../../src/cli-commands/commands/command-hook.ts'
import {
  createDefaultHooksConfig,
  createHookSnapshot,
} from '../../../src/hooks/hook-config.ts'
import { HookCatalog } from '../../../src/hooks/hook-catalog.ts'
import type { HookSnapshot } from '../../../src/hooks/hook-types.ts'
import { TerminalController } from '../../../src/terminal-ui/terminal-controller.ts'
import { createCliCommandContext } from '../../helpers/cli-command-context.ts'
import { latestTimelineEntry } from '../../helpers/ui.ts'

function createContext(hookCatalog?: HookCatalog) {
  const ui = new TerminalController()
  const { context, cleanup } = createCliCommandContext({
    ui,
    ...(hookCatalog === undefined ? {} : { hookCatalog }),
  })
  return {
    cleanup,
    context,
    ui,
  }
}

function createHookCatalog(): HookCatalog {
  return new HookCatalog(
    'test-data/config.yaml',
    createHookSnapshot(createDefaultHooksConfig())
  )
}

function createSnapshotWithAuditHandler(enabled = true): HookSnapshot {
  return createHookSnapshot({
    enabled,
    maxDepth: 1,
    handlers: [
      {
        name: 'audit',
        enabled: true,
        type: 'command',
        events: ['turn.completed'],
        match: {},
        timeoutMs: 5_000,
        onError: 'continue',
        command: ['audit'],
      },
    ],
  })
}

test('HookCommand reports unavailable Hooks', async (t) => {
  const { cleanup, context, ui } = createContext()
  t.after(cleanup)

  await HookCommand.execute(context, [])

  assert.equal(latestTimelineEntry(ui)?.tone, 'error')
  assert.equal(latestTimelineEntry(ui)?.body, 'Hooks are not configured.')
})

test('HookCommand renders status by default', async (t) => {
  const hookCatalog = createHookCatalog()
  hookCatalog.status = () => ({
    enabled: true,
    activeHandlers: 2,
    handlers: 3,
    revision: 'revision-1',
    loadedAt: 0,
  })
  const { cleanup, context, ui } = createContext(hookCatalog)
  t.after(cleanup)

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

test('HookCommand reloads and toggles Hooks for new turns', async (t) => {
  const toggles: boolean[] = []
  const hookCatalog = createHookCatalog()
  hookCatalog.reload = async () => createSnapshotWithAuditHandler()
  hookCatalog.setEnabled = async (enabled) => {
    toggles.push(enabled)
    return createSnapshotWithAuditHandler(enabled)
  }
  const { cleanup, context, ui } = createContext(hookCatalog)
  t.after(cleanup)

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

test('HookCommand reports unknown actions and operation failures', async (t) => {
  const hookCatalog = createHookCatalog()
  hookCatalog.reload = async () => {
    throw new Error('reload failed')
  }
  hookCatalog.setEnabled = async () => {
    throw new Error('toggle failed')
  }
  const { cleanup, context, ui } = createContext(hookCatalog)
  t.after(cleanup)

  await HookCommand.execute(context, ['unknown'])
  assert.match(latestTimelineEntry(ui)?.body ?? '', /Usage: \/hook/)

  await HookCommand.execute(context, ['reload'])
  assert.equal(latestTimelineEntry(ui)?.body, 'reload failed')

  await HookCommand.execute(context, ['enable'])
  assert.equal(latestTimelineEntry(ui)?.body, 'toggle failed')
})
