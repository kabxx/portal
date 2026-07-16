import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ClaudeCompletionStream,
  ClaudeSseDecoder,
  ClaudeSseProtocolError,
} from '../../src/providers/claude-sse.ts'

test('ClaudeSseDecoder handles arbitrary chunks, CRLF, comments, and multi-line data', () => {
  const decoder = new ClaudeSseDecoder()
  const events = [
    ...decoder.push(': comment\r\nevent: message_delta\r\ndata: {"type":'),
    ...decoder.push(
      '"message_delta",\r\ndata: "delta":{"stop_reason":"end_turn"}}\r'
    ),
    ...decoder.push('\n\r\n'),
  ]

  assert.deepEqual(events, [
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      },
    },
  ])
  decoder.finish()
})

test('ClaudeCompletionStream accumulates only text blocks and terminal state', () => {
  const stream = new ClaudeCompletionStream()
  const snapshot = stream.push(
    [
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"REA"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"DY"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
  )

  assert.deepEqual(snapshot, {
    text: 'READY',
    messageStopped: true,
    stopReason: 'end_turn',
    sawActivity: true,
    errorMessage: null,
  })
  stream.finish()
})

test('ClaudeCompletionStream reports structured SSE errors', () => {
  const stream = new ClaudeCompletionStream()
  const snapshot = stream.push(
    'event: error\ndata: {"type":"error","error":{"message":"rate limited"}}\n\n'
  )

  assert.equal(snapshot.errorMessage, 'rate limited')
})

test('ClaudeSseDecoder rejects invalid JSON only after a complete event', () => {
  const decoder = new ClaudeSseDecoder()
  assert.deepEqual(decoder.push('data: {"type":"message'), [])
  assert.throws(
    () => decoder.push('_stop" nope}\n\n'),
    (error) => error instanceof ClaudeSseProtocolError
  )
})

test('ClaudeSseDecoder rejects an EOF residual frame', () => {
  const decoder = new ClaudeSseDecoder()
  decoder.push('event: message_stop\ndata: {"type":"message_stop"}\n')

  assert.throws(
    () => decoder.finish(),
    /Claude response ended with an incomplete SSE frame\./
  )
})
