import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canRunCommandWhileThreadBusy,
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  shouldRenderFallbackThreadError,
  showPendingThreadTimeline,
} from '../../src/app/terminal-lifecycle.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

test('interactive terminal clearing preserves operation order', () => {
  const events: string[] = []
  const inkApp = { clear: () => events.push('ink-clear') }
  const output = {
    isTTY: true,
    write: (data: string) => void events.push(data),
  }

  clearInteractiveTerminal(inkApp, output)
  assert.deepEqual(events, ['ink-clear', '\u001B[2J\u001B[3J\u001B[H'])

  events.length = 0
  clearInteractiveTerminal(inkApp, { ...output, isTTY: false })
  assert.deepEqual(events, [])
})

test('terminal clears before render only when interactive', () => {
  const events: string[] = []
  const output = {
    isTTY: true,
    write: (data: string) => void events.push(data),
  }

  clearTerminalBeforeRender(output)
  clearTerminalBeforeRender({ ...output, isTTY: false })

  assert.deepEqual(events, ['\u001B[2J\u001B[3J\u001B[H'])
})

test('busy threads allow navigation and queries but reject runtime mutations', () => {
  for (const input of [
    '/help',
    '/thread switch t-2',
    '/thread close t-1',
    '/thread agent gemini',
    '/thread chat gemini',
    '/thread status',
    '/mcp list',
    '/mcp resource list',
    '/serve',
    '/serve api start',
    '/serve api status',
    '/serve api stop',
    '/serve api token',
    '/serve mcp start',
    '/serve mcp status',
    '/serve mcp stop',
    '/serve mcp token',
    '/skill list',
    '/job',
    '/job stop j-1',
    '/keybinding reset',
    '/exit',
  ]) {
    assert.equal(canRunCommandWhileThreadBusy(input), true, input)
  }

  for (const input of [
    '/thread capability thinking on',
    '/mcp resource attach server uri',
    '/mcp prompt attach server prompt',
    '/skill add ./skill',
    '/unknown',
    '/thread reload',
  ]) {
    assert.equal(canRunCommandWhileThreadBusy(input), false, input)
  }
})

test('fallback thread error avoids duplicate turn errors', () => {
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: false,
      showFallbackError: true,
    }),
    true
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: true,
      showFallbackError: true,
    }),
    false
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: false,
      showFallbackError: false,
    }),
    false
  )
  assert.equal(
    shouldRenderFallbackThreadError({
      turnErrorRendered: true,
      showFallbackError: false,
    }),
    false
  )
})

test('pending thread timeline restores the previous thread on failure', () => {
  const manager = new ThreadManager()
  const first = manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)
  ui.showThreadTimeline(first.id)
  ui.renderInfo('thread', 'existing a output')

  const pending = showPendingThreadTimeline(ui, manager, 't-pending')
  ui.renderWarning('login wait', 'pending thread warning')
  assert.equal(ui.getState().timeline.at(-1)?.body, 'pending thread warning')
  pending.discard()

  assert.equal(manager.getActiveThread()?.id, first.id)
  assert.equal(ui.getState().timeline.at(-1)?.body, 'existing a output')
  assert.equal(
    ui
      .getState()
      .timeline.some(({ body }) => body === 'pending thread warning'),
    false
  )
})

test('successful pending thread timeline keeps its isolated output', () => {
  const manager = new ThreadManager()
  manager.addThread({
    id: 't-a',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const ui = new TerminalController()
  ui.bindThreadManager(manager)

  const pending = showPendingThreadTimeline(ui, manager, 't-b')
  ui.renderWarning('MCP', 'warning for b')
  const second = manager.addThread({
    id: 't-b',
    provider: 'gemini',
    runtime: createFakeRuntime(),
    createdAt: 2,
  })
  pending.keep()
  ui.showThreadTimeline(second.id)

  assert.equal(ui.getState().timeline.at(-1)?.body, 'warning for b')
})
