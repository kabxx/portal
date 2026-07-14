import assert from 'node:assert/strict'
import test from 'node:test'

import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'

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

function stubCapturedHistory(adapter: any, body: string): void {
  adapter.getCapturedHistoryEntries = async () => [
    {
      id: 1,
      url: HISTORY_URL,
      method: 'GET',
      status: 200,
      chunks: [body],
      done: true,
      error: null,
    },
  ]
  adapter.getCapturedHistoryRequestHeaders = async () => ({
    authorization: 'Bearer secret',
    cookie: 'private-cookie',
    'x-app-version': '1',
  })
}

test('DeepSeekAdapter.loadHistory replaces a nonempty MERGE delta with the full REPLACE snapshot', async () => {
  const adapter = Object.create(DeepSeekAdapter.prototype) as any
  stubCapturedHistory(adapter, historyBody('MERGE', 2))
  const replayPayloads: Array<{
    url: string
    headers: Record<string, string>
  }> = []
  adapter.page = {
    evaluate: async (
      _callback: unknown,
      payload: (typeof replayPayloads)[number]
    ) => {
      replayPayloads.push(payload)
      return {
        body: historyBody('REPLACE', 6),
        ok: true,
        status: 200,
      }
    },
  }

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
  const adapter = Object.create(DeepSeekAdapter.prototype) as any
  stubCapturedHistory(adapter, historyBody('MERGE', 2))
  adapter.page = {
    evaluate: async () => {
      throw new Error('network failed')
    },
  }

  const result = await adapter.loadHistory()

  assert.equal(result.complete, false)
  assert.equal(result.messages.length, 2)
  assert.match(result.warning ?? '', /full-history request failed/)
})

test('DeepSeekAdapter.loadHistory bounds the full replay with the configured timeout', async () => {
  const adapter = Object.create(DeepSeekAdapter.prototype) as any
  adapter.options = {
    timings: {
      requestStartWarningAfterMs: 1,
      blockedWarningIntervalMs: 1,
      responseStartTimeoutMs: 1,
      responseStallTimeoutMs: 1,
      restoreTimeoutMs: 1,
      historyLoadTimeoutMs: 5,
      historyPageTimeoutMs: 1,
    },
  }
  stubCapturedHistory(adapter, historyBody('MERGE', 2))
  adapter.page = {
    evaluate: async () => await new Promise(() => {}),
  }

  const result = await adapter.loadHistory()

  assert.equal(result.complete, false)
  assert.equal(result.messages.length, 2)
  assert.match(result.warning ?? '', /full-history request timed out/)
})
