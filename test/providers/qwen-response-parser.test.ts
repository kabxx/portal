import test from 'node:test'
import assert from 'node:assert/strict'

import { parseQwenResponse } from '../../src/providers/qwen-response-parser.ts'

test('parseQwenResponse keeps answer deltas and hides thinking summaries', () => {
  const raw = [
    'data: {"response.created":{"chat_id":"chat-1","response_id":"response-1","parent_id":"user-1"}}',
    '',
    'data: {"choices":[{"delta":{"content":"hidden","phase":"thinking_summary","status":"typing"}}],"response_id":"response-1"}',
    '',
    'data: {"choices":[{"delta":{"content":"Hello ","phase":"answer","status":"typing"}}],"response_id":"response-1"}',
    '',
    'data: {"choices":[{"delta":{"content":"world","phase":"answer","status":"typing"}}],"response_id":"response-1"}',
    '',
    'data: {"choices":[{"delta":{"content":"","phase":"answer","status":"finished"}}],"response_id":"response-1"}',
    '',
  ].join('\r\n')

  assert.deepEqual(parseQwenResponse(raw), {
    text: 'Hello world',
    isFinished: true,
    chatId: 'chat-1',
    responseId: 'response-1',
    parentId: 'user-1',
    identityConsistent: true,
    error: null,
  })
})

test('parseQwenResponse tolerates comments and a final event without a blank line', () => {
  const raw = [
    ': keepalive',
    'data: {"response.created":{"chat_id":"chat-1","response_id":"response-1"}}',
    '',
    'data: {"choices":[{"delta":{"content":"done","phase":"answer","status":"finished"}}],"response_id":"response-1"}',
  ].join('\n')

  assert.equal(parseQwenResponse(raw)?.text, 'done')
  assert.equal(parseQwenResponse(raw)?.isFinished, true)
})

test('parseQwenResponse reports stream errors and identity mismatches', () => {
  const raw = [
    'data: {"response.created":{"chat_id":"chat-1","response_id":"response-1"}}',
    '',
    'data: {"choices":[{"delta":{"content":"","phase":"answer","status":"typing","error":{"code":"MODEL_LIMIT","message":"busy"}}}],"response_id":"response-2"}',
    '',
  ].join('\n')

  assert.deepEqual(parseQwenResponse(raw), {
    text: '',
    isFinished: false,
    chatId: 'chat-1',
    responseId: 'response-2',
    parentId: null,
    identityConsistent: false,
    error: { code: 'MODEL_LIMIT', message: 'busy' },
  })
})

test('parseQwenResponse returns null for incomplete non-SSE input', () => {
  assert.equal(parseQwenResponse('data: {"choices":'), null)
})
