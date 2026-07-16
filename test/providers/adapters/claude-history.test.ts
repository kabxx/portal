import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ClaudeAdapter,
  buildClaudeHistoryResult,
  type ClaudeHistoryCellSnapshot,
} from '../../../src/providers/adapters/adapter-claude.ts'
import type { ProviderTimingOptions } from '../../../src/providers/adapters/adapter-base.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

type ClaudeHistoryAction = 'bottom' | 'previous' | 'current'

interface ClaudeHistoryViewportSnapshot {
  cells: ClaudeHistoryCellSnapshot[]
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
}

class ClaudeHistoryTestAdapter extends ClaudeAdapter {
  public finishHistoryCaptureCalls = 0

  protected override async init(): Promise<void> {
    this.page = await this.context.newPage()
  }

  public override async finishHistoryCapture(): Promise<void> {
    this.finishHistoryCaptureCalls += 1
  }
}

async function createHistoryAdapter(
  readHistoryViewport: (
    action: ClaudeHistoryAction
  ) => ClaudeHistoryViewportSnapshot,
  historyLoadTimeoutMs: number,
  historyPageTimeoutMs: number
): Promise<ClaudeHistoryTestAdapter> {
  const page = {
    evaluate: (
      _pageFunction: unknown,
      action: ClaudeHistoryAction
    ): Promise<ClaudeHistoryViewportSnapshot> =>
      Promise.resolve(readHistoryViewport(action)),
  }
  return await ClaudeHistoryTestAdapter.create(
    createBrowserContextStub({ newPage: async () => page }),
    {
      timings: historyTimings(historyLoadTimeoutMs, historyPageTimeoutMs),
    }
  )
}

function historyTimings(
  historyLoadTimeoutMs: number,
  historyPageTimeoutMs: number
): ProviderTimingOptions {
  return {
    requestStartWarningAfterMs: 1,
    blockedWarningIntervalMs: 1,
    responseStartTimeoutMs: 1,
    responseStallTimeoutMs: 1,
    restoreTimeoutMs: 1,
    historyLoadTimeoutMs,
    historyPageTimeoutMs,
  }
}

test('Claude history waits for delayed virtual cells before collecting', async () => {
  let bottomCalls = 0
  const loadedCell = cell(0, [
    user('Question'),
    assistant('Answer', '<p>Answer</p>'),
  ])
  const adapter = await createHistoryAdapter(
    (action) => {
      if (action === 'bottom') bottomCalls += 1
      const ready = action !== 'bottom' || bottomCalls > 1
      return {
        cells: ready ? [loadedCell] : [],
        scrollTop: 0,
        scrollHeight: ready ? 100 : 0,
        clientHeight: ready ? 100 : 0,
        atBottom: ready,
      }
    },
    2000,
    400
  )

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.equal(result.messages.length, 2)
  assert.ok(bottomCalls >= 5)
  assert.equal(adapter.finishHistoryCaptureCalls, 1)
})

test('Claude history keeps watching a nonempty bottom for a delayed terminal cell', async () => {
  const firstCell = cell(0, [user('Question')])
  const secondCell = cell(1, [assistant('Answer', '<p>Answer</p>')])
  let bottomCalls = 0
  const adapter = await createHistoryAdapter(
    (action) => {
      if (action === 'bottom') bottomCalls += 1
      const cells = bottomCalls >= 6 ? [firstCell, secondCell] : [firstCell]
      return {
        cells,
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
        atBottom: true,
      }
    },
    2000,
    750
  )

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.equal(result.messages.length, 2)
  assert.ok(bottomCalls >= 6)
})

test('Claude history waits for virtual cells to update after scrolling', async () => {
  const firstCell = cell(0, [user('Question')])
  const secondCell = cell(1, [assistant('Answer', '<p>Answer</p>')])
  let scrolled = false
  const adapter = await createHistoryAdapter(
    (action) => {
      if (action === 'previous') scrolled = true
      const cells =
        scrolled && action === 'current'
          ? [firstCell, secondCell]
          : [secondCell]
      return {
        cells,
        scrollTop: action === 'previous' || scrolled ? 0 : 100,
        scrollHeight: 200,
        clientHeight: 100,
        atBottom: action === 'bottom',
      }
    },
    2000,
    500
  )

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.equal(result.messages.length, 2)
})

test('Claude history filters setup before building a complete parent chain', () => {
  const result = buildClaudeHistoryResult(
    [
      cell(0, [
        user(
          '# System\n\n# Setup Handshake\n- Reply with READY when initialization is complete.'
        ),
        assistant('READY.', '<p>READY.</p>'),
      ]),
      cell(1, [
        user('Explain the result.'),
        assistant(
          'The result is important.',
          '<div><p>The result is <strong>important</strong>.</p></div>'
        ),
      ]),
    ],
    1,
    'conversation-1'
  )

  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(result.messages, [
    {
      id: 'claude-conversation-1-1-0',
      parentId: null,
      role: 'user',
      text: 'Explain the result.',
      format: 'plain',
      createdAt: null,
    },
    {
      id: 'claude-conversation-1-1-1',
      parentId: 'claude-conversation-1-1-0',
      role: 'assistant',
      text: 'The result is **important**.',
      format: 'markdown',
      createdAt: null,
    },
  ])
})

test('Claude history rejects a missing virtual cell', () => {
  const result = buildClaudeHistoryResult(
    [cell(0, [user('one'), assistant('two', '<p>two</p>')])],
    1,
    'conversation-1'
  )

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /virtual cell 1 was not loaded/)
})

test('Claude history rejects conflicting snapshots for one virtual cell', () => {
  const result = buildClaudeHistoryResult(
    [
      cell(0, [user('one'), assistant('two', '<p>two</p>')]),
      cell(0, [user('changed'), assistant('two', '<p>two</p>')]),
    ],
    0,
    'conversation-1'
  )

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /conflicting virtual conversation cells/)
})

test('Claude history rejects unknown articles and broken role order', () => {
  const unknown = buildClaudeHistoryResult(
    [cell(0, [{ role: 'unknown', text: '', html: null }])],
    0,
    'conversation-1'
  )
  const brokenRoles = buildClaudeHistoryResult(
    [cell(0, [assistant('answer', '<p>answer</p>')])],
    0,
    'conversation-1'
  )

  assert.equal(unknown.complete, false)
  assert.match(unknown.warning ?? '', /unrecognized or empty message article/)
  assert.equal(brokenRoles.complete, false)
  assert.match(brokenRoles.warning ?? '', /complete conversation branch/)
})

function cell(
  index: number,
  articles: ClaudeHistoryCellSnapshot['articles']
): ClaudeHistoryCellSnapshot {
  return { index, articles }
}

function user(text: string): ClaudeHistoryCellSnapshot['articles'][number] {
  return { role: 'user', text, html: null }
}

function assistant(
  text: string,
  html: string
): ClaudeHistoryCellSnapshot['articles'][number] {
  return { role: 'assistant', text, html }
}
