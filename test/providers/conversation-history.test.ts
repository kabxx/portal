import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseChatGptHistory,
  parseDeepSeekHistory,
  parseDoubaoHistory,
  parseGeminiHistory,
  parseGlmHistory,
  parseGrokHistory,
} from '../../src/providers/conversation-history.ts'

test('parseDeepSeekHistory keeps message id order and filters unsupported roles', () => {
  const result = parseDeepSeekHistory(
    JSON.stringify({
      data: {
        biz_data: {
          cache_control: 'REPLACE',
          chat_messages: [
            {
              message_id: 2,
              parent_id: 1,
              role: 'ASSISTANT',
              inserted_at: 2,
              fragments: [{ type: 'RESPONSE', content: 'answer' }],
            },
            {
              message_id: 1,
              parent_id: null,
              role: 'USER',
              inserted_at: 1,
              fragments: [{ type: 'REQUEST', content: 'question' }],
            },
          ],
        },
      },
    })
  )

  assert.deepEqual(
    result.messages.map(({ id, role, text }) => ({ id, role, text })),
    [
      { id: '1', role: 'user', text: 'question' },
      { id: '2', role: 'assistant', text: 'answer' },
    ]
  )
  assert.equal(result.complete, true)
})

test('parseDeepSeekHistory keeps nonempty cache deltas incomplete', () => {
  const result = parseDeepSeekHistory(
    JSON.stringify({
      data: {
        biz_data: {
          cache_control: 'MERGE',
          chat_messages: [
            {
              message_id: 3,
              parent_id: 2,
              role: 'USER',
              inserted_at: 3,
              fragments: [{ type: 'REQUEST', content: 'cached question' }],
            },
          ],
        },
      },
    })
  )

  assert.equal(result.messages.length, 1)
  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /cache delta/)
})

test('parseGlmHistory follows currentId through parent links', () => {
  const metadata = JSON.stringify({
    chat: {
      history: {
        currentId: 'a2',
        messages: {},
      },
    },
  })
  const batch = JSON.stringify({
    data: {
      u1: { id: 'u1', parentId: null, role: 'user', content: 'question' },
      a1: {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant',
        content_blocks: [{ type: 'text', text: 'answer' }],
      },
      a2: {
        id: 'a2',
        parentId: 'a1',
        role: 'assistant',
        content_blocks: [{ type: 'reasoning', text: 'hidden' }],
      },
    },
  })

  const result = parseGlmHistory(metadata, batch)
  assert.deepEqual(
    result.messages.map((message) => message.text),
    ['question', 'answer']
  )
  assert.equal(result.complete, true)
})

test('parseGlmHistory marks a chain with a missing root as incomplete', () => {
  const result = parseGlmHistory(
    JSON.stringify({ chat: { history: { currentId: 'a1' } } }),
    JSON.stringify({
      data: {
        a1: {
          id: 'a1',
          parentId: 'missing',
          role: 'assistant',
          content: 'answer',
        },
      },
    })
  )

  assert.equal(result.messages.length, 1)
  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /did not resolve to one verified root/)
})

test('parseGrokHistory joins response-node order with loaded response bodies', () => {
  const nodes = JSON.stringify({
    responseNodes: [
      { responseId: 'u1', sender: 'human', parentResponseId: null },
      { responseId: 'a1', sender: 'assistant', parentResponseId: 'u1' },
    ],
  })
  const responses = JSON.stringify({
    responses: [
      { responseId: 'u1', message: 'question' },
      { responseId: 'a1', message: 'answer', partial: false, isControl: false },
    ],
  })

  const result = parseGrokHistory(nodes, responses)
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ['user', 'assistant']
  )
  assert.equal(result.complete, true)
})

test('parseGrokHistory marks ambiguous response branches as incomplete', () => {
  const nodes = JSON.stringify({
    responseNodes: [
      { responseId: 'u1', sender: 'human', parentResponseId: null },
      { responseId: 'a1', sender: 'assistant', parentResponseId: 'u1' },
      { responseId: 'a2', sender: 'assistant', parentResponseId: 'u1' },
    ],
  })
  const responses = JSON.stringify({
    responses: [
      { responseId: 'u1', message: 'question' },
      {
        responseId: 'a1',
        message: 'answer 1',
        partial: false,
        isControl: false,
      },
      {
        responseId: 'a2',
        message: 'answer 2',
        partial: false,
        isControl: false,
      },
    ],
  })

  const result = parseGrokHistory(nodes, responses)
  assert.equal(result.complete, false)
  assert.match(
    result.warning ?? '',
    /did not resolve to one fully loaded branch/
  )
})

test('parseGrokHistory marks missing response bodies as incomplete', () => {
  const result = parseGrokHistory(
    JSON.stringify({
      responseNodes: [
        { responseId: 'u1', sender: 'human', parentResponseId: null },
        { responseId: 'a1', sender: 'assistant', parentResponseId: 'u1' },
      ],
    }),
    JSON.stringify({
      responses: [{ responseId: 'u1', message: 'question' }],
    })
  )

  assert.equal(result.complete, false)
  assert.match(
    result.warning ?? '',
    /did not resolve to one fully loaded branch/
  )
})

test('parseDoubaoHistory merges pages, sorts indexes, and deduplicates messages', () => {
  const page = (messages: unknown[], hasMore: boolean) =>
    JSON.stringify({
      downlink_body: {
        pull_singe_chain_downlink_body: { messages, has_more: hasMore },
      },
    })
  const message = (
    id: string,
    index: string,
    userType: number,
    text: string
  ) => ({
    message_id: id,
    index_in_conv: index,
    user_type: userType,
    content_block: [{ content: { text_block: { text } } }],
  })

  const result = parseDoubaoHistory([
    page(
      [message('2', '2', 2, 'answer'), message('1', '1', 1, 'question')],
      true
    ),
    page([message('2', '2', 2, 'answer'), message('3', '3', 1, 'next')], false),
  ])

  assert.deepEqual(
    result.messages.map((item) => item.text),
    ['question', 'answer', 'next']
  )
  assert.equal(result.complete, true)
})

test('parseChatGptHistory follows current_node and filters hidden/tool nodes', () => {
  const node = (
    id: string,
    parent: string | null,
    role: string,
    text: string,
    extra = {}
  ) => ({
    id,
    parent,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: [text] },
      metadata: {},
      recipient: 'all',
      end_turn: true,
      create_time: 1,
      ...extra,
    },
  })
  const result = parseChatGptHistory(
    JSON.stringify({
      current_node: 'tool',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: node('u1', 'root', 'user', 'question'),
        a1: node('a1', 'u1', 'assistant', 'answer'),
        hidden: node('hidden', 'a1', 'system', 'hidden'),
        tool: node('tool', 'a1', 'tool', 'tool result'),
      },
    })
  )

  assert.deepEqual(
    result.messages.map((message) => message.text),
    ['question', 'answer']
  )
  assert.equal(result.complete, true)
})

test('parseChatGptHistory renders assistant entities without changing user or citation markers', () => {
  const entityMarker =
    '\uE200entity\uE202["known_celebrity","蔡徐坤","Chinese singer"]\uE201'
  const citationMarker = '\uE200cite\uE202turn0search0\uE202\uE201'
  const node = (
    id: string,
    parent: string | null,
    role: 'user' | 'assistant',
    text: string
  ) => ({
    id,
    parent,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: [text] },
      metadata: {},
      recipient: 'all',
      end_turn: true,
      create_time: 1,
    },
  })
  const result = parseChatGptHistory(
    JSON.stringify({
      current_node: 'a1',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: node('u1', 'root', 'user', entityMarker),
        a1: node(
          'a1',
          'u1',
          'assistant',
          `网页显示的是${entityMarker}。${citationMarker}`
        ),
      },
    })
  )

  assert.deepEqual(
    result.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: 'user', text: entityMarker },
      {
        role: 'assistant',
        text: `网页显示的是蔡徐坤。${citationMarker}`,
      },
    ]
  )
})

for (const [name, marker] of [
  [
    'incomplete',
    '\uE200entity\uE202["known_celebrity","蔡徐坤","Chinese singer"]',
  ],
  ['invalid', '\uE200entity\uE202["known_celebrity",]\uE201'],
] as const) {
  test(`parseChatGptHistory preserves an ${name} assistant entity marker`, () => {
    const result = parseChatGptHistory(
      JSON.stringify({
        current_node: 'a1',
        mapping: {
          root: { id: 'root', parent: null, message: null },
          a1: {
            id: 'a1',
            parent: 'root',
            message: {
              id: 'a1',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: [marker] },
              metadata: {},
              recipient: 'all',
              end_turn: true,
            },
          },
        },
      })
    )

    assert.equal(result.messages[0]?.text, marker)
  })
}

test('parseChatGptHistory keeps Portal tool calls from incomplete assistant turns', () => {
  const entityMarker =
    '\uE200entity\uE202["known_celebrity","蔡徐坤","Chinese singer"]\uE201'
  const toolCall = `<tool name="apply_patch">before ${entityMarker} after</tool>`
  const node = (
    id: string,
    parent: string | null,
    role: string,
    text: string,
    extra = {}
  ) => ({
    id,
    parent,
    message: {
      id,
      author: { role },
      content: { content_type: 'text', parts: [text] },
      metadata: {},
      recipient: 'all',
      end_turn: true,
      create_time: 1,
      ...extra,
    },
  })

  const result = parseChatGptHistory(
    JSON.stringify({
      current_node: 'a2',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: node('u1', 'root', 'user', 'question'),
        a1: node('a1', 'u1', 'assistant', toolCall, { end_turn: false }),
        u2: node('u2', 'a1', 'user', '### Tool Result ###\nok'),
        a2: node('a2', 'u2', 'assistant', 'done'),
      },
    })
  )

  assert.deepEqual(
    result.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: 'user', text: 'question' },
      {
        role: 'assistant',
        text: toolCall,
      },
      { role: 'user', text: '### Tool Result ###\nok' },
      { role: 'assistant', text: 'done' },
    ]
  )
})

test('parseChatGptHistory marks a missing parent as incomplete', () => {
  const result = parseChatGptHistory(
    JSON.stringify({
      current_node: 'a1',
      mapping: {
        a1: {
          id: 'a1',
          parent: 'missing',
          message: {
            id: 'a1',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['answer'] },
            metadata: {},
            recipient: 'all',
            end_turn: true,
          },
        },
      },
    })
  )

  assert.equal(result.messages.length, 1)
  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /did not reach its root node/)
})

test('parseChatGptHistory keeps text from multimodal user messages', () => {
  const result = parseChatGptHistory(
    JSON.stringify({
      current_node: 'u1',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        u1: {
          id: 'u1',
          parent: 'root',
          message: {
            id: 'u1',
            author: { role: 'user' },
            content: { content_type: 'multimodal_text', parts: ['question'] },
            metadata: {},
          },
        },
      },
    })
  )

  assert.deepEqual(
    result.messages.map((message) => message.text),
    ['question']
  )
  assert.equal(result.complete, true)
})

test('parseGeminiHistory decodes hNvQHb frames and keeps setup handshake for resume filtering', () => {
  const payload = [
    [
      [
        ['conversation', 'setup-response'],
        null,
        [['# System\n# Setup Handshake']],
        [[['candidate', ['READY']]]],
        [122],
      ],
      [
        ['conversation', 'response'],
        null,
        [['normal question']],
        [[['candidate', ['normal answer']]]],
        [123],
      ],
    ],
    null,
    null,
    null,
  ]
  const body = `)]}'\n${JSON.stringify([
    ['wrb.fr', 'hNvQHb', JSON.stringify(payload), null],
  ])}`

  const result = parseGeminiHistory([body])
  assert.deepEqual(
    result.messages.map((message) => message.text),
    ['# System\n# Setup Handshake', 'READY', 'normal question', 'normal answer']
  )
  assert.equal(result.complete, true)
})

test('parseGeminiHistory marks a continuation cursor incomplete until the final page', () => {
  const page = (cursor: string | null, question: string, answer: string) => {
    const payload = [
      [
        [
          ['conversation', `response-${question}`],
          null,
          [[question]],
          [[['candidate', [answer]]]],
          [123],
        ],
      ],
      cursor,
      null,
      null,
    ]
    return `)]}'\n${JSON.stringify([
      ['wrb.fr', 'hNvQHb', JSON.stringify(payload), null],
    ])}`
  }

  const first = parseGeminiHistory([
    page('next-page', 'older question', 'older answer'),
  ])
  assert.equal(first.complete, false)
  assert.match(first.warning ?? '', /older pages/)

  const combined = parseGeminiHistory([
    page('next-page', 'older question', 'older answer'),
    page(null, 'new question', 'new answer'),
  ])
  assert.equal(combined.complete, true)
  assert.equal(combined.messages.length, 4)
})
