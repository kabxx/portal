import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapturedFetchEntry } from '../../../src/providers/adapters/adapter-base.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

interface DoubaoHistoryPage {
  evaluate(pageFunction: unknown): Promise<boolean>
}

class TestDoubaoAdapter extends DoubaoAdapter {
  public constructor(private readonly readEntries: () => CapturedFetchEntry[]) {
    super(createBrowserContextStub())
  }

  protected override async getCapturedHistoryEntries(): Promise<
    CapturedFetchEntry[]
  > {
    return this.readEntries()
  }
}

function installDoubaoHistoryPage(
  adapter: TestDoubaoAdapter,
  page: DoubaoHistoryPage
): void {
  if (!Reflect.set(adapter, 'page', page)) {
    throw new Error('Failed to install the Doubao history test page.')
  }
}

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
  const adapter = new TestDoubaoAdapter(() => entries.slice(0, scrollCalls + 1))
  installDoubaoHistoryPage(adapter, {
    evaluate: async () => {
      scrollCalls += 1
      return true
    },
  })

  const result = await adapter.loadHistory()

  assert.equal(scrollCalls, 4)
  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(
    result.messages.map((message: { text: string }) => message.text),
    ['message 1', 'message 2', 'message 3', 'message 4', 'message 5']
  )
})
