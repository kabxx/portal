import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  parseChatGptHttpResponse,
  parseChatGptWebSocketFrames,
} from '../../src/providers/chatgpt-response-parser.ts'

interface AssistantMessageOptions {
  id: string
  text: string
  finished?: boolean
  channel?: string
  hidden?: boolean
}

function createAssistantMessage({
  id,
  text,
  finished = false,
  channel = 'final',
  hidden = false,
}: AssistantMessageOptions): Record<string, unknown> {
  return {
    id,
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [text] },
    status: finished ? 'finished_successfully' : 'in_progress',
    end_turn: finished,
    channel,
    metadata: {
      is_visually_hidden_from_conversation: hidden,
    },
  }
}

function createEncodedFrame(
  event: string,
  data: unknown,
  conversationId?: string
): string {
  return JSON.stringify({
    ...(conversationId !== undefined
      ? { conversation_id: conversationId }
      : {}),
    encoded_item: `event: ${event}\ndata: ${JSON.stringify(data)}`,
  })
}

function createInitialMessageFrame(
  options: AssistantMessageOptions,
  conversationId = 'conversation-1'
): string {
  return createEncodedFrame(
    'delta',
    { v: { message: createAssistantMessage(options) } },
    conversationId
  )
}

function createPatchFrame(operations: readonly unknown[]): string {
  return createEncodedFrame('delta', {
    o: 'patch',
    v: operations,
  })
}

function createEntityMarker(
  type: string,
  name: string,
  disambiguation: string
): string {
  return `\uE200entity\uE202${JSON.stringify([type, name, disambiguation])}\uE201`
}

test('ChatGPT HTTP parser reads a sanitized JSON response', () => {
  const raw = JSON.stringify({
    conversation_id: 'conversation-1',
    current_node: 'node-2',
    mapping: {
      'node-2': {
        message: createAssistantMessage({
          id: 'message-1',
          text: 'hello',
          finished: true,
        }),
      },
    },
  })

  assert.deepEqual(parseChatGptHttpResponse(raw), {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: 'hello',
    isFinished: true,
  })
})

test('ChatGPT HTTP parser renders entity markers as their display names', () => {
  const raw = JSON.stringify({
    conversation_id: 'conversation-1',
    current_node: 'node-2',
    mapping: {
      'node-2': {
        message: createAssistantMessage({
          id: 'message-1',
          text: `网页显示的是${createEntityMarker(
            'known_celebrity',
            '蔡徐坤',
            'Chinese singer'
          )}。`,
          finished: true,
        }),
      },
    },
  })

  assert.equal(parseChatGptHttpResponse(raw)?.text, '网页显示的是蔡徐坤。')
})

test('ChatGPT HTTP SSE parser renders an entity marker split across deltas', () => {
  const marker = createEntityMarker(
    'known_celebrity',
    '蔡徐坤',
    'Chinese singer'
  )
  const splitAt = Math.floor(marker.length / 2)
  const raw = [
    `data: ${JSON.stringify({
      v: {
        message: createAssistantMessage({
          id: 'message-1',
          text: '网页显示的是',
        }),
      },
      conversation_id: 'conversation-1',
    })}`,
    `data: ${JSON.stringify({
      p: '/message/content/parts/0',
      o: 'append',
      v: marker.slice(0, splitAt),
    })}`,
    `data: ${JSON.stringify({
      o: 'patch',
      v: [
        {
          p: '/message/content/parts/0',
          o: 'append',
          v: `${marker.slice(splitAt)}。`,
        },
        { p: '/message/end_turn', o: 'replace', v: true },
      ],
    })}`,
  ].join('\n')

  assert.equal(parseChatGptHttpResponse(raw)?.text, '网页显示的是蔡徐坤。')
})

test('ChatGPT WebSocket parser renders multiple escaped entity markers', () => {
  const first = createEntityMarker(
    'known_celebrity',
    '蔡"徐"坤',
    'Chinese singer'
  )
  const second = createEntityMarker(
    'known_celebrity',
    '周杰伦',
    'Taiwanese musician'
  )
  const parsed = parseChatGptWebSocketFrames([
    createInitialMessageFrame({ id: 'message-1', text: '嘉宾：' }),
    createEncodedFrame('delta', {
      p: '/message/content/parts/0',
      o: 'append',
      v: `${first}、${second}`,
    }),
    createPatchFrame([{ p: '/message/end_turn', o: 'replace', v: true }]),
  ])

  assert.equal(parsed?.text, '嘉宾：蔡"徐"坤、周杰伦')
})

test('ChatGPT HTTP parser reads the current SSE conversation sample', () => {
  const raw = fs.readFileSync(
    new URL('../fixtures/chatgpt_http_sse_ready.txt', import.meta.url),
    'utf8'
  )

  assert.deepEqual(parseChatGptHttpResponse(raw), {
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

  assert.deepEqual(parseChatGptHttpResponse(raw), {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: 'First second third fourth',
    isFinished: true,
  })
})

test('ChatGPT WebSocket parser reads nested encoded-item deltas through frame noise', () => {
  const initial = createInitialMessageFrame({ id: 'message-1', text: '' })
  const appended = createEncodedFrame('delta', {
    p: '/message/content/parts/0',
    o: 'append',
    v: 'Text with [brackets] and an escaped "quote".',
  })
  const finished = createPatchFrame([
    {
      p: '/message/status',
      o: 'replace',
      v: 'finished_successfully',
    },
  ])

  const parsed = parseChatGptWebSocketFrames([
    `prefix:${initial}:middle:${appended}:suffix:${finished}`,
  ])

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    text: 'Text with [brackets] and an escaped "quote".',
    isFinished: true,
  })
})

test('ChatGPT WebSocket parser applies patches only to the latest active message', () => {
  const parsed = parseChatGptWebSocketFrames([
    createInitialMessageFrame({ id: 'message-1', text: 'first' }),
    createInitialMessageFrame({ id: 'message-2', text: 'second' }),
    createEncodedFrame('delta', {
      p: '/message/content/parts/0',
      o: 'append',
      v: ' updated',
    }),
    createPatchFrame([
      {
        p: '/message/content/parts/0',
        o: 'replace',
        v: 'second replaced',
      },
      { p: '/message/end_turn', o: 'replace', v: true },
    ]),
  ])

  assert.deepEqual(parsed, {
    conversationId: 'conversation-1',
    messageId: 'message-2',
    text: 'second replaced',
    isFinished: true,
  })
})

for (const finishCase of [
  {
    name: 'status patch',
    frame: createPatchFrame([
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
    ]),
  },
  {
    name: 'end_turn patch',
    frame: createPatchFrame([
      { p: '/message/end_turn', o: 'replace', v: true },
    ]),
  },
  {
    name: 'metadata completion patch',
    frame: createPatchFrame([
      {
        p: '/message/metadata',
        o: 'replace',
        v: { is_complete: true },
      },
    ]),
  },
  {
    name: 'message_stream_complete event',
    frame: createEncodedFrame('message_stream_complete', {
      type: 'message_stream_complete',
    }),
  },
] as const) {
  test(`ChatGPT WebSocket parser recognizes ${finishCase.name}`, () => {
    const parsed = parseChatGptWebSocketFrames([
      createInitialMessageFrame({ id: 'message-1', text: 'complete' }),
      finishCase.frame,
    ])

    assert.equal(parsed?.isFinished, true)
    assert.equal(parsed?.text, 'complete')
  })
}

test('ChatGPT WebSocket parser keeps transport-specific cross-chunk citations', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const referenceChunk = JSON.stringify({
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://example.com/reference',
      },
    ],
  })
  const parsed = parseChatGptWebSocketFrames([
    createInitialMessageFrame({
      id: 'message-1',
      text: 'Answer',
    }),
    createEncodedFrame('delta', {
      p: '/message/content/parts/0',
      o: 'append',
      v: ` ${marker}`,
    }),
    referenceChunk,
    createPatchFrame([{ p: '/message/end_turn', o: 'replace', v: true }]),
  ])

  assert.equal(parsed?.text, 'Answer\nhttps://example.com/reference')
})

test('ChatGPT HTTP SSE parser does not aggregate citations from later chunks', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const raw = [
    `data: ${JSON.stringify({
      v: {
        message: createAssistantMessage({
          id: 'message-1',
          text: `Answer ${marker}`,
          finished: true,
        }),
      },
      conversation_id: 'conversation-1',
    })}`,
    `data: ${JSON.stringify({
      refs: [
        {
          ref_id: 'turn0search0',
          url: 'https://example.com/reference',
        },
      ],
    })}`,
  ].join('\n')

  assert.equal(parseChatGptHttpResponse(raw)?.text, 'Answer')
})

test('ChatGPT WebSocket parser prefers the last finished response', () => {
  const frame = [
    JSON.stringify({
      message: createAssistantMessage({
        id: 'message-1',
        text: 'a much longer finished response',
        finished: true,
      }),
    }),
    JSON.stringify({
      message: createAssistantMessage({
        id: 'message-2',
        text: 'short',
        finished: true,
      }),
    }),
  ].join('')

  assert.equal(parseChatGptWebSocketFrames([frame])?.text, 'short')
})

test('ChatGPT WebSocket parser prefers the longest unfinished response and the later tie', () => {
  const frames = [
    JSON.stringify({
      message: createAssistantMessage({ id: 'message-1', text: 'short' }),
    }),
    JSON.stringify({
      message: createAssistantMessage({
        id: 'message-2',
        text: 'same length',
      }),
    }),
    JSON.stringify({
      message: createAssistantMessage({
        id: 'message-3',
        text: 'same length',
      }),
    }),
  ]

  assert.deepEqual(parseChatGptWebSocketFrames(frames), {
    messageId: 'message-3',
    text: 'same length',
    isFinished: false,
  })
})

test('ChatGPT WebSocket parser recovers after malformed outer and encoded JSON', () => {
  const malformedEncoded = JSON.stringify({
    encoded_item: 'event: delta\ndata: {not-json}',
  })
  const valid = createInitialMessageFrame({
    id: 'message-1',
    text: 'recovered',
    finished: true,
  })

  assert.equal(
    parseChatGptWebSocketFrames([`noise:{not-json}:${malformedEncoded}`, valid])
      ?.text,
    'recovered'
  )
})

test('ChatGPT WebSocket parser filters hidden and non-final messages', () => {
  const parsed = parseChatGptWebSocketFrames([
    JSON.stringify({
      message: createAssistantMessage({
        id: 'hidden-message',
        text: 'hidden',
        finished: true,
        hidden: true,
      }),
    }),
    JSON.stringify({
      message: createAssistantMessage({
        id: 'analysis-message',
        text: 'analysis',
        finished: true,
        channel: 'analysis',
      }),
    }),
    JSON.stringify({
      message: createAssistantMessage({
        id: 'visible-message',
        text: 'visible',
        finished: true,
      }),
    }),
  ])

  assert.equal(parsed?.messageId, 'visible-message')
  assert.equal(parsed?.text, 'visible')
})

test('ChatGPT WebSocket parser preserves the multimodal tool fallback', () => {
  const parsed = parseChatGptWebSocketFrames([
    JSON.stringify({
      message: {
        id: 'tool-message',
        author: { role: 'tool' },
        content: { content_type: 'multimodal_text', parts: [] },
        status: 'finished_successfully',
        end_turn: true,
        channel: 'final',
        metadata: {},
      },
    }),
  ])

  assert.deepEqual(parsed, {
    messageId: 'tool-message',
    text: '[ChatGPT image generation completed in the UI. This transport payload did not include direct image URLs.]',
    isFinished: true,
  })
})
