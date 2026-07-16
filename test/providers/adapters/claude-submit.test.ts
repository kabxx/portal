import test from 'node:test'
import assert from 'node:assert/strict'

import { ClaudeAdapter } from '../../../src/providers/adapters/adapter-claude.ts'
import {
  type CapturedFetchEntry,
  ProviderAdapterError,
} from '../../../src/providers/adapters/adapter-base.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'
import type { Locator, Page } from 'playwright'

const VOICE_BUTTON_SELECTOR = 'button:has(svg[viewBox^="0 0 21.2"])'

test('ClaudeAdapter.restore rejects redirects away from the requested conversation', async () => {
  const adapter = createClaudeAdapter()
  adapter.setCapturedEntries(async () => [finalStream])
  await adapter.submit()
  adapter.pageHarness.url = 'https://claude.ai/new'

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
  adapter.setCapturedEntries(async () => {
    polls += 1
    if (polls === 1) return []
    if (polls === 2) return [toolStream]
    return [toolStream, finalStream]
  })
  adapter.pageHarness.composerReady = () => polls === 0 || polls >= 3
  adapter.setSubmitTextReporter(async (text: string) => {
    streamed.push(text)
  })

  const result = await adapter.submit()

  assert.equal(result, 'Checking complete.')
  assert.deepEqual(streamed, ['Checking ', 'Checking complete.'])
  assert.equal(adapter.conversationId, 'conversation-1')
  assert.deepEqual(adapter.pageHarness.events, ['press:Enter'])
})

test('ClaudeAdapter.restore treats a login redirect after pending as auth', async () => {
  const adapter = createClaudeAdapter()
  let loginChecks = 0
  adapter.pageHarness.voiceButtonCount = 0
  adapter.pageHarness.loginVisible = () => {
    loginChecks += 1
    return loginChecks >= 2
  }

  await assert.rejects(
    adapter.restore(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'auth' &&
      error.detailCode === 'claude_signed_out' &&
      error.adapter === adapter
  )
})

test('ClaudeAdapter.restore reports a page timeout without Voice Mode ready', async () => {
  const adapter = createClaudeAdapter()
  adapter.pageHarness.voiceButtonCount = 0
  adapter.restoreTimeoutMs = 1

  await assert.rejects(
    adapter.restore(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'ui' &&
      error.detailCode === 'claude_page_not_ready'
  )
})

test('ClaudeAdapter.submit rejects login before pressing Enter', async () => {
  const adapter = createClaudeAdapter()
  adapter.pageHarness.loginVisible = () => true

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'auth' &&
      error.adapter === adapter
  )
  assert.deepEqual(adapter.pageHarness.events, [])
})

test('ClaudeAdapter.submit detects login after Enter before a request starts', async () => {
  const adapter = createClaudeAdapter()
  let loginChecks = 0
  adapter.pageHarness.loginVisible = () => {
    loginChecks += 1
    return loginChecks >= 2
  }
  adapter.setCapturedEntries(async () => [])

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.kind === 'auth' &&
      error.adapter === adapter
  )
  assert.deepEqual(adapter.pageHarness.events, ['press:Enter'])
})

test('ClaudeAdapter.submit does not reclassify an accepted request as login', async () => {
  const adapter = createClaudeAdapter()
  let loginChecks = 0
  let polls = 0
  adapter.pageHarness.loginVisible = () => {
    loginChecks += 1
    return loginChecks > 1
  }
  adapter.setCapturedEntries(async () => {
    polls += 1
    if (polls === 1) return [toolStream]
    if (polls === 2) return []
    return [toolStream, finalStream]
  })

  assert.equal(await adapter.submit(), 'Checking complete.')
  assert.equal(loginChecks, 1)
  assert.deepEqual(adapter.pageHarness.events, ['press:Enter'])
})

test('ClaudeAdapter.submit rejects a completed stream without message_stop', async () => {
  const adapter = createClaudeAdapter()
  adapter.setCapturedEntries(async () => [incompleteStream])

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
  adapter.setCapturedEntries(async () => [malformedStream])

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
  adapter.setCapturedEntries(async () => [toolStream])
  adapter.submitResponseStallTimeoutMs = 100

  await assert.rejects(
    adapter.submit(),
    (error) =>
      error instanceof ProviderAdapterError &&
      error.detailCode === 'claude_completion_protocol_error' &&
      /non-terminal reason tool_use/.test(error.message)
  )
})

test('ClaudeAdapter consumes only POST completion streams for its conversation', async () => {
  const adapter = createClaudeAdapter()
  adapter.setCapturedEntries(async () => [finalStream])
  await adapter.submit()

  const ignoredGet = completionStream({
    id: 2,
    method: 'GET',
    text: 'ignored get',
  })
  const ignoredConversation = completionStream({
    id: 3,
    conversationId: 'conversation-2',
    text: 'ignored conversation',
  })
  const acceptedRelative = completionStream({
    id: 4,
    relativeUrl: true,
    text: 'accepted',
  })
  adapter.setCapturedEntries(async () => [
    ignoredGet,
    ignoredConversation,
    acceptedRelative,
  ])

  assert.equal(await adapter.submit(), 'accepted')
  assert.equal(adapter.conversationId, 'conversation-1')
})

test('ClaudeAdapter.stopGeneration clicks only the scoped stop response button', async () => {
  const adapter = createClaudeAdapter()
  adapter.pageHarness.stopButtonCount = 1

  await adapter.stopGeneration()

  assert.equal(adapter.pageHarness.stopClicks, 1)
  assert.deepEqual(adapter.pageHarness.stopSelectors, [
    'button[data-cds="Button"][aria-label="Stop response"]',
  ])
})

test('ClaudeAdapter.stopGeneration is a no-op without a stop response button', async () => {
  const adapter = createClaudeAdapter()

  await adapter.stopGeneration()

  assert.equal(adapter.pageHarness.stopClicks, 0)
})

class TestClaudeAdapter extends ClaudeAdapter {
  public readonly pageHarness = new ClaudePageHarness()
  public restoreTimeoutMs = 1000
  public submitResponseStallTimeoutMs = 1000
  private capturedEntries: () => Promise<CapturedFetchEntry[]> = async () => []

  public constructor() {
    super(createBrowserContextStub())
    this.page = this.pageHarness.page
  }

  public setCapturedEntries(
    provider: () => Promise<CapturedFetchEntry[]>
  ): void {
    this.capturedEntries = provider
  }

  protected override async getCapturedFetchEntryCount(): Promise<number> {
    return 0
  }

  protected override async getCapturedFetchEntries(): Promise<
    CapturedFetchEntry[]
  > {
    return await this.capturedEntries()
  }

  protected override getSubmitRequestStartGraceMs(): number {
    return 1000
  }

  protected override getSubmitBlockedWarningIntervalMs(): number {
    return 1000
  }

  protected override getSubmitResponseStallTimeoutMs(): number {
    return this.submitResponseStallTimeoutMs
  }

  protected override getRestoreTimeoutMs(): number {
    return this.restoreTimeoutMs
  }
}

class ClaudePageHarness {
  public url = 'https://claude.ai/chat/conversation-1'
  public composerReady = () => true
  public loginVisible = () => false
  public voiceButtonCount = 1
  public stopButtonCount = 0
  public stopClicks = 0
  public readonly events: string[] = []
  public readonly stopSelectors: string[] = []
  public readonly page: Page

  public constructor() {
    const missingLocator = {
      first: () => missingLocator,
      isVisible: async () => false,
      count: async () => 0,
    } as unknown as Locator
    const stopCandidates = {
      count: async () => this.stopButtonCount,
      nth: () => ({
        isVisible: async () => true,
        click: async () => {
          this.stopClicks += 1
        },
      }),
    } as unknown as Locator
    const voiceButton = {
      isVisible: async () => true,
      isEnabled: async () => true,
      getAttribute: async () => null,
    } as unknown as Locator
    const voiceButtons = {
      count: async () => this.voiceButtonCount,
      first: () => voiceButton,
    } as unknown as Locator
    const loginControl = {
      first: () => loginControl,
      isVisible: async () => this.loginVisible(),
    } as unknown as Locator
    const composerRoot = {
      count: async () => 1,
      locator: (selector: string) => {
        if (selector === VOICE_BUTTON_SELECTOR) return voiceButtons
        this.stopSelectors.push(selector)
        return stopCandidates
      },
    } as unknown as Locator
    const input = {
      first: () => input,
      press: async (key: string) => {
        this.events.push(`press:${key}`)
      },
      isVisible: async () => this.composerReady(),
      getAttribute: async (name: string) =>
        name === 'contenteditable' && this.composerReady() ? 'true' : null,
      locator: () => composerRoot,
    } as unknown as Locator
    this.page = {
      goto: async () => null,
      url: () => this.url,
      locator: (selector: string) => {
        if (selector === '[data-testid="chat-input"]') return input
        if (selector === '[data-testid="email"], [data-testid="continue"]') {
          return loginControl
        }
        return missingLocator
      },
    } as unknown as Page
  }
}

function createClaudeAdapter(): TestClaudeAdapter {
  return new TestClaudeAdapter()
}

function completionUrl(conversationId: string): string {
  return `https://claude.ai/api/organizations/org-1/chat_conversations/${conversationId}/completion`
}

function completionStream({
  id,
  conversationId = 'conversation-1',
  method = 'POST',
  relativeUrl = false,
  text,
}: {
  id: number
  conversationId?: string
  method?: string
  relativeUrl?: boolean
  text: string
}): CapturedFetchEntry {
  const url = completionUrl(conversationId)
  return {
    id,
    url: relativeUrl ? new URL(url).pathname : url,
    method,
    status: 200,
    chunks: [
      [
        'event: content_block_delta',
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })}`,
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
} satisfies CapturedFetchEntry

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
} satisfies CapturedFetchEntry

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
} satisfies CapturedFetchEntry

const malformedStream = {
  id: 1,
  url: completionUrl('conversation-1'),
  method: 'POST',
  status: 200,
  chunks: ['event: message_stop\ndata: {bad}\n\n'],
  done: true,
  error: null,
} satisfies CapturedFetchEntry
