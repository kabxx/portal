import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { ChatGPTAdapter } from '../../../src/providers/adapters/adapter-chatgpt.ts'
import { DeepSeekAdapter } from '../../../src/providers/adapters/adapter-deepseek.ts'
import { DoubaoAdapter } from '../../../src/providers/adapters/adapter-doubao.ts'
import { GeminiAdapter } from '../../../src/providers/adapters/adapter-gemini.ts'

const localDoubaoImageCapture = new URL(
  '../../../temp/doubao_http_2.txt',
  import.meta.url
)
const localGeminiImageCapture = new URL(
  '../../../temp/gemini_unknow-1',
  import.meta.url
)
const localChatGptCapture = new URL(
  '../../../temp/chatgpt_http_1.txt',
  import.meta.url
)

test('DeepSeek parser reads a sanitized SSE sample', () => {
  const raw = [
    'data: {"v":{"response":{"message_id":4,"parent_id":3,"fragments":[{"type":"RESPONSE","content":"你好"}]}}}',
    'data: {"v":"呀"}',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  ].join('\n')
  const adapter = Object.create(DeepSeekAdapter.prototype) as DeepSeekAdapter
  const parsed = (adapter as any).parseResponse(raw)

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
  const adapter = Object.create(DeepSeekAdapter.prototype) as DeepSeekAdapter
  const parsed = (adapter as any).parseResponse(raw)

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
  const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
  const parsed = (adapter as any).parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: '123\ud83d\ude06',
    isFinished: true,
  })
})

test(
  'Doubao parser prefers the final creation_full_content snapshot in a local capture',
  {
    skip: fs.existsSync(localDoubaoImageCapture)
      ? false
      : 'local capture not available',
  },
  () => {
    const raw = fs.readFileSync(localDoubaoImageCapture, 'utf8')
    const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
    const parsed = (adapter as any).parseResponse(raw)

    assert.deepEqual(parsed, {
      conversationId: '38426588927511298',
      messageId: '45346773623004162',
      text: [
        '\u8fd9\u5c31\u4e3a\u60a8\u751f\u6210\u827e\u5c14\u83f2\u5229\u4e9a\u7684\u56fe\u7247~',
        'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/ef22da4a42644d91aabc58041c60a22e.jpeg~tplv-a9rns2rl98-image_raw_b.png?lk3s=8e244e95&rcl=20260519160818E2225FF6B7E2EA5AED69&rrcfp=ddbb2dc7&x-expires=2094538109&x-signature=BahaGjy9iJDzDjZKlUsOUgZYI4U%3D',
        'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/6b37f68929d843349b717b3d95a1f1f5.jpeg~tplv-a9rns2rl98-image_raw_b.png?lk3s=8e244e95&rcl=20260519160818E2225FF6B7E2EA5AED69&rrcfp=ddbb2dc7&x-expires=2094538112&x-signature=TsQo%2Bl8p4ls5TYTD8%2B9mWmL%2Bt6Q%3D',
        'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/d02b1eb911de4aa88e34df0206d7bb1a.jpeg~tplv-a9rns2rl98-image_raw_b.png?lk3s=8e244e95&rcl=20260519160818E2225FF6B7E2EA5AED69&rrcfp=ddbb2dc7&x-expires=2094538108&x-signature=fY%2B6Dws9U8RBrJM%2FBRVq1zBV%2FgA%3D',
        'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/970c06bf306d40b3a8203a32ffd1c74c.jpeg~tplv-a9rns2rl98-image_raw_b.png?lk3s=8e244e95&rcl=20260519160818E2225FF6B7E2EA5AED69&rrcfp=ddbb2dc7&x-expires=2094538112&x-signature=dTaTZkeuC6BOJoEdQfPZuSOZAmw%3D',
      ].join('\n'),
      isFinished: true,
    })
  }
)

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
  const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
  const parsed = (adapter as any).parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'final-message',
    text: 'final\nhttps://example.com/image.png',
    isFinished: true,
  })
})

test('Doubao English rate limit errors are marked as rate limits', () => {
  const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
  const streamError = (adapter as any).readStreamError(`id: 0
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
  const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
  const parsed = (adapter as any).parseResponse(raw)

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
  const adapter = Object.create(DoubaoAdapter.prototype) as DoubaoAdapter
  const parsed = (adapter as any).parseResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'c1',
    messageId: '1',
    text: 'before end',
    isFinished: true,
  })
})

test('Gemini parser replaces image_generation_content placeholders with real image URLs', async () => {
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
  const raw = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]])
  const adapter = Object.create(GeminiAdapter.prototype) as GeminiAdapter
  const parsed = await (adapter as any).parseResponse(raw)

  assert.ok(parsed)
  assert.equal(parsed.text.includes(placeholderUrl), false)
  assert.equal(parsed.text, `Here is the image:\n${realImageUrl}`)
  assert.equal(parsed.isFinished, true)
})

test(
  'Gemini parser reads generated image URLs from a local capture',
  {
    skip: fs.existsSync(localGeminiImageCapture)
      ? false
      : 'local capture not available',
  },
  async () => {
    const raw = fs.readFileSync(localGeminiImageCapture, 'utf8')
    const adapter = Object.create(GeminiAdapter.prototype) as GeminiAdapter
    const parsed = await (adapter as any).parseResponse(raw)

    assert.ok(parsed)
    assert.equal(parsed.text.includes('image_generation_content'), false)
    assert.ok(parsed.text.startsWith('https://lh3.googleusercontent.com/gg/'))
    assert.equal(parsed.isFinished, true)
  }
)

test(
  'ChatGPT HTTP parser reads a local capture',
  {
    skip: fs.existsSync(localChatGptCapture)
      ? false
      : 'local capture not available',
  },
  () => {
    const raw = fs.readFileSync(localChatGptCapture, 'utf8')
    const adapter = Object.create(ChatGPTAdapter.prototype) as ChatGPTAdapter
    const parsed = (adapter as any).parseHttpResponse(raw)

    assert.ok(parsed)
    assert.match(parsed.conversationId ?? '', /^[0-9a-f-]{36}$/i)
    assert.match(parsed.messageId ?? '', /^[0-9a-f-]{36}$/i)
    assert.ok(parsed.text.trim().length > 0)
    assert.equal(parsed.isFinished, true)
  }
)

test('ChatGPT HTTP parser reads a sanitized JSON response', () => {
  const raw = JSON.stringify({
    conversation_id: 'conversation-1',
    current_node: 'node-2',
    mapping: {
      'node-2': {
        message: {
          id: 'message-1',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['hello'] },
          status: 'finished_successfully',
          end_turn: true,
        },
      },
    },
  })
  const adapter = Object.create(ChatGPTAdapter.prototype) as ChatGPTAdapter
  const parsed = (adapter as any).parseHttpResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: 'hello',
    isFinished: true,
  })
})

test('ChatGPT HTTP parser reads the current SSE conversation sample', () => {
  const raw = fs.readFileSync(
    new URL('../../fixtures/chatgpt_http_sse_ready.txt', import.meta.url),
    'utf8'
  )
  const adapter = Object.create(ChatGPTAdapter.prototype) as ChatGPTAdapter
  const parsed = (adapter as any).parseHttpResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: '6a4f6795-34cc-83ec-90c6-53b15956f198',
    messageId: '9eee97c8-c23d-4260-ae16-9447b330e97b',
    text: 'READY',
    isFinished: true,
  })
})

test('ChatGPT HTTP parser appends bare SSE delta string chunks', () => {
  const raw = [
    'event: delta',
    'data: {"v":{"message":{"id":"message-1","author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress","channel":"final","metadata":{}}},"conversation_id":"conversation-1"}',
    '',
    'event: delta',
    'data: {"p":"/message/content/parts/0","o":"append","v":"First"}',
    '',
    'event: delta',
    'data: {"v":" second"}',
    '',
    'event: delta',
    'data: {"v":" third"}',
    '',
    'event: delta',
    'data: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":" fourth"},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
    '',
    'data: {"type":"message_stream_complete","conversation_id":"conversation-1"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const adapter = Object.create(ChatGPTAdapter.prototype) as ChatGPTAdapter
  const parsed = (adapter as any).parseHttpResponse(raw)

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: 'First second third fourth',
    isFinished: true,
  })
})
