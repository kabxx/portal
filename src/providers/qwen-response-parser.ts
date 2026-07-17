export interface QwenStreamError {
  code: string
  message: string | null
}

export interface QwenParsedResponse {
  text: string
  isFinished: boolean
  chatId: string | null
  responseId: string | null
  parentId: string | null
  identityConsistent: boolean
  error: QwenStreamError | null
}

export function parseQwenResponse(raw: string): QwenParsedResponse | null {
  let text = ''
  let isFinished = false
  let chatId: string | null = null
  let responseId: string | null = null
  let parentId: string | null = null
  let identityConsistent = true
  let streamError: QwenStreamError | null = null
  let recognized = false

  for (const payload of readSsePayloads(raw)) {
    const parsed = parseJson(payload)
    if (!isRecord(parsed)) continue

    const created = asRecord(parsed['response.created'])
    if (created !== null) {
      recognized = true
      const createdChatId = stringValue(created.chat_id)
      const createdResponseId = stringValue(created.response_id)
      const createdParentId = stringValue(created.parent_id)
      identityConsistent &&=
        chatId === null || createdChatId === null || chatId === createdChatId
      identityConsistent &&=
        responseId === null ||
        createdResponseId === null ||
        responseId === createdResponseId
      chatId = createdChatId ?? chatId
      responseId = createdResponseId ?? responseId
      parentId = createdParentId ?? parentId
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    const choice = asRecord(choices[0])
    const delta = asRecord(choice?.delta)
    if (delta !== null) {
      recognized = true
      const deltaResponseId = stringValue(parsed.response_id)
      identityConsistent &&=
        responseId === null ||
        deltaResponseId === null ||
        responseId === deltaResponseId
      responseId = deltaResponseId ?? responseId
      const phase = stringValue(delta.phase)
      const status = stringValue(delta.status)
      if (phase === 'answer' && typeof delta.content === 'string') {
        text += delta.content
      }
      if (phase === 'answer' && status === 'finished') {
        isFinished = true
      }
      streamError = readStreamError(delta.error) ?? streamError
    }

    streamError =
      readStreamError(parsed.error) ??
      readStreamError(asRecord(parsed.data)?.error) ??
      streamError
  }

  if (!recognized && streamError === null) return null
  return {
    text,
    isFinished,
    chatId,
    responseId,
    parentId,
    identityConsistent,
    error: streamError,
  }
}

function readSsePayloads(raw: string): string[] {
  const payloads: string[] = []
  let dataLines: string[] = []

  const flush = () => {
    if (dataLines.length > 0) payloads.push(dataLines.join('\n'))
    dataLines = []
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    if (line === 'data') {
      dataLines.push('')
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  flush()
  return payloads
}

function readStreamError(value: unknown): QwenStreamError | null {
  const error = asRecord(value)
  if (error === null) return null
  const code = stringValue(error.code) ?? stringValue(error.type) ?? 'UNKNOWN'
  const message =
    stringValue(error.message) ??
    stringValue(error.detail) ??
    stringValue(error.msg)
  return { code, message }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
