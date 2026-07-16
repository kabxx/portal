import test from 'node:test'
import assert from 'node:assert/strict'

import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'
import { createPrototypeObject } from '../../helpers/fakes.ts'

interface ParsedResponse {
  conversationId?: string
  messageId?: string | number
  parentId?: number
  text: string
  isFinished: boolean
}

interface SyncParserHarness {
  parseResponse(raw: string): ParsedResponse | null
}

interface AsyncParserHarness {
  parseResponse(raw: string): Promise<ParsedResponse | null>
}

interface DoubaoParserHarness extends SyncParserHarness {
  readStreamError(raw: string): {
    detailCode: string
    kind: string
    message: string
  } | null
}

test('DeepSeek parser reads a sanitized SSE sample', () => {
  const raw = [
    'data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"type":"RESPONSE","content":"你好"}]}}}',
    'data: {"v":"呀"}',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  ].join('\n')
  const adapter = createPrototypeObject(
    DeepSeekAdapter.prototype
  ) as SyncParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.deepEqual(parsed, {
    messageId: 4,
    parentId: 3,
    text: '\u4f60\u597d\u5440',
    isFinished: true,
  })
})

test('DeepSeek parser hides thinking fragments and keeps response prefix', () => {
  const raw = [
    'data: {"v":{"response":{"message_id":12,"parent_id":11,"fragments":[{"type":"THINK","content":"用户说 AI"},{"type":"RESPONSE","content":"哈哈"}]}}}',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  ].join('\n')
  const adapter = createPrototypeObject(
    DeepSeekAdapter.prototype
  ) as SyncParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.ok(parsed)
  assert.equal(parsed.messageId, 12)
  assert.equal(parsed.parentId, 11)
  assert.equal(parsed.isFinished, true)
  assert.ok(parsed.text.startsWith('\u54c8\u54c8'))
  assert.equal(parsed.text.includes('\u7528\u6237\u8bf4'), false)
  assert.equal(parsed.text.includes('AI'), false)
})

test('Doubao parser reads a sanitized SSE sample', () => {
  const raw = [
    'event: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"content":{"text_block":{"text":"123"}}}]},"meta":{"message_id":"message-1","conversation_id":"conversation-1"}}',
    'event: CHUNK_DELTA\ndata: {"text":"😆"}',
    'event: SSE_REPLY_END\ndata: {"end_type":1}',
  ].join('\n\n')
  const adapter = createPrototypeObject(
    DoubaoAdapter.prototype
  ) as DoubaoParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: '123\ud83d\ude06',
    isFinished: true,
  })
})

test('Doubao parser prefers a sanitized final creation snapshot', () => {
  const snapshot = JSON.stringify([
    {
      BlockInfo: {
        BlockContent: { content: { text_block: { text: 'final' } } },
      },
    },
    {
      BlockInfo: {
        BlockContent: {
          content: {
            creation_block: {
              creations: [
                {
                  image: {
                    image_ori: { url: 'https://example.com/image.png' },
                  },
                },
              ],
            },
          },
        },
      },
    },
  ])
  const raw = [
    'event: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"content":{"text_block":{"text":"draft"}}}]},"meta":{"message_id":"draft-message","conversation_id":"conversation-1"}}',
    `event: STREAM_CHUNK\ndata: ${JSON.stringify({
      message_id: 'final-message',
      patch_op: [
        {
          patch_value: {
            ext: { creation_full_content: snapshot },
          },
        },
      ],
    })}`,
    'event: SSE_REPLY_END\ndata: {"end_type":1}',
  ].join('\n\n')
  const adapter = createPrototypeObject(
    DoubaoAdapter.prototype
  ) as DoubaoParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'final-message',
    text: 'final\nhttps://example.com/image.png',
    isFinished: true,
  })
})

test('Doubao English rate limit errors are marked as rate limits', () => {
  const adapter = createPrototypeObject(
    DoubaoAdapter.prototype
  ) as DoubaoParserHarness
  const streamError = adapter.readStreamError(`id: 0
event: STREAM_ERROR
data: {"error_code":710022004,"error_msg":"rate limited","extra":{"ack":"1"}}`)

  assert.deepEqual(streamError, {
    detailCode: 'doubao_stream_error_710022004',
    kind: 'rate_limit',
    message: 'rate limited',
  })
})

test('Doubao parser accepts UTF-8 decoded text from raw response bytes', () => {
  const text =
    '\u4f60\u597d\u5440\uff0c\u6709\u4ec0\u4e48\u9700\u8981\u5e2e\u5fd9\uff1f'
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":${JSON.stringify(text)}}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}`
  const adapter = createPrototypeObject(
    DoubaoAdapter.prototype
  ) as DoubaoParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'c1',
    messageId: '1',
    text,
    isFinished: true,
  })
})

test('Doubao parser ignores events after SSE_REPLY_END', () => {
  const raw = `id: 0
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"before end"}}}]},"meta":{"message_id":"1","conversation_id":"c1"}}

id: 1
event: SSE_REPLY_END
data: {"end_type":1}

id: 2
event: STREAM_MSG_NOTIFY
data: {"content":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"after end"}}}]},"meta":{"message_id":"2","conversation_id":"c2"}}`
  const adapter = createPrototypeObject(
    DoubaoAdapter.prototype
  ) as DoubaoParserHarness
  const parsed = adapter.parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'c1',
    messageId: '1',
    text: 'before end',
    isFinished: true,
  })
})

test('Gemini parser reads a framed response and replaces image placeholders', async () => {
  const placeholderUrl =
    'http://googleusercontent.com/image_generation_content/300'
  const realImageUrl = 'https://lh3.googleusercontent.com/gg/real-image'
  const inner = [
    null,
    ['c_123', 'r_456'],
    null,
    null,
    [
      [
        'candidate-1',
        [`Here is the image:\n${placeholderUrl}`],
        null,
        null,
        null,
        null,
        null,
        null,
        [2],
        null,
        null,
        null,
        [
          [
            [[realImageUrl]],
            null,
            null,
            null,
            null,
            null,
            null,
            [placeholderUrl],
          ],
        ],
      ],
    ],
  ]
  const frame = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]])
  const raw = `)]}'\n${Buffer.byteLength(frame)}\n${frame}`
  const adapter = createPrototypeObject(
    GeminiAdapter.prototype
  ) as AsyncParserHarness
  const parsed = await adapter.parseResponse(raw)

  assert.ok(parsed)
  assert.equal(parsed.text.includes(placeholderUrl), false)
  assert.equal(parsed.text, `Here is the image:\n${realImageUrl}`)
  assert.equal(parsed.isFinished, true)
})
