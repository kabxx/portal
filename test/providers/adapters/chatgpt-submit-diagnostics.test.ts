import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildChatGptSubmitDiagnosticRecord,
  type ChatGptSubmitObservation,
  writeChatGptSubmitDiagnostic,
} from '../../../src/providers/adapters/chatgpt-submit-diagnostics.ts'

function observation(
  overrides: Partial<ChatGptSubmitObservation> = {}
): ChatGptSubmitObservation {
  return {
    phase: 'streaming',
    candidateRequestCount: 1,
    requestAmbiguous: false,
    ownedRequest: true,
    ownedUserMessageId: true,
    ownedHttpResponse: true,
    rawWebSocketFrameCount: 12,
    ownedWebSocketProgress: true,
    parsedHttpText: false,
    parsedWebSocketText: true,
    parsedOwnedText: true,
    parsedFinished: false,
    composerReady: false,
    ...overrides,
  }
}

test('ChatGPT diagnostics expose only bounded booleans and allowlisted buckets', () => {
  const record = buildChatGptSubmitDiagnosticRecord(
    observation(),
    'timeout',
    'stall'
  )

  assert.deepEqual(record, {
    version: 1,
    provider: 'chatgpt',
    outcome: 'timeout',
    timeoutPhase: 'stall',
    phase: 'streaming',
    candidateRequests: 'one',
    requestAmbiguous: false,
    ownedRequest: true,
    ownedUserMessageId: true,
    ownedHttpResponse: true,
    rawWebSocketFrames: 'many',
    ownedWebSocketProgress: true,
    parsedHttpText: false,
    parsedWebSocketText: true,
    parsedOwnedText: true,
    parsedFinished: false,
    composerReady: false,
    detailCode: 'terminal-marker-missing',
  })
})

test('ChatGPT diagnostics classify each response lifecycle failure', () => {
  const cases: Array<{
    overrides: Partial<ChatGptSubmitObservation>
    timeoutPhase: 'start' | 'stall' | null
    expected: ReturnType<
      typeof buildChatGptSubmitDiagnosticRecord
    >['detailCode']
  }> = [
    {
      overrides: { ownedRequest: false },
      timeoutPhase: 'start',
      expected: 'owned-request-missing',
    },
    {
      overrides: { requestAmbiguous: true },
      timeoutPhase: 'stall',
      expected: 'owned-request-ambiguous',
    },
    {
      overrides: {
        ownedHttpResponse: false,
        ownedWebSocketProgress: false,
        parsedHttpText: false,
        parsedWebSocketText: false,
        parsedOwnedText: false,
      },
      timeoutPhase: 'stall',
      expected: 'owned-response-missing',
    },
    {
      overrides: {
        ownedHttpResponse: false,
        ownedWebSocketProgress: true,
        parsedHttpText: false,
        parsedWebSocketText: false,
        parsedOwnedText: false,
      },
      timeoutPhase: 'stall',
      expected: 'owned-response-unparsed',
    },
    {
      overrides: { parsedOwnedText: false },
      timeoutPhase: 'stall',
      expected: 'owned-response-unparsed',
    },
    {
      overrides: {},
      timeoutPhase: 'stall',
      expected: 'terminal-marker-missing',
    },
    {
      overrides: { parsedFinished: true, phase: 'awaiting-composer' },
      timeoutPhase: null,
      expected: 'composer-not-ready',
    },
  ]

  for (const { overrides, timeoutPhase, expected } of cases) {
    assert.equal(
      buildChatGptSubmitDiagnosticRecord(
        observation(overrides),
        'timeout',
        timeoutPhase
      ).detailCode,
      expected
    )
  }
})

test('ChatGPT diagnostics write only when an explicit file is configured', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'portal-chatgpt-diag-')
  )
  const filePath = path.join(directory, 'diagnostics.jsonl')
  const previous = process.env.PORTAL_CHATGPT_DIAGNOSTICS_FILE
  process.env.PORTAL_CHATGPT_DIAGNOSTICS_FILE = filePath
  try {
    const record = buildChatGptSubmitDiagnosticRecord(
      observation({
        phase: 'composer-ready',
        parsedFinished: true,
        composerReady: true,
      }),
      'success',
      null
    )
    await writeChatGptSubmitDiagnostic(record)

    const serialized = await readFile(filePath, 'utf8')
    assert.deepEqual(JSON.parse(serialized), record)
    assert.doesNotMatch(
      serialized,
      /prompt|response text|cookie|token|session|request body|message-id/i
    )
  } finally {
    if (previous === undefined) {
      delete process.env.PORTAL_CHATGPT_DIAGNOSTICS_FILE
    } else {
      process.env.PORTAL_CHATGPT_DIAGNOSTICS_FILE = previous
    }
    await rm(directory, { recursive: true, force: true })
  }
})
