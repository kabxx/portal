import test from 'node:test'
import assert from 'node:assert/strict'

import { parseQwenHistory } from '../../src/providers/conversation-history.ts'

function qwenHistory(overrides: Record<string, unknown> = {}): string {
  const value = qwenHistoryValue()
  Object.assign(value.data.chat.history, overrides)
  return JSON.stringify(value)
}

function qwenHistoryValue() {
  return {
    data: {
      chat: {
        history: {
          messages: {
            user: {
              id: 'user',
              role: 'user',
              content: 'Question',
              parentId: null,
              childrenIds: ['assistant'],
              error: null,
              timestamp: 1_700_000_000,
            },
            assistant: {
              id: 'assistant',
              role: 'assistant',
              content: 'Answer',
              content_list: [
                {
                  phase: 'thinking_summary',
                  content: 'Hidden reasoning',
                  status: 'finished',
                },
                { phase: 'answer', content: 'Answer', status: 'finished' },
              ],
              parentId: 'user',
              childrenIds: [] as string[],
              done: true,
              error: null,
              timestamp: 1_700_000_001,
            },
          },
          currentId: 'assistant',
          currentResponseIds: ['assistant'],
        },
      },
    },
  }
}

test('parseQwenHistory returns the complete active branch without thinking text', () => {
  assert.deepEqual(parseQwenHistory(qwenHistory()), {
    messages: [
      {
        id: 'user',
        parentId: null,
        role: 'user',
        text: 'Question',
        format: 'plain',
        createdAt: 1_700_000_000_000,
      },
      {
        id: 'assistant',
        parentId: 'user',
        role: 'assistant',
        text: 'Answer',
        format: 'markdown',
        createdAt: 1_700_000_001_000,
      },
    ],
    complete: true,
    warning: null,
  })
})

test('parseQwenHistory marks ambiguous or unfinished responses incomplete', () => {
  const raw = qwenHistoryValue()
  raw.data.chat.history.currentResponseIds = ['assistant', 'other']
  raw.data.chat.history.messages.assistant.done = false

  const result = parseQwenHistory(JSON.stringify(raw))

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /unambiguous current response/)
  assert.match(result.warning ?? '', /unfinished or failed assistant response/)
})

test('parseQwenHistory rejects missing active-branch edges and unsupported content', () => {
  const raw = qwenHistoryValue()
  raw.data.chat.history.messages.user.childrenIds = []
  raw.data.chat.history.messages.assistant.content_list = [
    { phase: 'thinking_summary', content: 'Hidden', status: 'finished' },
  ]

  const result = parseQwenHistory(JSON.stringify(raw))

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /inconsistent parent-child edge/)
  assert.match(result.warning ?? '', /without supported text content/)
})

test('parseQwenHistory rejects invalid ids and missing graphs', () => {
  assert.equal(parseQwenHistory('{}').complete, false)
  assert.match(parseQwenHistory('{}').warning ?? '', /history graph/)

  const raw = qwenHistoryValue()
  raw.data.chat.history.messages.user.id = 'different'
  assert.match(
    parseQwenHistory(JSON.stringify(raw)).warning ?? '',
    /invalid or duplicate message id/
  )
})
