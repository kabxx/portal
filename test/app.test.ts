import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GROK_PROVIDER_PROMPT,
  canRunCommandWhileThreadBusy,
  clearInteractiveTerminal,
  clearTerminalBeforeRender,
  closeWithTimeout,
  showPendingThreadTimeline,
  transitionLoginWaitWarning,
} from '../src/app.ts'
import { TerminalController } from '../src/terminal-ui/terminal-controller.ts'
import { ThreadManager } from '../src/threads/thread-manager.ts'
import { createFakeRuntime } from './helpers/fakes.ts'

test('transitionLoginWaitWarning renders only when entering login wait', () => {
  assert.deepEqual(transitionLoginWaitWarning(false, true), {
    waitingForLogin: true,
    shouldRender: true,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, true), {
    waitingForLogin: true,
    shouldRender: false,
  })
  assert.deepEqual(transitionLoginWaitWarning(true, false), {
    waitingForLogin: false,
    shouldRender: true,
  })
})

test('closeWithTimeout returns when a close operation hangs', async () => {
  await closeWithTimeout(async () => {
    await new Promise(() => {})
  }, 10)
})

test('clearInteractiveTerminal clears only interactive output in order', () => {
  const events: string[] = []
  const inkApp = {
    clear: () => events.push('ink-clear'),
  }
  const output = {
    isTTY: true,
    write: (data: string) => {
      events.push(data)
    },
  }

  clearInteractiveTerminal(inkApp, output)

  assert.deepEqual(events, ['ink-clear', '\u001B[2J\u001B[3J\u001B[H'])

  events.length = 0
  clearInteractiveTerminal(inkApp, { ...output, isTTY: false })
  assert.deepEqual(events, [])
})

test('clearTerminalBeforeRender writes only to an interactive terminal', () => {
  const events: string[] = []
  const output = {
    isTTY: true,
    write: (data: string) => {
      events.push(data)
    },
  }

  clearTerminalBeforeRender(output)
  clearTerminalBeforeRender({ ...output, isTTY: false })

  assert.deepEqual(events, ['\u001B[2J\u001B[3J\u001B[H'])
})

test('Grok provider prompt defines a strict Tool boundary', () => {
  assert.match(GROK_PROVIDER_PROMPT, /^# Grok Tool Boundary/)
  assert.match(GROK_PROVIDER_PROMPT, /The "Tools" section/)
  assert.match(GROK_PROVIDER_PROMPT, /exactly one raw valid <tool>/)
  assert.doesNotMatch(GROK_PROVIDER_PROMPT, /Runtime Capabilities|Host Tool/)
})

test('busy threads allow navigation and queries but reject runtime mutations', () => {
  for (const input of [
    '/help',
    '/thread switch t-2',
    '/thread close t-1',
    '/thread open gemini',
    '/thread status',
    '/mcp list',
    '/mcp resource list',
    '/skill list',
    '/job',
    '/job stop job-1',
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

test('pending thread initialization uses its own timeline and restores the previous thread on failure', () => {
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

test('successful pending thread initialization keeps its isolated timeline', () => {
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
