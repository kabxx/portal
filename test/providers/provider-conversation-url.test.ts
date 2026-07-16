import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConversationUrl } from '../../src/providers/provider-conversation-url.ts'

test('resolveConversationUrl detects supported provider conversation URLs', () => {
  assert.deepEqual(
    resolveConversationUrl('https://chatgpt.com/c/chatgpt-conv'),
    {
      provider: 'chatgpt',
      conversationUrl: 'https://chatgpt.com/c/chatgpt-conv',
    }
  )
  assert.deepEqual(
    resolveConversationUrl('https://claude.ai/chat/claude-conv'),
    {
      provider: 'claude',
      conversationUrl: 'https://claude.ai/chat/claude-conv',
    }
  )
  assert.deepEqual(
    resolveConversationUrl('https://gemini.google.com/app/c_gemini-conv'),
    {
      provider: 'gemini',
      conversationUrl: 'https://gemini.google.com/app/gemini-conv',
    }
  )
  assert.deepEqual(
    resolveConversationUrl('https://chat.deepseek.com/a/chat/s/deepseek-conv'),
    {
      provider: 'deepseek',
      conversationUrl: 'https://chat.deepseek.com/a/chat/s/deepseek-conv',
    }
  )
  assert.deepEqual(
    resolveConversationUrl('https://www.doubao.com/chat/doubao-conv'),
    {
      provider: 'doubao',
      conversationUrl: 'https://www.doubao.com/chat/doubao-conv',
    }
  )
  assert.deepEqual(resolveConversationUrl('https://grok.com/chat/grok-conv'), {
    provider: 'grok',
    conversationUrl: 'https://grok.com/chat/grok-conv',
  })
  assert.deepEqual(resolveConversationUrl('https://chat.z.ai/c/glm-conv'), {
    provider: 'glm',
    conversationUrl: 'https://chat.z.ai/c/glm-conv',
  })
})

test('resolveConversationUrl normalizes provider URL variants', () => {
  assert.deepEqual(
    resolveConversationUrl(
      'https://chat.openai.com/c/chatgpt-conv?model=x#top'
    ),
    {
      provider: 'chatgpt',
      conversationUrl: 'https://chatgpt.com/c/chatgpt-conv',
    }
  )
  assert.deepEqual(
    resolveConversationUrl('https://doubao.com/chat/doubao-conv?from=share'),
    {
      provider: 'doubao',
      conversationUrl: 'https://www.doubao.com/chat/doubao-conv',
    }
  )
  assert.deepEqual(resolveConversationUrl('https://grok.com/c/grok-conv?x=1'), {
    provider: 'grok',
    conversationUrl: 'https://grok.com/chat/grok-conv',
  })
  assert.deepEqual(
    resolveConversationUrl('https://chat.z.ai/c/glm-conv?model=x#top'),
    {
      provider: 'glm',
      conversationUrl: 'https://chat.z.ai/c/glm-conv',
    }
  )
})

test('resolveConversationUrl rejects unsupported URLs', () => {
  assert.equal(resolveConversationUrl('not-a-url'), null)
  assert.equal(
    resolveConversationUrl('http://chatgpt.com/c/chatgpt-conv'),
    null
  )
  assert.equal(
    resolveConversationUrl('https://example.com/c/chatgpt-conv'),
    null
  )
  assert.equal(resolveConversationUrl('https://claude.ai/new'), null)
})

test('resolveConversationUrl rejects malformed path encoding', () => {
  assert.equal(resolveConversationUrl('https://chatgpt.com/c/%ZZ'), null)
  assert.equal(
    resolveConversationUrl('https://gemini.google.com/app/%E0%A4%A'),
    null
  )
})
