import assert from 'node:assert/strict'
import test from 'node:test'

import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'

function historyPage(index: number, hasMore: boolean): string {
  return JSON.stringify({
    downlink_body: {
      pull_singe_chain_downlink_body: {
        has_more: hasMore,
        messages: [
          {
            message_id: String(index),
            index_in_conv: String(index),
            user_type: index % 2 === 0 ? 2 : 1,
            content_block: [
              { content: { text_block: { text: `message ${index}` } } },
            ],
          },
        ],
      },
    },
  })
}

test('DoubaoAdapter.loadHistory continues beyond three pages until has_more is false', async () => {
  const adapter = Object.create(DoubaoAdapter.prototype) as any
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    url: 'https://www.doubao.com/im/chain/single',
    method: 'POST',
    status: 200,
    chunks: [historyPage(index + 1, index < 4)],
    done: true,
    error: null,
  }))
  let scrollCalls = 0
  adapter.getCapturedHistoryEntries = async () =>
    entries.slice(0, scrollCalls + 1)
  adapter.page = {
    evaluate: async () => {
      scrollCalls += 1
      return true
    },
  }

  const result = await adapter.loadHistory()

  assert.equal(scrollCalls, 4)
  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(
    result.messages.map((message: { text: string }) => message.text),
    ['message 1', 'message 2', 'message 3', 'message 4', 'message 5']
  )
})
