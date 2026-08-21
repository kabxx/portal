import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  ChatGptWebSocketResponseTracker,
  countChatGptOwnedWebSocketProgress,
  parseChatGptHttpResponse,
  parseChatGptWebSocketFrames,
} from '../../src/providers/chatgpt-response-parser.ts'

interface AssistantMessageOptions {
  id: string
  text: string
  finished?: boolean
  channel?: string
  hidden?: boolean
  parentId?: string
}

function createAssistantMessage({
  id,
  text,
  finished = false,
  channel = 'final',
  hidden = false,
  parentId,
}: AssistantMessageOptions): Record<string, unknown> {
  return {
    id,
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [text] },
    status: finished ? 'finished_successfully' : 'in_progress',
    end_turn: finished,
    channel,
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
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
    conversationId: 'conversation-fixture',
    messageId: 'message-fixture',
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

test('ChatGPT WebSocket parser ignores frames from another conversation', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      createInitialMessageFrame(
        { id: 'old-message', text: 'old' },
        'old-conversation'
      ),
      createInitialMessageFrame(
        { id: 'current-message', text: 'current', finished: true },
        'current-conversation'
      ),
    ],
    'current-conversation'
  )

  assert.deepEqual(parsed, {
    conversationId: 'current-conversation',
    messageId: 'current-message',
    text: 'current',
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
    message_id: 'message-1',
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
    referenceChunk,
    createEncodedFrame('delta', {
      p: '/message/content/parts/0',
      o: 'append',
      v: ` ${marker}`,
    }),
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

test('ChatGPT WebSocket parser can fail closed without a dispatch conversation id', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      JSON.stringify({
        conversation_id: 'background-conversation',
        message: createAssistantMessage({
          id: 'background-message',
          text: 'background response',
          finished: true,
        }),
      }),
    ],
    null,
    { requireExpectedConversationId: true }
  )

  assert.equal(parsed, null)
})

test('ChatGPT WebSocket parser can establish a new conversation from a matched parent', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      createInitialMessageFrame(
        {
          id: 'assistant-message',
          text: 'current response',
          finished: true,
          parentId: 'user-message',
        },
        'new-conversation'
      ),
    ],
    null,
    {
      requireExpectedConversationId: true,
      expectedParentMessageId: 'user-message',
    }
  )

  assert.equal(parsed?.conversationId, 'new-conversation')
  assert.equal(parsed?.text, 'current response')
})

test('ChatGPT WebSocket parser ignores an earlier background conversation before establishing owned conversation', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      createInitialMessageFrame(
        {
          id: 'background-assistant',
          text: 'background response',
          finished: true,
          parentId: 'background-user',
        },
        'background-conversation'
      ),
      createInitialMessageFrame(
        {
          id: 'owned-assistant',
          text: 'owned response',
          finished: true,
          parentId: 'owned-user',
        },
        'owned-conversation'
      ),
    ],
    null,
    {
      requireExpectedConversationId: true,
      expectedParentMessageId: 'owned-user',
    }
  )

  assert.equal(parsed?.conversationId, 'owned-conversation')
  assert.equal(parsed?.text, 'owned response')
})

test('ChatGPT WebSocket parser excludes background references before establishing owned conversation', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker(null, {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const backgroundReference = JSON.stringify({
    conversation_id: 'background-conversation',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://background.example/reference',
      },
    ],
  })
  const ownedResponse = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: `owned response ${marker}`,
      finished: true,
      parentId: 'owned-user',
    },
    'owned-conversation'
  )
  const ownedReference = JSON.stringify({
    conversation_id: 'owned-conversation',
    message_id: 'owned-assistant',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })

  assert.equal(tracker.pushFrames([backgroundReference]), null)
  assert.equal(tracker.pushFrames([ownedResponse])?.text, 'owned response')
  const parsed = tracker.pushFrames([ownedReference])
  assert.equal(parsed?.text, 'owned response\nhttps://owned.example/reference')
  assert.deepEqual(tracker.pushFrames([]), parsed)
})

test('ChatGPT WebSocket parser keeps an owned reference that establishes a new conversation before the response', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker(null, {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const ownedReference = JSON.stringify({
    conversation_id: 'owned-conversation',
    parent_id: 'owned-user',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })
  const ownedResponse = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: `owned response ${marker}`,
      finished: true,
      parentId: 'owned-user',
    },
    'owned-conversation'
  )

  assert.equal(tracker.pushFrames([ownedReference]), null)
  assert.equal(
    tracker.pushFrames([ownedResponse])?.text,
    'owned response\nhttps://owned.example/reference'
  )
})

test('ChatGPT WebSocket parser ignores anonymous same-conversation references', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker('conversation-1', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const backgroundReference = JSON.stringify({
    conversation_id: 'conversation-1',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://background.example/reference',
      },
    ],
  })
  const ownedResponse = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: `owned response ${marker}`,
      finished: true,
      parentId: 'owned-user',
    },
    'conversation-1'
  )
  const ownedReference = JSON.stringify({
    conversation_id: 'conversation-1',
    message_id: 'owned-assistant',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })

  assert.equal(tracker.pushFrames([backgroundReference]), null)
  assert.equal(tracker.pushFrames([ownedResponse])?.text, 'owned response')
  assert.equal(
    tracker.pushFrames([ownedReference])?.text,
    'owned response\nhttps://owned.example/reference'
  )
})

test('ChatGPT WebSocket parser excludes background references nested in an owned payload', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker(null, {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const mixedPayload = createEncodedFrame(
    'delta',
    {
      v: {
        message: createAssistantMessage({
          id: 'owned-assistant',
          text: `owned response ${marker}`,
          finished: true,
          parentId: 'owned-user',
        }),
      },
      background: {
        conversation_id: 'background-conversation',
        refs: [
          {
            ref_id: 'turn0search0',
            url: 'https://background.example/reference',
          },
        ],
      },
    },
    'owned-conversation'
  )
  const ownedReference = JSON.stringify({
    conversation_id: 'owned-conversation',
    message_id: 'owned-assistant',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })

  assert.equal(tracker.pushFrames([mixedPayload])?.text, 'owned response')
  assert.equal(
    tracker.pushFrames([ownedReference])?.text,
    'owned response\nhttps://owned.example/reference'
  )
})

test('ChatGPT WebSocket parser checks grouped reference identities within an owned payload', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker('owned-conversation', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const ownedPayload = JSON.stringify({
    conversation_id: 'owned-conversation',
    parent_id: 'owned-user',
    url: 'https://background.example/reference',
    refs: [
      {
        ref_id: 'turn0search0',
        message_id: 'background-assistant',
      },
    ],
  })
  const ownedResponse = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: `owned response ${marker}`,
      finished: true,
      parentId: 'owned-user',
    },
    'owned-conversation'
  )
  const ownedReference = JSON.stringify({
    conversation_id: 'owned-conversation',
    message_id: 'owned-assistant',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })

  assert.equal(tracker.pushFrames([ownedPayload]), null)
  assert.equal(tracker.pushFrames([ownedResponse])?.text, 'owned response')
  assert.equal(
    tracker.pushFrames([ownedReference])?.text,
    'owned response\nhttps://owned.example/reference'
  )
})

test('ChatGPT WebSocket parser excludes background references nested in an owned direct message', () => {
  const marker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const tracker = new ChatGptWebSocketResponseTracker('owned-conversation', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const ownedMessage = createAssistantMessage({
    id: 'owned-assistant',
    text: `owned response ${marker}`,
    finished: true,
    parentId: 'owned-user',
  })
  ownedMessage.background = {
    conversation_id: 'background-conversation',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://background.example/reference',
      },
    ],
  }
  const directPayload = JSON.stringify({
    conversation_id: 'owned-conversation',
    message: ownedMessage,
  })
  const ownedReference = JSON.stringify({
    conversation_id: 'owned-conversation',
    message_id: 'owned-assistant',
    refs: [
      {
        ref_id: 'turn0search0',
        url: 'https://owned.example/reference',
      },
    ],
  })

  assert.equal(tracker.pushFrames([directPayload])?.text, 'owned response')
  assert.equal(
    tracker.pushFrames([ownedReference])?.text,
    'owned response\nhttps://owned.example/reference'
  )
})

test('ChatGPT WebSocket parser excludes direct responses nested under another conversation', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      JSON.stringify({
        conversation_id: 'owned-conversation',
        background: {
          conversation_id: 'background-conversation',
          message: createAssistantMessage({
            id: 'background-assistant',
            text: 'background response',
            finished: true,
            parentId: 'owned-user',
          }),
        },
        message: createAssistantMessage({
          id: 'owned-assistant',
          text: 'owned response',
          finished: true,
          parentId: 'owned-user',
        }),
      }),
    ],
    'owned-conversation',
    {
      requireExpectedConversationId: true,
      expectedParentMessageId: 'owned-user',
    }
  )

  assert.equal(parsed?.messageId, 'owned-assistant')
  assert.equal(parsed?.text, 'owned response')
})

test('ChatGPT WebSocket parser rejects a missing parent when parent correlation is required', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      JSON.stringify({
        conversation_id: 'conversation-1',
        message: createAssistantMessage({
          id: 'assistant-message',
          text: 'unrelated response',
          finished: true,
        }),
      }),
    ],
    'conversation-1',
    {
      requireExpectedConversationId: true,
      expectedParentMessageId: 'user-message',
    }
  )

  assert.equal(parsed, null)
})

test('ChatGPT WebSocket parser fails closed when one conversation has multiple message streams', () => {
  const parsed = parseChatGptWebSocketFrames(
    [
      JSON.stringify({
        conversation_id: 'conversation-1',
        message: createAssistantMessage({
          id: 'old-message',
          text: 'old completed response',
          finished: true,
        }),
      }),
      JSON.stringify({
        conversation_id: 'conversation-1',
        message: createAssistantMessage({
          id: 'current-message',
          text: 'current response',
          finished: false,
        }),
      }),
    ],
    'conversation-1',
    {
      requireExpectedConversationId: true,
      requireSingleMessageId: true,
    }
  )

  assert.equal(parsed, null)
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

test('ChatGPT WebSocket progress follows the owned parent chain without accepting background frames', () => {
  const background = createInitialMessageFrame(
    {
      id: 'background-analysis',
      text: 'background',
      parentId: 'another-user-message',
      channel: 'analysis',
    },
    'conversation-1'
  )
  const ownedAnalysis = createInitialMessageFrame(
    {
      id: 'owned-analysis',
      text: 'analysis',
      parentId: 'owned-user-message',
      channel: 'analysis',
    },
    'conversation-1'
  )
  const ownedTool = JSON.stringify({
    conversation_id: 'conversation-1',
    message: {
      id: 'owned-tool',
      parent_id: 'owned-analysis',
      author: { role: 'tool' },
      content: { content_type: 'computer_initialize_state', parts: [] },
      status: 'in_progress',
    },
  })
  const ownedPatch = createEncodedFrame(
    'delta',
    { p: '/message/metadata', o: 'replace', v: { progress: 1 } },
    'conversation-1'
  )
  const unrelatedEvent = createEncodedFrame(
    'ping',
    { type: 'background_event' },
    'conversation-1'
  )

  assert.equal(
    countChatGptOwnedWebSocketProgress(
      [background, ownedAnalysis, ownedTool, ownedPatch, unrelatedEvent],
      {
        expectedConversationId: 'conversation-1',
        expectedParentMessageId: 'owned-user-message',
      }
    ),
    2
  )
  assert.equal(
    countChatGptOwnedWebSocketProgress([background], {
      expectedConversationId: 'conversation-1',
      expectedParentMessageId: 'owned-user-message',
    }),
    0
  )
})

test('ChatGPT WebSocket progress does not inherit ownership for identity-free patches', () => {
  const owned = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: 'owned',
      parentId: 'owned-user',
      channel: 'analysis',
    },
    'conversation-1'
  )
  const identityFreePatch = createEncodedFrame(
    'delta',
    { p: '/message/metadata', o: 'replace', v: { progress: 1 } },
    'conversation-1'
  )

  assert.equal(
    countChatGptOwnedWebSocketProgress([owned, identityFreePatch], {
      expectedConversationId: 'conversation-1',
      expectedParentMessageId: 'owned-user',
    }),
    1
  )
})

test('ChatGPT WebSocket patches keep the strictly owned active message across background messages', () => {
  const tracker = new ChatGptWebSocketResponseTracker('conversation-1', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const owned = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: 'owned response',
      parentId: 'owned-user',
    },
    'conversation-1'
  )
  const background = createInitialMessageFrame(
    {
      id: 'background-assistant',
      text: 'background response',
      parentId: 'background-user',
    },
    'conversation-1'
  )
  const finish = createPatchFrame([
    { p: '/message/end_turn', o: 'replace', v: true },
  ])

  assert.equal(tracker.pushFrames([owned])?.isFinished, false)
  assert.equal(tracker.pushFrames([background])?.text, 'owned response')
  assert.equal(tracker.pushFrames([finish])?.isFinished, true)
})

test('ChatGPT WebSocket patches complete a strictly owned direct response', () => {
  const tracker = new ChatGptWebSocketResponseTracker('conversation-1', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const direct = JSON.stringify({
    conversation_id: 'conversation-1',
    message: createAssistantMessage({
      id: 'owned-assistant',
      text: 'owned response',
      parentId: 'owned-user',
    }),
  })
  const finish = createPatchFrame([
    { p: '/message/end_turn', o: 'replace', v: true },
  ])

  assert.equal(tracker.pushFrames([direct])?.isFinished, false)
  assert.equal(tracker.pushFrames([finish])?.isFinished, true)
})

test('ChatGPT WebSocket parser preserves parent conversation ownership for nested encoded items', () => {
  const tracker = new ChatGptWebSocketResponseTracker('owned-conversation', {
    requireExpectedConversationId: true,
    expectedParentMessageId: 'owned-user',
  })
  const owned = createInitialMessageFrame(
    {
      id: 'owned-assistant',
      text: 'owned response',
      parentId: 'owned-user',
    },
    'owned-conversation'
  )
  const nestedBackground = JSON.stringify({
    conversation_id: 'owned-conversation',
    background: {
      conversation_id: 'background-conversation',
      wrapper: {
        encoded_item: `event: delta\ndata: ${JSON.stringify({
          v: {
            message: createAssistantMessage({
              id: 'background-assistant',
              text: 'background response',
              finished: true,
              parentId: 'owned-user',
            }),
          },
        })}`,
      },
    },
  })
  const finish = createPatchFrame([
    { p: '/message/end_turn', o: 'replace', v: true },
  ])

  assert.equal(tracker.pushFrames([owned])?.isFinished, false)
  assert.equal(tracker.pushFrames([nestedBackground])?.text, 'owned response')
  assert.equal(tracker.getOwnedProgressCount(), 1)
  assert.equal(tracker.pushFrames([finish])?.isFinished, true)
})

test('ChatGPT WebSocket tracker preserves results across incremental frame batches', () => {
  const frames = [
    createInitialMessageFrame(
      {
        id: 'owned-assistant',
        text: 'part one',
        parentId: 'owned-user',
      },
      'conversation-1'
    ),
    createEncodedFrame(
      'delta',
      {
        p: '/message/content/parts/0',
        o: 'append',
        v: ' and two',
      },
      'conversation-1'
    ),
    createEncodedFrame(
      'delta',
      {
        o: 'patch',
        v: [{ p: '/message/end_turn', o: 'replace', v: true }],
      },
      'conversation-1'
    ),
  ]
  const options = {
    requireExpectedConversationId: true,
    requireSingleMessageId: true,
    expectedParentMessageId: 'owned-user',
  } as const
  const allAtOnce = new ChatGptWebSocketResponseTracker(
    'conversation-1',
    options
  )
  const incremental = new ChatGptWebSocketResponseTracker(
    'conversation-1',
    options
  )

  const expected = allAtOnce.pushFrames(frames)
  assert.equal(incremental.pushFrames(frames.slice(0, 1))?.text, 'part one')
  assert.equal(
    incremental.pushFrames(frames.slice(1, 2))?.text,
    'part one and two'
  )
  assert.deepEqual(incremental.pushFrames(frames.slice(2)), expected)
  assert.equal(
    incremental.getOwnedProgressCount(),
    allAtOnce.getOwnedProgressCount()
  )
  assert.deepEqual(incremental.pushFrames([]), expected)
  assert.equal(
    incremental.getOwnedProgressCount(),
    allAtOnce.getOwnedProgressCount()
  )
})

test('ChatGPT WebSocket progress seeds an HTTP-owned message and stops at an unowned stream', () => {
  const ownedTool = JSON.stringify({
    conversation_id: 'conversation-1',
    message: {
      id: 'owned-tool',
      parent_id: 'http-assistant-message',
      author: { role: 'tool' },
      content: { content_type: 'computer_initialize_state', parts: [] },
    },
  })
  const background = createInitialMessageFrame(
    {
      id: 'background-analysis',
      text: 'background',
      parentId: 'another-user-message',
      channel: 'analysis',
    },
    'conversation-1'
  )
  const backgroundPatch = createEncodedFrame(
    'delta',
    { p: '/message/metadata', o: 'replace', v: { progress: 1 } },
    'conversation-1'
  )

  assert.equal(
    countChatGptOwnedWebSocketProgress(
      [ownedTool, background, backgroundPatch],
      {
        expectedConversationId: 'conversation-1',
        expectedMessageId: 'http-assistant-message',
      }
    ),
    1
  )
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
