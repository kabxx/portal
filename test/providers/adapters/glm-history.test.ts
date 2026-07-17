import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapturedFetchEntry } from '../../../src/providers/adapters/adapter-base.ts'
import { GlmAdapter } from '../../../src/providers/adapters/adapter-glm.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

interface GlmHistoryPage {
  evaluate(pageFunction: unknown): Promise<boolean>
}

class TestGlmAdapter extends GlmAdapter {
  public constructor(
    private readonly readEntries: (
      predicate: (entry: CapturedFetchEntry) => boolean
    ) => CapturedFetchEntry[]
  ) {
    super(createBrowserContextStub())
  }

  protected override async getCapturedHistoryEntries(
    predicate: (entry: CapturedFetchEntry) => boolean
  ): Promise<CapturedFetchEntry[]> {
    return this.readEntries(predicate)
  }
}

function installGlmHistoryPage(
  adapter: TestGlmAdapter,
  page: GlmHistoryPage
): void {
  if (!Reflect.set(adapter, 'page', page)) {
    throw new Error('Failed to install the GLM history test page.')
  }
}

function batchEntry(id: number, data: Record<string, unknown>) {
  return {
    id,
    url: 'https://chat.z.ai/api/v1/messages/batch',
    method: 'POST',
    status: 200,
    chunks: [JSON.stringify({ data })],
    done: true,
    error: null,
  }
}

test('GlmAdapter.loadHistory merges batches until currentId reaches the root', async () => {
  const metadataEntry = {
    id: 1,
    url: 'https://chat.z.ai/api/v1/chats/conversation',
    method: 'GET',
    status: 200,
    chunks: [
      JSON.stringify({ chat: { history: { currentId: 'a3', messages: {} } } }),
    ],
    done: true,
    error: null,
  }
  const batches = [
    batchEntry(2, {
      u3: { id: 'u3', parentId: 'a2', role: 'user', content: 'question 3' },
      a3: { id: 'a3', parentId: 'u3', role: 'assistant', content: 'answer 3' },
    }),
    batchEntry(3, {
      u2: { id: 'u2', parentId: 'a1', role: 'user', content: 'question 2' },
      a2: { id: 'a2', parentId: 'u2', role: 'assistant', content: 'answer 2' },
    }),
    batchEntry(4, {
      u1: { id: 'u1', parentId: null, role: 'user', content: 'question 1' },
      a1: { id: 'a1', parentId: 'u1', role: 'assistant', content: 'answer 1' },
    }),
  ]
  let scrollCalls = 0
  const adapter = new TestGlmAdapter((predicate) =>
    predicate(metadataEntry)
      ? [metadataEntry]
      : batches.slice(0, scrollCalls + 1)
  )
  installGlmHistoryPage(adapter, {
    evaluate: async () => {
      scrollCalls += 1
      return true
    },
  })

  const result = await adapter.loadHistory()

  assert.equal(scrollCalls, 2)
  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(
    result.messages.map((message: { text: string }) => message.text),
    [
      'question 1',
      'answer 1',
      'question 2',
      'answer 2',
      'question 3',
      'answer 3',
    ]
  )
})
