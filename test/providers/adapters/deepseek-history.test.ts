import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CapturedFetchEntry,
  ProviderAdapterCreateOptions,
} from '../../../src/providers/adapters/adapter-base.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const HISTORY_URL =
  'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=conversation&cache_version=7&cache_reset_at=8'

function historyBody(cacheControl: 'MERGE' | 'REPLACE', count: number): string {
  return JSON.stringify({
    data: {
      biz_data: {
        cache_control: cacheControl,
        chat_messages: Array.from({ length: count }, (_, index) => {
          const role = index % 2 === 0 ? 'USER' : 'ASSISTANT'
          return {
            message_id: index + 1,
            parent_id: index === 0 ? null : index,
            role,
            inserted_at: index + 1,
            fragments: [
              {
                type: role === 'USER' ? 'REQUEST' : 'RESPONSE',
                content: `message ${index + 1}`,
              },
            ],
          }
        }),
      },
    },
  })
}

interface DeepSeekHistoryReplayPayload {
  url: string
  headers: Record<string, string>
}

interface DeepSeekHistoryReplayResult {
  body: string
  ok: boolean
  status: number
}

interface DeepSeekHistoryPage {
  evaluate(
    pageFunction: unknown,
    payload?: DeepSeekHistoryReplayPayload
  ): Promise<DeepSeekHistoryReplayResult>
}

class TestDeepSeekAdapter extends DeepSeekAdapter {
  public constructor(
    private readonly historyBodyValue: string,
    options: ProviderAdapterCreateOptions = {}
  ) {
    super(createBrowserContextStub(), options)
  }

  protected override async getCapturedHistoryEntries(): Promise<
    CapturedFetchEntry[]
  > {
    return [
      {
        id: 1,
        url: HISTORY_URL,
        method: 'GET',
        status: 200,
        chunks: [this.historyBodyValue],
        done: true,
        error: null,
      },
    ]
  }

  protected override async getCapturedHistoryRequestHeaders(): Promise<
    Record<string, string>
  > {
    return {
      authorization: 'Bearer secret',
      cookie: 'private-cookie',
      'x-app-version': '1',
    }
  }
}

function installDeepSeekHistoryPage(
  adapter: TestDeepSeekAdapter,
  page: DeepSeekHistoryPage
): void {
  if (!Reflect.set(adapter, 'page', page)) {
    throw new Error('Failed to install the DeepSeek history test page.')
  }
}

test('DeepSeekAdapter.loadHistory replaces a nonempty MERGE delta with the full REPLACE snapshot', async () => {
  const adapter = new TestDeepSeekAdapter(historyBody('MERGE', 2))
  const replayPayloads: DeepSeekHistoryReplayPayload[] = []
  installDeepSeekHistoryPage(adapter, {
    evaluate: async (_callback, payload) => {
      assert.ok(payload !== undefined)
      replayPayloads.push(payload)
      return {
        body: historyBody('REPLACE', 6),
        ok: true,
        status: 200,
      }
    },
  })

  const result = await adapter.loadHistory()

  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.equal(result.messages.length, 6)
  const replayPayload = replayPayloads[0]
  assert.ok(replayPayload !== undefined)
  const replayUrl = new URL(replayPayload.url)
  assert.equal(replayUrl.searchParams.get('chat_session_id'), 'conversation')
  assert.equal(replayUrl.searchParams.has('cache_version'), false)
  assert.equal(replayUrl.searchParams.has('cache_reset_at'), false)
  assert.deepEqual(replayPayload.headers, {
    authorization: 'Bearer secret',
    'x-app-version': '1',
  })
})

test('DeepSeekAdapter.loadHistory reports a partial delta when the full replay fails', async () => {
  const adapter = new TestDeepSeekAdapter(historyBody('MERGE', 2))
  installDeepSeekHistoryPage(adapter, {
    evaluate: async () => {
      throw new Error('network failed')
    },
  })

  const result = await adapter.loadHistory()

  assert.equal(result.complete, false)
  assert.equal(result.messages.length, 2)
  assert.match(result.warning ?? '', /full-history request failed/)
})

test('DeepSeekAdapter.loadHistory bounds the full replay with the configured timeout', async () => {
  const adapter = new TestDeepSeekAdapter(historyBody('MERGE', 2), {
    timings: {
      requestStartWarningAfterMs: 1,
      blockedWarningIntervalMs: 1,
      responseStartTimeoutMs: 1,
      responseStallTimeoutMs: 1,
      restoreTimeoutMs: 1,
      historyLoadTimeoutMs: 5,
      historyPageTimeoutMs: 1,
    },
  })
  let replayTimer: ReturnType<typeof setTimeout> | undefined
  installDeepSeekHistoryPage(adapter, {
    evaluate: async () =>
      await new Promise((resolve) => {
        replayTimer = setTimeout(
          () =>
            resolve({
              body: historyBody('REPLACE', 6),
              ok: true,
              status: 200,
            }),
          1_000
        )
      }),
  })

  try {
    const result = await adapter.loadHistory()

    assert.equal(result.complete, false)
    assert.equal(result.messages.length, 2)
    assert.match(result.warning ?? '', /full-history request timed out/)
  } finally {
    if (replayTimer !== undefined) clearTimeout(replayTimer)
  }
})
