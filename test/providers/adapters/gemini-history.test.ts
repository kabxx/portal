import assert from 'node:assert/strict'
import test from 'node:test'

import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'

const HISTORY_URL =
  'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb'

function historyBody(
  responseId: string,
  cursor: string | null,
  question: string,
  answer: string,
  createdAt: number
): string {
  const payload = [
    [
      [
        ['conversation', responseId],
        null,
        [[question]],
        [[['candidate', [answer]]]],
        [createdAt],
      ],
    ],
    cursor,
    null,
    null,
  ]
  return `)]}'\n${JSON.stringify([
    ['wrb.fr', 'hNvQHb', JSON.stringify(payload), null],
  ])}`
}

function entry(id: number, body: string) {
  return {
    id,
    url: HISTORY_URL,
    method: 'POST',
    status: 200,
    chunks: [body],
    done: true,
    error: null,
  }
}

test('GeminiAdapter.loadHistory scrolls until the continuation cursor is exhausted', async () => {
  const adapter = Object.create(GeminiAdapter.prototype) as any
  const first = entry(
    1,
    historyBody('new-response', 'older-page', 'new question', 'new answer', 200)
  )
  const second = entry(
    2,
    historyBody('old-response', null, 'old question', 'old answer', 100)
  )
  let scrollCalls = 0
  adapter.getCapturedHistoryEntries = async () =>
    scrollCalls === 0 ? [first] : [first, second]
  adapter.page = {
    evaluate: async () => {
      scrollCalls += 1
      return true
    },
  }

  const result = await adapter.loadHistory()

  assert.equal(scrollCalls, 1)
  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(
    result.messages.map((message: { text: string }) => message.text),
    ['old question', 'old answer', 'new question', 'new answer']
  )
})
