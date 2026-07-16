import test from 'node:test'
import assert from 'node:assert/strict'

import { ClaudeAdapter } from '../../../src/providers/adapters/adapter-claude.ts'
import { ProviderAdapterError } from '../../../src/providers/adapters/adapter-base.ts'

test('ClaudeAdapter.restore rejects redirects away from the requested conversation', async () => {
  const adapter = createClaudeAdapter()
  adapter.options = {
    conversationUrl: 'https://claude.ai/chat/conversation-1',
  }
  adapter.conversationIdVal = 'conversation-1'
  adapter.page = {
    goto: async () => undefined,
    url: () => 'https://claude.ai/new',
  }
  adapter.isComposerReady = async () => true
  adapter.isLoginPageVisible = async () => false
  adapter.getRestoreTimeoutMs = () => 1000

  await assert.rejects(
    adapter.restore(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.detailCode === 'claude_conversation_mismatch'
  )
})

test('ClaudeAdapter.submit follows tool-use completion with the final text stream', async () => {
  const adapter = createClaudeAdapter()
  const streamed: string[] = []
  let polls = 0
  adapter.getCapturedFetchEntries = async () => {
    polls += 1
    if (polls === 1) return []
    if (polls === 2) return [toolStream]
    return [toolStream, finalStream]
  }
  adapter.isComposerReady = async () => polls >= 3
  adapter.setSubmitTextReporter(async (text: string) => {
    streamed.push(text)
  })

  const result = await adapter.submit()

  assert.equal(result, 'Checking complete.')
  assert.deepEqual(streamed, ['Checking ', 'Checking complete.'])
  assert.equal(adapter.conversationId, 'conversation-1')
  assert.deepEqual(adapter.events, ['press:Enter'])
})

test('ClaudeAdapter.submit rejects a completed stream without message_stop', async () => {
  const adapter = createClaudeAdapter()
  adapter.getCapturedFetchEntries = async () => [incompleteStream]

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.detailCode === 'claude_completion_protocol_error' &&
      /without message_stop/.test(error.message)
  )
})

test('ClaudeAdapter.submit classifies malformed SSE JSON as a non-retryable protocol error', async () => {
  const adapter = createClaudeAdapter()
  adapter.getCapturedFetchEntries = async () => [malformedStream]

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'protocol' &&
      error.recovery === 'none' &&
      error.retryable === false &&
      error.detailCode === 'claude_completion_protocol_error'
  )
})

test('ClaudeAdapter.submit rejects tool use without a follow-up completion', async () => {
  const adapter = createClaudeAdapter()
  adapter.getCapturedFetchEntries = async () => [toolStream]
  adapter.getSubmitResponseStallTimeoutMs = () => 100

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.detailCode === 'claude_completion_protocol_error' &&
      /non-terminal reason tool_use/.test(error.message)
  )
})

test('ClaudeAdapter matches only POST completion streams for its conversation', () => {
  const adapter = createClaudeAdapter()
  adapter.conversationIdVal = 'conversation-1'

  assert.equal(adapter.isTargetCompletionEntry(toolStream), true)
  assert.equal(
    adapter.isTargetCompletionEntry({
      ...toolStream,
      url: '/api/organizations/org-1/chat_conversations/conversation-1/completion',
    }),
    true
  )
  assert.equal(
    adapter.isTargetCompletionEntry({
      ...toolStream,
      method: 'GET',
    }),
    false
  )
  assert.equal(
    adapter.isTargetCompletionEntry({
      ...toolStream,
      url: completionUrl('conversation-2'),
    }),
    false
  )
})

test('ClaudeAdapter.stopGeneration clicks only the scoped stop response button', async () => {
  const adapter = createClaudeAdapter()
  let clicks = 0
  adapter.getComposerRoot = () => ({
    count: async () => 1,
    locator: (selector: string) => {
      assert.equal(
        selector,
        'button[data-cds="Button"][aria-label="Stop response"]'
      )
      return {
        count: async () => 1,
        nth: () => ({
          isVisible: async () => true,
          click: async () => {
            clicks += 1
          },
        }),
      }
    },
  })

  await adapter.stopGeneration()

  assert.equal(clicks, 1)
})

test('ClaudeAdapter.stopGeneration is a no-op without a stop response button', async () => {
  const adapter = createClaudeAdapter()
  adapter.getComposerRoot = () => ({
    count: async () => 1,
    locator: () => ({ count: async () => 0 }),
  })

  await adapter.stopGeneration()
})

function createClaudeAdapter(): any {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  adapter.conversationIdVal = null
  adapter.events = [] as string[]
  adapter.getCapturedFetchEntryCount = async () => 0
  adapter.getSubmitRequestStartGraceMs = () => 1000
  adapter.getSubmitBlockedWarningIntervalMs = () => 1000
  adapter.getInput = () => ({
    press: async (key: string) => {
      adapter.events.push(`press:${key}`)
    },
  })
  adapter.isComposerReady = async () => true
  adapter.page = {
    url: () => 'https://claude.ai/chat/conversation-1',
  }
  return adapter
}

function completionUrl(conversationId: string): string {
  return `https://claude.ai/api/organizations/org-1/chat_conversations/${conversationId}/completion`
}

const toolStream = {
  id: 1,
  url: completionUrl('conversation-1'),
  method: 'POST',
  status: 200,
  chunks: [
    [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking "}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'),
  ],
  done: true,
  error: null,
}

const finalStream = {
  id: 2,
  url: completionUrl('conversation-1'),
  method: 'POST',
  status: 200,
  chunks: [
    [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"complete."}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'),
  ],
  done: true,
  error: null,
}

const incompleteStream = {
  id: 1,
  url: completionUrl('conversation-1'),
  method: 'POST',
  status: 200,
  chunks: [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
  ],
  done: true,
  error: null,
}

const malformedStream = {
  id: 1,
  url: completionUrl('conversation-1'),
  method: 'POST',
  status: 200,
  chunks: ['event: message_stop\ndata: {bad}\n\n'],
  done: true,
  error: null,
}
