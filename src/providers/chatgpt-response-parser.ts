export interface ChatGPTParsedResponse {
  conversationId?: string
  messageId?: string
  text: string
  isFinished: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function readConversationId(node: Record<string, unknown>): string | undefined {
  const value = node.conversation_id ?? node.conversationId
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readMessageId(node: Record<string, unknown>): string | undefined {
  const value = node.message_id ?? node.messageId ?? node.id
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readRole(node: Record<string, unknown>): string | undefined {
  if (typeof node.role === 'string') {
    return node.role
  }
  const author = asRecord(node.author)
  return typeof author?.role === 'string' ? author.role : undefined
}

function readFinished(node: Record<string, unknown>): boolean {
  if (
    node.isFinished === true ||
    node.done === true ||
    node.final === true ||
    node.end_turn === true
  ) {
    return true
  }

  const status =
    typeof node.status === 'string' ? node.status.toLowerCase() : ''
  if (
    status.includes('finish') ||
    status.includes('complete') ||
    status.includes('done')
  ) {
    return true
  }

  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  return (
    type.includes('finish') ||
    type.includes('complete') ||
    type.includes('done')
  )
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text || /^https?:\/\//.test(text) || text.startsWith('wss://')) {
      return undefined
    }
    return text
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => readText(item))
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0
      )
      .join('')
    return text.trim() ? text : undefined
  }

  const node = asRecord(value)
  if (!node) {
    return undefined
  }

  const candidates = [
    readText(node.text),
    readText(node.delta),
    readText(node.parts),
    readText(node.content),
    readText(node.markdown),
  ].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  )

  if (candidates.length > 0) {
    return candidates.join('\n').trim()
  }

  return undefined
}

function isVisibleMessage(node: Record<string, unknown>): boolean {
  const metadata = asRecord(node.metadata)
  if (metadata?.is_visually_hidden_from_conversation === true) {
    return false
  }

  const channel =
    typeof node.channel === 'string' ? node.channel.toLowerCase() : null
  if (channel !== null && channel !== 'final') {
    return false
  }

  return true
}

function formatReferenceId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value
  }

  const node = asRecord(value)
  if (!node) {
    return null
  }

  const turnIndex = typeof node.turn_index === 'number' ? node.turn_index : null
  const refType = typeof node.ref_type === 'string' ? node.ref_type : null
  const refIndex = typeof node.ref_index === 'number' ? node.ref_index : null
  if (turnIndex === null || refType === null || refIndex === null) {
    return null
  }

  return `turn${turnIndex}${refType}${refIndex}`
}

function collectReferenceUrls(value: unknown): Map<string, string> {
  const results = new Map<string, string>()

  const visit = (nodeValue: unknown): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item)
      }
      return
    }

    const node = asRecord(nodeValue)
    if (!node) {
      return
    }

    const referenceId = formatReferenceId(node.ref_id)
    const url =
      typeof node.url === 'string' && node.url.trim() ? node.url : null
    if (referenceId !== null && url !== null && !results.has(referenceId)) {
      results.set(referenceId, url)
    }

    const refs = Array.isArray(node.refs) ? node.refs : null
    if (refs !== null && url !== null) {
      for (const ref of refs) {
        const groupedReferenceId = formatReferenceId(ref)
        if (groupedReferenceId !== null && !results.has(groupedReferenceId)) {
          results.set(groupedReferenceId, url)
        }
      }
    }

    for (const child of Object.values(node)) {
      visit(child)
    }
  }

  visit(value)
  return results
}

export function normalizeChatGptEntityMarkers(text: string): string {
  const prefix = '\uE200entity'
  const separator = '\uE202'
  const terminator = '\uE201'
  let cursor = 0
  let normalized = ''

  while (cursor < text.length) {
    const markerStart = text.indexOf(prefix, cursor)
    if (markerStart === -1) {
      normalized += text.slice(cursor)
      break
    }

    normalized += text.slice(cursor, markerStart)
    let payloadStart = markerStart + prefix.length
    if (text[payloadStart] === separator) {
      payloadStart++
    }
    if (text[payloadStart] !== '[') {
      normalized += prefix
      cursor = markerStart + prefix.length
      continue
    }

    const markerEnd = text.indexOf(terminator, payloadStart)
    if (markerEnd === -1) {
      normalized += text.slice(markerStart)
      break
    }

    const payloadEnd =
      text[markerEnd - 1] === separator ? markerEnd - 1 : markerEnd
    const originalMarker = text.slice(markerStart, markerEnd + 1)
    let payload: unknown
    try {
      payload = JSON.parse(text.slice(payloadStart, payloadEnd))
    } catch {
      normalized += originalMarker
      cursor = markerEnd + 1
      continue
    }

    const entityFields = Array.isArray(payload) ? (payload as unknown[]) : null
    const displayName = entityFields?.[1]
    if (typeof displayName !== 'string' || displayName.length === 0) {
      normalized += originalMarker
    } else {
      normalized += displayName
    }
    cursor = markerEnd + 1
  }

  return normalized
}

function stripInlineReferenceMarkers(text: string): string {
  return normalizeChatGptEntityMarkers(text)
    .replace(
      /\uE200(?:cite|i)\uE202(?:turn[^\s\uE200\uE201\uE202]+\uE202?)+\uE201?/g,
      ''
    )
    .replace(/[\uE201\uE202]+/g, '')
    .trim()
}

function normalizeAssistantTextWithReferenceMap(
  text: string,
  referenceMap: ReadonlyMap<string, string>
): string {
  const cleanedText = stripInlineReferenceMarkers(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const referenceUrls = [...text.matchAll(/turn\d+[a-z_]+\d+/gi)]
    .map((match) => match[0])
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((referenceId) => referenceMap.get(referenceId) ?? null)
    .filter(
      (value, index, values): value is string =>
        value !== null && values.indexOf(value) === index
    )

  if (referenceUrls.length === 0) {
    return cleanedText
  }

  return [cleanedText, ...referenceUrls].filter(Boolean).join('\n')
}

function normalizeAssistantTextFromReferences(
  text: string,
  message: Record<string, unknown>
): string {
  return normalizeAssistantTextWithReferenceMap(
    text,
    collectReferenceUrls(message)
  )
}

function readToolMultimodalResponse(
  message: Record<string, unknown>
): ChatGPTParsedResponse | null {
  const role = readRole(message)
  const content = asRecord(message.content)
  const contentType =
    typeof content?.content_type === 'string' ? content.content_type : ''
  if (
    role !== 'tool' ||
    contentType !== 'multimodal_text' ||
    !isVisibleMessage(message)
  ) {
    return null
  }

  const conversationId = readConversationId(message)
  const messageId = readMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    text: '[ChatGPT image generation completed in the UI. This transport payload did not include direct image URLs.]',
    isFinished: readFinished(message),
  }
}

function readResponseFromMessage(
  message: Record<string, unknown>
): ChatGPTParsedResponse | null {
  const role = readRole(message)
  const rawText = readText(message.content ?? message)
  const text = rawText
    ? normalizeAssistantTextFromReferences(rawText, message)
    : rawText
  if (role !== 'assistant' || !text || !isVisibleMessage(message)) {
    return readToolMultimodalResponse(message)
  }

  const conversationId = readConversationId(message)
  const messageId = readMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    text,
    isFinished: readFinished(message),
  }
}

function collectResponses(value: unknown): ChatGPTParsedResponse[] {
  const results: ChatGPTParsedResponse[] = []

  const visit = (nodeValue: unknown): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item)
      }
      return
    }

    const node = asRecord(nodeValue)
    if (!node) {
      return
    }

    const response = readResponseFromMessage(node)
    if (response !== null) {
      results.push(response)
    }

    for (const child of Object.values(node)) {
      visit(child)
    }
  }

  visit(value)
  return results
}

function pickBestResponse(
  results: readonly ChatGPTParsedResponse[]
): ChatGPTParsedResponse | null {
  const best =
    [...results]
      .reverse()
      .find((item) => item.isFinished && item.text.trim()) ??
    [...results].reduce<ChatGPTParsedResponse | null>((best, current) => {
      if (!current.text.trim()) {
        return best
      }
      if (best === null || current.text.length >= best.text.length) {
        return current
      }
      return best
    }, null)

  return best === null
    ? null
    : {
        ...best,
        text: stripInlineReferenceMarkers(best.text),
      }
}

export function parseChatGptWebSocketFrames(
  frames: readonly string[]
): ChatGPTParsedResponse | null {
  const results: ChatGPTParsedResponse[] = []
  const aggregatedReferenceUrls = new Map<string, string>()
  const streamedResponses = new Map<string, ChatGPTParsedResponse>()
  let activeMessageId: string | null = null

  // A WebSocket frame can wrap one or more JSON values in transport text.
  const extractJsonChunks = (value: string): string[] => {
    const chunks: string[] = []

    for (let i = 0; i < value.length; i++) {
      const startChar = value[i]
      if (startChar !== '[' && startChar !== '{') {
        continue
      }

      let depth = 0
      let inString = false
      let isEscaped = false

      for (let j = i; j < value.length; j++) {
        const char = value[j]

        if (inString) {
          if (isEscaped) {
            isEscaped = false
          } else if (char === '\\') {
            isEscaped = true
          } else if (char === '"') {
            inString = false
          }
          continue
        }

        if (char === '"') {
          inString = true
          continue
        }

        if (char === '[' || char === '{') {
          depth++
          continue
        }

        if (char === ']' || char === '}') {
          depth--
          if (depth === 0) {
            chunks.push(value.slice(i, j + 1))
            i = j
            break
          }
        }
      }
    }

    return chunks
  }

  // Each outer JSON value can carry an encoded SSE event from ChatGPT.
  const extractEncodedItems = (
    value: unknown
  ): Array<{
    encodedItem: string
    conversationId?: string
  }> => {
    const items: Array<{
      encodedItem: string
      conversationId?: string
    }> = []

    const visit = (nodeValue: unknown): void => {
      if (Array.isArray(nodeValue)) {
        for (const item of nodeValue) {
          visit(item)
        }
        return
      }

      const node = asRecord(nodeValue)
      if (!node) {
        return
      }

      if (typeof node.encoded_item === 'string') {
        const conversationId = readConversationId(node)
        items.push({
          encodedItem: node.encoded_item,
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      }

      for (const child of Object.values(node)) {
        visit(child)
      }
    }

    visit(value)
    return items
  }

  const parseEncodedItem = (
    encodedItem: string
  ): {
    eventType?: string
    data?: string
  } => {
    const lines = encodedItem.split(/\r?\n/)
    let eventType: string | undefined
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice('event:'.length).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim())
      }
    }

    return {
      ...(eventType !== undefined ? { eventType } : {}),
      ...(dataLines.length > 0 ? { data: dataLines.join('\n') } : {}),
    }
  }

  const upsertStreamedResponse = (
    messageId: string,
    update: (current: ChatGPTParsedResponse | null) => ChatGPTParsedResponse
  ): void => {
    streamedResponses.set(
      messageId,
      update(streamedResponses.get(messageId) ?? null)
    )
  }

  const applyAssistantMessage = (
    message: Record<string, unknown>,
    fallbackConversationId?: string
  ): void => {
    if (readRole(message) !== 'assistant' || !isVisibleMessage(message)) {
      return
    }

    const content = asRecord(message.content)
    const contentType =
      typeof content?.content_type === 'string' ? content.content_type : ''
    if (contentType !== 'text') {
      return
    }

    const messageId = readMessageId(message)
    if (messageId === undefined) {
      return
    }

    const conversationId = readConversationId(message) ?? fallbackConversationId
    const rawText = readText(content?.parts) ?? ''
    const text = rawText
      ? normalizeAssistantTextFromReferences(rawText, message)
      : rawText
    const isFinished = readFinished(message)

    upsertStreamedResponse(messageId, (current) => ({
      ...(conversationId !== undefined
        ? { conversationId }
        : current?.conversationId !== undefined
          ? { conversationId: current.conversationId }
          : {}),
      messageId,
      text: text || current?.text || '',
      isFinished: current?.isFinished === true || isFinished,
    }))
    activeMessageId = messageId
  }

  const appendToActiveMessage = (text: string): void => {
    if (activeMessageId === null || !text) {
      return
    }

    upsertStreamedResponse(activeMessageId, (current) => {
      if (current === null) {
        return {
          messageId: activeMessageId!,
          text,
          isFinished: false,
        }
      }
      return {
        ...current,
        text: `${current.text}${text}`,
      }
    })
  }

  const markActiveMessageFinished = (): void => {
    if (activeMessageId === null) {
      return
    }

    upsertStreamedResponse(activeMessageId, (current) => ({
      ...(current ?? {
        messageId: activeMessageId!,
        text: '',
        isFinished: false,
      }),
      isFinished: true,
    }))
  }

  const applyPatchOperations = (operations: readonly unknown[]): void => {
    for (const operationValue of operations) {
      const operation = asRecord(operationValue)
      if (!operation) {
        continue
      }

      const path = typeof operation.p === 'string' ? operation.p : ''
      const action = typeof operation.o === 'string' ? operation.o : ''
      const value = operation.v

      if (path === '/message/content/parts/0' && typeof value === 'string') {
        if (action === 'replace') {
          if (activeMessageId === null) {
            continue
          }
          upsertStreamedResponse(activeMessageId, (current) => ({
            ...(current ?? {
              messageId: activeMessageId!,
              text: '',
              isFinished: false,
            }),
            text: value,
          }))
          continue
        }
        if (action === 'append') {
          appendToActiveMessage(value)
          continue
        }
      }

      if (path === '/message/status' && typeof value === 'string') {
        if (
          value.toLowerCase().includes('finish') ||
          value.toLowerCase().includes('complete')
        ) {
          markActiveMessageFinished()
        }
        continue
      }

      if (path === '/message/end_turn' && value === true) {
        markActiveMessageFinished()
        continue
      }

      if (path === '/message/metadata') {
        const metadata = asRecord(value)
        if (metadata?.is_complete === true) {
          markActiveMessageFinished()
        }
      }
    }
  }

  for (const frame of frames) {
    for (const chunk of extractJsonChunks(frame)) {
      try {
        const parsedChunk: unknown = JSON.parse(chunk)
        results.push(...collectResponses(parsedChunk))
        for (const [referenceId, url] of collectReferenceUrls(
          parsedChunk
        ).entries()) {
          if (!aggregatedReferenceUrls.has(referenceId)) {
            aggregatedReferenceUrls.set(referenceId, url)
          }
        }
        for (const item of extractEncodedItems(parsedChunk)) {
          const { eventType, data } = parseEncodedItem(item.encodedItem)
          if (!data) {
            continue
          }

          let parsedData: unknown
          try {
            parsedData = JSON.parse(data)
          } catch {
            continue
          }

          for (const [referenceId, url] of collectReferenceUrls(
            parsedData
          ).entries()) {
            if (!aggregatedReferenceUrls.has(referenceId)) {
              aggregatedReferenceUrls.set(referenceId, url)
            }
          }

          // Delta payloads either establish the active message or patch it.
          if (eventType === 'delta') {
            const delta = asRecord(parsedData)
            if (!delta) {
              continue
            }

            const deltaValue = asRecord(delta.v)
            const message = deltaValue ? asRecord(deltaValue.message) : null
            if (message) {
              applyAssistantMessage(message, item.conversationId)
            }

            if (
              typeof delta.p === 'string' &&
              delta.p === '/message/content/parts/0' &&
              delta.o === 'append' &&
              typeof delta.v === 'string'
            ) {
              appendToActiveMessage(delta.v)
              continue
            }

            if (delta.o === 'patch' && Array.isArray(delta.v)) {
              applyPatchOperations(delta.v)
              continue
            }

            if (typeof delta.v === 'string') {
              appendToActiveMessage(delta.v)
            }
            continue
          }

          const payload = asRecord(parsedData)
          if (payload?.type === 'message_stream_complete') {
            markActiveMessageFinished()
          }
        }
      } catch {
        continue
      }
    }
  }

  results.push(
    ...[...streamedResponses.values()].map((response) => ({
      ...response,
      text: normalizeAssistantTextWithReferenceMap(
        response.text,
        aggregatedReferenceUrls
      ),
    }))
  )
  return pickBestResponse(results)
}

function parseChatGptHttpSseResponse(
  raw: string
): ChatGPTParsedResponse | null {
  const results: ChatGPTParsedResponse[] = []
  const streamedResponses = new Map<string, ChatGPTParsedResponse>()
  let activeMessageId: string | null = null

  const upsertStreamedResponse = (
    messageId: string,
    update: (current: ChatGPTParsedResponse | null) => ChatGPTParsedResponse
  ): void => {
    streamedResponses.set(
      messageId,
      update(streamedResponses.get(messageId) ?? null)
    )
  }

  const applyAssistantMessage = (
    message: Record<string, unknown>,
    fallbackConversationId?: string
  ): void => {
    if (readRole(message) !== 'assistant' || !isVisibleMessage(message)) {
      return
    }

    const content = asRecord(message.content)
    const contentType =
      typeof content?.content_type === 'string' ? content.content_type : ''
    if (contentType !== 'text') {
      return
    }

    const messageId = readMessageId(message)
    if (messageId === undefined) {
      return
    }

    const conversationId = readConversationId(message) ?? fallbackConversationId
    const text = readText(content?.parts) ?? ''
    const isFinished = readFinished(message)

    upsertStreamedResponse(messageId, (current) => ({
      ...(conversationId !== undefined
        ? { conversationId }
        : current?.conversationId !== undefined
          ? { conversationId: current.conversationId }
          : {}),
      messageId,
      text: text || current?.text || '',
      isFinished: current?.isFinished === true || isFinished,
    }))
    activeMessageId = messageId
  }

  const appendToActiveMessage = (text: string): void => {
    if (activeMessageId === null || !text) {
      return
    }

    upsertStreamedResponse(activeMessageId, (current) => {
      if (current === null) {
        return {
          messageId: activeMessageId!,
          text,
          isFinished: false,
        }
      }
      return {
        ...current,
        text: `${current.text}${text}`,
      }
    })
  }

  const markActiveMessageFinished = (): void => {
    if (activeMessageId === null) {
      return
    }

    upsertStreamedResponse(activeMessageId, (current) => ({
      ...(current ?? {
        messageId: activeMessageId!,
        text: '',
        isFinished: false,
      }),
      isFinished: true,
    }))
  }

  const applyPatchOperations = (operations: readonly unknown[]): void => {
    for (const operationValue of operations) {
      const operation = asRecord(operationValue)
      if (!operation) {
        continue
      }

      const path = typeof operation.p === 'string' ? operation.p : ''
      const action = typeof operation.o === 'string' ? operation.o : ''
      const value = operation.v

      if (path === '/message/content/parts/0' && typeof value === 'string') {
        if (action === 'replace') {
          if (activeMessageId === null) {
            continue
          }
          upsertStreamedResponse(activeMessageId, (current) => ({
            ...(current ?? {
              messageId: activeMessageId!,
              text: '',
              isFinished: false,
            }),
            text: value,
          }))
          continue
        }
        if (action === 'append') {
          appendToActiveMessage(value)
          continue
        }
      }

      if (path === '/message/status' && typeof value === 'string') {
        if (
          value.toLowerCase().includes('finish') ||
          value.toLowerCase().includes('complete')
        ) {
          markActiveMessageFinished()
        }
        continue
      }

      if (path === '/message/end_turn' && value === true) {
        markActiveMessageFinished()
        continue
      }

      if (path === '/message/metadata') {
        const metadata = asRecord(value)
        if (metadata?.is_complete === true) {
          markActiveMessageFinished()
        }
      }
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue
    }

    const data = line.slice('data:'.length).trim()
    if (!data || data === '[DONE]') {
      continue
    }

    let parsedData: unknown
    try {
      parsedData = JSON.parse(data)
    } catch {
      continue
    }

    results.push(...collectResponses(parsedData))
    const payload = asRecord(parsedData)
    if (!payload) {
      continue
    }

    const deltaValue = asRecord(payload.v)
    const message = deltaValue ? asRecord(deltaValue.message) : null
    if (message) {
      applyAssistantMessage(
        message,
        readConversationId(payload) ?? readConversationId(deltaValue ?? {})
      )
    }

    if (
      typeof payload.p === 'string' &&
      payload.p === '/message/content/parts/0' &&
      payload.o === 'append' &&
      typeof payload.v === 'string'
    ) {
      appendToActiveMessage(payload.v)
      continue
    }

    if (payload.o === 'patch' && Array.isArray(payload.v)) {
      applyPatchOperations(payload.v)
      continue
    }

    if (typeof payload.v === 'string') {
      appendToActiveMessage(payload.v)
      continue
    }

    if (payload.type === 'message_stream_complete') {
      markActiveMessageFinished()
    }
  }

  results.push(...streamedResponses.values())
  return pickBestResponse(results)
}

export function parseChatGptHttpResponse(
  raw: string
): ChatGPTParsedResponse | null {
  let root: unknown

  try {
    root = JSON.parse(raw)
  } catch {
    return parseChatGptHttpSseResponse(raw)
  }

  const rootRecord = asRecord(root)
  if (!rootRecord) {
    return null
  }

  const conversationId =
    typeof rootRecord.conversation_id === 'string'
      ? rootRecord.conversation_id
      : undefined
  const currentNodeId =
    typeof rootRecord.current_node === 'string'
      ? rootRecord.current_node
      : undefined
  const mapping = asRecord(rootRecord.mapping)

  if (currentNodeId !== undefined && mapping) {
    const currentNode = asRecord(mapping[currentNodeId])
    const message = currentNode ? asRecord(currentNode.message) : null
    if (message) {
      const response = readResponseFromMessage({
        ...message,
        ...(conversationId !== undefined
          ? { conversation_id: conversationId }
          : {}),
      })
      if (response !== null) {
        return response
      }
    }
  }

  return pickBestResponse(collectResponses(root))
}
