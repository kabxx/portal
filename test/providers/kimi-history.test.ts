import test from 'node:test'
import assert from 'node:assert/strict'

import { parseKimiHistory } from '../../src/providers/conversation-history.ts'

function message(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant' | 'system',
  content: string,
  status = 'MESSAGE_STATUS_COMPLETED'
) {
  return {
    id,
    parentId,
    role,
    status,
    blocks: [{ text: { content } }],
    createTime: '2026-07-17T00:00:00.000Z',
  }
}

test('parseKimiHistory reverses newest-first rows and filters control messages', () => {
  const result = parseKimiHistory(
    JSON.stringify({
      messages: [
        message('a1', 'u1', 'assistant', 'answer'),
        message('u1', 's1', 'user', 'question'),
        message('s1', null, 'system', 'system'),
      ],
    }),
    100
  )

  assert.equal(result.complete, true)
  assert.equal(result.warning, null)
  assert.deepEqual(
    result.messages.map(({ id, parentId, role, text }) => ({
      id,
      parentId,
      role,
      text,
    })),
    [
      { id: 'u1', parentId: 's1', role: 'user', text: 'question' },
      { id: 'a1', parentId: 'u1', role: 'assistant', text: 'answer' },
    ]
  )
})

test('parseKimiHistory reports the fixed page limit as incomplete', () => {
  const messages = Array.from({ length: 100 }, (_, index) =>
    message(
      `m${index}`,
      index === 0 ? null : `m${index - 1}`,
      'user',
      `q${index}`
    )
  )

  const result = parseKimiHistory(JSON.stringify({ messages }), 100)

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /100-message limit/)
})

test('parseKimiHistory ignores unfinished assistant messages', () => {
  const result = parseKimiHistory(
    JSON.stringify({
      messages: [
        message(
          'a1',
          'u1',
          'assistant',
          'partial',
          'MESSAGE_STATUS_GENERATING'
        ),
        message('u1', null, 'user', 'question'),
      ],
    }),
    100
  )

  assert.deepEqual(
    result.messages.map(({ text }) => text),
    ['question']
  )
  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /could not be verified/)
})

test('parseKimiHistory requires a continuous unique message chain', () => {
  const result = parseKimiHistory(
    JSON.stringify({
      messages: [
        message('a1', 'missing', 'assistant', 'answer'),
        message('u1', 's1', 'user', 'question'),
        message('s1', null, 'system', 'system'),
      ],
    }),
    100
  )

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /message chain/)
})

test('parseKimiHistory treats cancelled assistant rows as terminal control records', () => {
  const result = parseKimiHistory(
    JSON.stringify({
      messages: [
        message('a2', 'u2', 'assistant', 'answer 2'),
        message('u2', 'a1', 'user', 'question 2'),
        message('a1', 'u1', 'assistant', '', 'MESSAGE_STATUS_CANCELLED'),
        message('u1', 's1', 'user', 'question 1'),
        message('s1', null, 'system', 'system'),
      ],
    }),
    100
  )

  assert.equal(result.complete, true)
  assert.deepEqual(
    result.messages.map(({ text }) => text),
    ['question 1', 'question 2', 'answer 2']
  )
})

test('parseKimiHistory keeps malformed responses incomplete', () => {
  const result = parseKimiHistory('{"unexpected":true}', 100)

  assert.equal(result.complete, false)
  assert.match(result.warning ?? '', /messages array/)
})
