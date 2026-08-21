import { appendFile } from 'node:fs/promises'

const DIAGNOSTICS_PATH_ENV = 'PORTAL_CHATGPT_DIAGNOSTICS_FILE'

export type ChatGptSubmitPhase =
  | 'pre-dispatch'
  | 'awaiting-request'
  | 'awaiting-response'
  | 'streaming'
  | 'response-complete'
  | 'awaiting-composer'
  | 'composer-ready'

export type ChatGptSubmitDiagnosticOutcome =
  'success' | 'timeout' | 'error' | 'aborted'

export interface ChatGptSubmitObservation {
  phase: ChatGptSubmitPhase
  candidateRequestCount: number
  requestAmbiguous: boolean
  ownedRequest: boolean
  ownedUserMessageId: boolean
  ownedHttpResponse: boolean
  rawWebSocketFrameCount: number
  ownedWebSocketProgress: boolean
  parsedHttpText: boolean
  parsedWebSocketText: boolean
  parsedOwnedText: boolean
  parsedFinished: boolean
  composerReady: boolean
}

type CountBucket = 'none' | 'one' | 'many'
type FrameCountBucket = 'none' | 'one' | 'several' | 'many'

export interface ChatGptSubmitDiagnosticRecord {
  version: 1
  provider: 'chatgpt'
  outcome: ChatGptSubmitDiagnosticOutcome
  timeoutPhase: 'start' | 'stall' | null
  phase: ChatGptSubmitPhase
  candidateRequests: CountBucket
  requestAmbiguous: boolean
  ownedRequest: boolean
  ownedUserMessageId: boolean
  ownedHttpResponse: boolean
  rawWebSocketFrames: FrameCountBucket
  ownedWebSocketProgress: boolean
  parsedHttpText: boolean
  parsedWebSocketText: boolean
  parsedOwnedText: boolean
  parsedFinished: boolean
  composerReady: boolean
  detailCode:
    | 'none'
    | 'owned-request-missing'
    | 'owned-request-ambiguous'
    | 'owned-response-missing'
    | 'owned-response-unparsed'
    | 'terminal-marker-missing'
    | 'composer-not-ready'
    | 'transport-stalled'
    | 'operation-aborted'
    | 'other-error'
}

function countBucket(value: number): CountBucket {
  if (value <= 0) return 'none'
  return value === 1 ? 'one' : 'many'
}

function frameCountBucket(value: number): FrameCountBucket {
  if (value <= 0) return 'none'
  if (value === 1) return 'one'
  return value < 10 ? 'several' : 'many'
}

export function buildChatGptSubmitDiagnosticRecord(
  observation: Readonly<ChatGptSubmitObservation>,
  outcome: ChatGptSubmitDiagnosticOutcome,
  timeoutPhase: 'start' | 'stall' | null
): ChatGptSubmitDiagnosticRecord {
  let detailCode: ChatGptSubmitDiagnosticRecord['detailCode'] = 'none'
  if (outcome === 'aborted') {
    detailCode = 'operation-aborted'
  } else if (observation.requestAmbiguous) {
    detailCode = 'owned-request-ambiguous'
  } else if (!observation.ownedRequest) {
    detailCode = 'owned-request-missing'
  } else if (
    !observation.ownedHttpResponse &&
    !observation.ownedWebSocketProgress &&
    !observation.parsedHttpText &&
    !observation.parsedWebSocketText &&
    !observation.parsedOwnedText
  ) {
    detailCode = 'owned-response-missing'
  } else if (!observation.parsedOwnedText) {
    detailCode = 'owned-response-unparsed'
  } else if (!observation.parsedFinished) {
    detailCode =
      timeoutPhase === 'stall' ? 'terminal-marker-missing' : 'transport-stalled'
  } else if (
    observation.phase === 'awaiting-composer' &&
    !observation.composerReady
  ) {
    detailCode = 'composer-not-ready'
  } else if (outcome === 'error' || outcome === 'timeout') {
    detailCode = 'other-error'
  }

  return {
    version: 1,
    provider: 'chatgpt',
    outcome,
    timeoutPhase,
    phase: observation.phase,
    candidateRequests: countBucket(observation.candidateRequestCount),
    requestAmbiguous: observation.requestAmbiguous,
    ownedRequest: observation.ownedRequest,
    ownedUserMessageId: observation.ownedUserMessageId,
    ownedHttpResponse: observation.ownedHttpResponse,
    rawWebSocketFrames: frameCountBucket(observation.rawWebSocketFrameCount),
    ownedWebSocketProgress: observation.ownedWebSocketProgress,
    parsedHttpText: observation.parsedHttpText,
    parsedWebSocketText: observation.parsedWebSocketText,
    parsedOwnedText: observation.parsedOwnedText,
    parsedFinished: observation.parsedFinished,
    composerReady: observation.composerReady,
    detailCode,
  }
}

export async function writeChatGptSubmitDiagnostic(
  record: Readonly<ChatGptSubmitDiagnosticRecord>
): Promise<void> {
  const filePath = process.env[DIAGNOSTICS_PATH_ENV]
  if (!filePath) return
  await appendFile(filePath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  }).catch(() => {})
}
