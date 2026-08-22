export interface ChatGPTParsedResponse {
  conversationId?: string
  messageId?: string
  parentMessageId?: string
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

function readParentMessageId(
  node: Record<string, unknown>
): string | undefined {
  const metadata = asRecord(node.metadata)
  const value =
    node.parent_id ?? node.parentId ?? metadata?.parent_id ?? metadata?.parentId
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

function collectNodeReferenceUrls(
  node: Record<string, unknown>,
  results: Map<string, string>,
  isGroupedReferenceAllowed: (value: unknown) => boolean = () => true
): void {
  const referenceId = formatReferenceId(node.ref_id)
  const url = typeof node.url === 'string' && node.url.trim() ? node.url : null
  if (referenceId !== null && url !== null && !results.has(referenceId)) {
    results.set(referenceId, url)
  }

  const refs = Array.isArray(node.refs) ? node.refs : null
  if (refs !== null && url !== null) {
    for (const ref of refs) {
      if (!isGroupedReferenceAllowed(ref)) continue
      const groupedReferenceId = formatReferenceId(ref)
      if (groupedReferenceId !== null && !results.has(groupedReferenceId)) {
        results.set(groupedReferenceId, url)
      }
    }
  }
}

function collectReferenceUrls(value: unknown): Map<string, string> {
  const results = new Map<string, string>()
  const visit = (nodeValue: unknown): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) visit(item)
      return
    }
    const node = asRecord(nodeValue)
    if (!node) return
    collectNodeReferenceUrls(node, results)
    for (const child of Object.values(node)) visit(child)
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
  const parentMessageId = readParentMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(parentMessageId !== undefined ? { parentMessageId } : {}),
    text: '[ChatGPT image generation completed in the UI. This transport payload did not include direct image URLs.]',
    isFinished: readFinished(message),
  }
}

function readResponseFromMessage(
  message: Record<string, unknown>,
  normalizeReferences = true
): ChatGPTParsedResponse | null {
  const role = readRole(message)
  const content = asRecord(message.content)
  const contentType =
    typeof content?.content_type === 'string' ? content.content_type : null
  if (role === 'assistant' && contentType !== 'text') {
    return readToolMultimodalResponse(message)
  }
  const rawText = readText(message.content ?? message)
  const text =
    rawText && normalizeReferences
      ? normalizeAssistantTextFromReferences(rawText, message)
      : rawText
  if (role !== 'assistant' || !text || !isVisibleMessage(message)) {
    return readToolMultimodalResponse(message)
  }

  const conversationId = readConversationId(message)
  const messageId = readMessageId(message)
  const parentMessageId = readParentMessageId(message)
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(parentMessageId !== undefined ? { parentMessageId } : {}),
    text,
    isFinished: readFinished(message),
  }
}

function collectResponses(
  value: unknown,
  conversationId?: string
): ChatGPTParsedResponse[] {
  const results: ChatGPTParsedResponse[] = []

  const visit = (
    nodeValue: unknown,
    inheritedConversationId?: string
  ): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) {
        visit(item, inheritedConversationId)
      }
      return
    }

    const node = asRecord(nodeValue)
    if (!node) {
      return
    }

    const nodeConversationId =
      readConversationId(node) ?? inheritedConversationId
    const response = readResponseFromMessage(node)
    if (response !== null) {
      results.push({
        ...response,
        ...(response.conversationId === undefined &&
        nodeConversationId !== undefined
          ? { conversationId: nodeConversationId }
          : {}),
      })
    }

    for (const child of Object.values(node)) {
      visit(child, nodeConversationId)
    }
  }

  visit(value, conversationId)
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

function extractChatGptJsonChunks(value: string): string[] {
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const startChar = value[index]
    if (startChar !== '[' && startChar !== '{') continue

    let depth = 0
    let inString = false
    let isEscaped = false
    for (let cursor = index; cursor < value.length; cursor += 1) {
      const char = value[cursor]
      if (inString) {
        if (isEscaped) isEscaped = false
        else if (char === '\\') isEscaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '[' || char === '{') depth += 1
      else if (char === ']' || char === '}') {
        depth -= 1
        if (depth === 0) {
          chunks.push(value.slice(index, cursor + 1))
          index = cursor
          break
        }
      }
    }
  }
  return chunks
}

function extractChatGptEncodedItems(
  value: unknown,
  conversationId?: string
): Array<{ encodedItem: string; conversationId?: string }> {
  const items: Array<{ encodedItem: string; conversationId?: string }> = []
  const visit = (
    nodeValue: unknown,
    inheritedConversationId?: string
  ): void => {
    if (Array.isArray(nodeValue)) {
      for (const item of nodeValue) visit(item, inheritedConversationId)
      return
    }
    const node = asRecord(nodeValue)
    if (!node) return
    const nodeConversationId =
      readConversationId(node) ?? inheritedConversationId
    if (typeof node.encoded_item === 'string') {
      items.push({
        encodedItem: node.encoded_item,
        ...(nodeConversationId === undefined
          ? {}
          : { conversationId: nodeConversationId }),
      })
    }
    for (const child of Object.values(node)) {
      visit(child, nodeConversationId)
    }
  }
  visit(value, conversationId)
  return items
}

function readChatGptEncodedData(encodedItem: string): unknown {
  const data = encodedItem
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

interface ChatGptMappingEntry {
  readonly id: string
  readonly parentId?: string
  readonly response: ChatGPTParsedResponse | null
}

function pickMappedResponse(
  root: Record<string, unknown>
): ChatGPTParsedResponse | null {
  const mapping = asRecord(root.mapping)
  if (mapping === null) return null

  const conversationId = readConversationId(root)
  const entries = new Map<string, ChatGptMappingEntry>()
  for (const [id, value] of Object.entries(mapping)) {
    const node = asRecord(value)
    if (node === null) continue
    const message = asRecord(node.message)
    const response =
      message === null
        ? null
        : readResponseFromMessage({
            ...message,
            ...(conversationId === undefined
              ? {}
              : { conversation_id: conversationId }),
          })
    const parentId =
      typeof node.parent === 'string'
        ? node.parent
        : typeof node.parent_id === 'string'
          ? node.parent_id
          : message !== null
            ? readParentMessageId(message)
            : undefined
    entries.set(id, {
      id,
      ...(parentId === undefined ? {} : { parentId }),
      response,
    })
  }

  const currentNodeId =
    typeof root.current_node === 'string' ? root.current_node : undefined
  const current =
    currentNodeId === undefined ? undefined : entries.get(currentNodeId)
  if (current?.response !== null && current?.response?.text.trim()) {
    return stripParsedResponse(current.response)
  }

  const childIds = new Set<string>()
  for (const entry of entries.values()) {
    if (entry.parentId !== undefined) childIds.add(entry.parentId)
  }
  const terminalResponses = [...entries.values()]
    .filter(
      (entry) =>
        !childIds.has(entry.id) &&
        entry.response !== null &&
        entry.response.isFinished &&
        entry.response.text.trim()
    )
    .map((entry) => entry.response!)
  if (terminalResponses.length === 1) {
    return stripParsedResponse(terminalResponses[0]!)
  }

  return null
}

function stripParsedResponse(
  response: ChatGPTParsedResponse
): ChatGPTParsedResponse {
  return {
    ...response,
    text: stripInlineReferenceMarkers(response.text),
  }
}

function readChatGptEncodedEventType(encodedItem: string): string | null {
  const eventLine = encodedItem
    .split(/\r?\n/)
    .find((line) => line.startsWith('event:'))
  return eventLine?.slice('event:'.length).trim() || null
}

export interface ChatGptWebSocketResponseTrackerOptions {
  requireExpectedConversationId?: boolean
  requireSingleMessageId?: boolean
  expectedMessageId?: string
  expectedParentMessageId?: string
}

export class ChatGptWebSocketResponseTracker {
  private readonly aggregatedReferenceUrls = new Map<string, string>()
  private readonly streamedResponses = new Map<string, ChatGPTParsedResponse>()
  private readonly directMessageIds = new Set<string>()
  private readonly ownedMessageIds = new Set<string>()
  private readonly ownedProgressKeys = new Set<string>()
  private readonly ownedProgressNodes = new Map<
    string,
    { node: Record<string, unknown>; conversationId?: string }
  >()
  private readonly restrictConversation: boolean
  private readonly invalidInitialCorrelation: boolean
  private activeMessageId: string | null = null
  private ownedConversationId: string | null
  private directBest: ChatGPTParsedResponse | null = null
  private cachedResponse: ChatGPTParsedResponse | null = null
  private ownedProgressCount = 0

  public constructor(
    expectedConversationId?: string | null,
    private readonly options: ChatGptWebSocketResponseTrackerOptions = {}
  ) {
    this.restrictConversation = typeof expectedConversationId === 'string'
    this.ownedConversationId = expectedConversationId ?? null
    this.invalidInitialCorrelation =
      options.requireExpectedConversationId === true &&
      this.ownedConversationId === null &&
      options.expectedMessageId === undefined &&
      options.expectedParentMessageId === undefined
    if (options.expectedMessageId !== undefined) {
      this.ownedMessageIds.add(options.expectedMessageId)
    }
    if (options.expectedParentMessageId !== undefined) {
      this.ownedMessageIds.add(options.expectedParentMessageId)
    }
  }

  public pushFrames(frames: readonly string[]): ChatGPTParsedResponse | null {
    if (this.invalidInitialCorrelation) return null
    if (frames.length === 0) return this.cachedResponse
    for (const frame of frames) this.processFrame(frame)
    this.cachedResponse = this.currentResponse()
    return this.cachedResponse
  }

  public getOwnedProgressCount(): number {
    return this.ownedProgressCount
  }

  private responseMatches(response: ChatGPTParsedResponse): boolean {
    if (
      response.conversationId !== undefined &&
      this.ownedConversationId !== null &&
      response.conversationId !== this.ownedConversationId
    ) {
      return false
    }

    if (
      this.options.expectedMessageId === undefined &&
      this.options.expectedParentMessageId === undefined
    ) {
      return true
    }

    const hasOwnedMessageId =
      response.messageId !== undefined &&
      this.ownedMessageIds.has(response.messageId)
    const hasOwnedParentId =
      response.parentMessageId !== undefined &&
      this.ownedMessageIds.has(response.parentMessageId)
    return (
      response.messageId === this.options.expectedMessageId ||
      response.parentMessageId === this.options.expectedParentMessageId ||
      hasOwnedMessageId ||
      hasOwnedParentId
    )
  }

  private acceptDirectResponse(response: ChatGPTParsedResponse): void {
    if (!this.responseMatches(response)) return
    if (response.conversationId !== undefined) {
      this.ownedConversationId ??= response.conversationId
    }
    if (response.messageId !== undefined) {
      this.directMessageIds.add(response.messageId)
      this.ownedMessageIds.add(response.messageId)
      this.activeMessageId = response.messageId
      this.upsertStreamedResponse(response.messageId, (current) => ({
        ...response,
        text:
          current !== null && current.text.length > response.text.length
            ? current.text
            : response.text,
        isFinished: current?.isFinished === true || response.isFinished,
      }))
    }
    if (
      this.directBest === null ||
      response.isFinished ||
      (!this.directBest.isFinished &&
        response.text.length >= this.directBest.text.length)
    ) {
      this.directBest = response
    }
  }

  private collectDirectResponses(
    value: unknown,
    conversationId?: string
  ): ChatGPTParsedResponse[] {
    const responses: ChatGPTParsedResponse[] = []
    const visit = (nodeValue: unknown, inheritedConversationId?: string) => {
      if (Array.isArray(nodeValue)) {
        for (const item of nodeValue) visit(item, inheritedConversationId)
        return
      }
      const node = asRecord(nodeValue)
      if (!node) return
      const nodeConversationId =
        readConversationId(node) ?? inheritedConversationId
      if (
        nodeConversationId !== undefined &&
        this.ownedConversationId !== null &&
        nodeConversationId !== this.ownedConversationId
      ) {
        return
      }
      const response = readResponseFromMessage(node, false)
      if (response !== null) {
        responses.push({
          ...response,
          ...(response.conversationId === undefined &&
          nodeConversationId !== undefined
            ? { conversationId: nodeConversationId }
            : {}),
        })
      }
      for (const child of Object.values(node)) {
        visit(child, nodeConversationId)
      }
    }

    visit(value, conversationId)
    return responses
  }

  private currentResponse(): ChatGPTParsedResponse | null {
    const direct =
      this.directBest === null
        ? []
        : [
            {
              ...this.directBest,
              text: normalizeAssistantTextWithReferenceMap(
                this.directBest.text,
                this.aggregatedReferenceUrls
              ),
            },
          ]
    const streamed = [...this.streamedResponses.values()]
      .filter((response) => this.responseMatches(response))
      .map((response) => ({
        ...response,
        text: normalizeAssistantTextWithReferenceMap(
          response.text,
          this.aggregatedReferenceUrls
        ),
      }))

    const hasCorrelationAnchor =
      this.options.expectedMessageId !== undefined ||
      this.options.expectedParentMessageId !== undefined
    if (hasCorrelationAnchor && this.activeMessageId !== null) {
      const active = streamed.find(
        (response) => response.messageId === this.activeMessageId
      )
      if (active !== undefined) {
        return active
      }
    }

    if (this.options.requireSingleMessageId === true) {
      const messageIds = new Set(this.directMessageIds)
      for (const response of streamed) {
        if (response.messageId !== undefined) messageIds.add(response.messageId)
      }
      if (messageIds.size > 1) return null
    }
    return pickBestResponse([...direct, ...streamed])
  }

  private recordOwnedProgress(
    value: unknown,
    fallbackConversationId?: string
  ): void {
    const collect = (
      nodeValue: unknown,
      inheritedConversationId?: string
    ): void => {
      if (Array.isArray(nodeValue)) {
        for (const item of nodeValue) collect(item, inheritedConversationId)
        return
      }
      const node = asRecord(nodeValue)
      if (!node) return
      const conversationId = readConversationId(node) ?? inheritedConversationId
      const role = readRole(node)
      const messageId = readMessageId(node)
      const parentMessageId = readParentMessageId(node)
      if (
        (role === 'assistant' || role === 'tool') &&
        (messageId !== undefined || parentMessageId !== undefined)
      ) {
        const key =
          messageId ?? `${role}:${parentMessageId}:${conversationId ?? ''}`
        this.ownedProgressNodes.set(key, {
          node,
          ...(conversationId === undefined ? {} : { conversationId }),
        })
      }
      for (const child of Object.values(node)) {
        collect(child, conversationId)
      }
    }

    collect(value, fallbackConversationId)
    let changed = true
    while (changed) {
      changed = false
      for (const { node, conversationId } of this.ownedProgressNodes.values()) {
        if (
          conversationId !== undefined &&
          this.ownedConversationId !== null &&
          conversationId !== this.ownedConversationId
        ) {
          continue
        }
        const role = readRole(node)
        if (role !== 'assistant' && role !== 'tool') continue
        const messageId = readMessageId(node)
        const parentMessageId = readParentMessageId(node)
        const isOwned =
          (messageId !== undefined && this.ownedMessageIds.has(messageId)) ||
          (parentMessageId !== undefined &&
            this.ownedMessageIds.has(parentMessageId))
        if (!isOwned) continue

        if (conversationId !== undefined) {
          this.ownedConversationId ??= conversationId
        }
        const progressKey =
          messageId ?? `${role}:${parentMessageId ?? conversationId ?? ''}`
        if (!this.ownedProgressKeys.has(progressKey)) {
          this.ownedProgressKeys.add(progressKey)
          this.ownedProgressCount += 1
        }
        if (messageId !== undefined && !this.ownedMessageIds.has(messageId)) {
          this.ownedMessageIds.add(messageId)
          changed = true
        }
      }
    }

    const hasCorrelationAnchor =
      this.options.expectedMessageId !== undefined ||
      this.options.expectedParentMessageId !== undefined
    if (hasCorrelationAnchor) {
      for (const [messageId, response] of this.streamedResponses) {
        if (this.responseMatches(response)) {
          this.activeMessageId = messageId
        }
      }
    }
  }

  private upsertStreamedResponse(
    messageId: string,
    update: (current: ChatGPTParsedResponse | null) => ChatGPTParsedResponse
  ): void {
    this.streamedResponses.set(
      messageId,
      update(this.streamedResponses.get(messageId) ?? null)
    )
  }

  private applyAssistantMessage(
    message: Record<string, unknown>,
    fallbackConversationId?: string
  ): void {
    if (readRole(message) !== 'assistant' || !isVisibleMessage(message)) return
    const content = asRecord(message.content)
    if (content?.content_type !== 'text') return
    const messageId = readMessageId(message)
    if (messageId === undefined) return
    const conversationId = readConversationId(message) ?? fallbackConversationId
    const parentMessageId = readParentMessageId(message)
    const text = readText(content.parts) ?? ''
    const isFinished = readFinished(message)
    const response: ChatGPTParsedResponse = {
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(parentMessageId !== undefined ? { parentMessageId } : {}),
      messageId,
      text,
      isFinished,
    }
    if (this.responseMatches(response)) {
      if (conversationId !== undefined) {
        this.ownedConversationId ??= conversationId
      }
      this.ownedMessageIds.add(messageId)
      this.activeMessageId = messageId
    }
    this.upsertStreamedResponse(messageId, (current) => ({
      ...(conversationId !== undefined
        ? { conversationId }
        : current?.conversationId !== undefined
          ? { conversationId: current.conversationId }
          : {}),
      ...(parentMessageId !== undefined
        ? { parentMessageId }
        : current?.parentMessageId !== undefined
          ? { parentMessageId: current.parentMessageId }
          : {}),
      messageId,
      text: text || current?.text || '',
      isFinished: current?.isFinished === true || isFinished,
    }))
  }

  private appendToActiveMessage(text: string): void {
    if (this.activeMessageId === null || !text) return
    const messageId = this.activeMessageId
    this.upsertStreamedResponse(messageId, (current) =>
      current === null
        ? { messageId, text, isFinished: false }
        : { ...current, text: `${current.text}${text}` }
    )
  }

  private markActiveMessageFinished(): void {
    if (this.activeMessageId === null) return
    const messageId = this.activeMessageId
    this.upsertStreamedResponse(messageId, (current) => ({
      ...(current ?? { messageId, text: '', isFinished: false }),
      isFinished: true,
    }))
  }

  private applyPatchOperations(operations: readonly unknown[]): void {
    for (const operationValue of operations) {
      const operation = asRecord(operationValue)
      if (!operation) continue
      const path = typeof operation.p === 'string' ? operation.p : ''
      const action = typeof operation.o === 'string' ? operation.o : ''
      const value = operation.v
      if (path === '/message/content/parts/0' && typeof value === 'string') {
        if (action === 'replace' && this.activeMessageId !== null) {
          const messageId = this.activeMessageId
          this.upsertStreamedResponse(messageId, (current) => ({
            ...(current ?? { messageId, text: '', isFinished: false }),
            text: value,
          }))
        } else if (action === 'append') {
          this.appendToActiveMessage(value)
        }
        continue
      }
      if (path === '/message/status' && typeof value === 'string') {
        const status = value.toLowerCase()
        if (status.includes('finish') || status.includes('complete')) {
          this.markActiveMessageFinished()
        }
        continue
      }
      if (path === '/message/end_turn' && value === true) {
        this.markActiveMessageFinished()
        continue
      }
      if (path === '/message/metadata') {
        const metadata = asRecord(value)
        if (metadata?.is_complete === true) this.markActiveMessageFinished()
      }
    }
  }

  private collectOwnedReferenceUrls(
    value: unknown,
    conversationId?: string
  ): void {
    let ownedConversationId = this.ownedConversationId

    const visit = (
      nodeValue: unknown,
      inheritedConversationId?: string,
      inheritedOwnership = false
    ) => {
      if (Array.isArray(nodeValue)) {
        for (const item of nodeValue) {
          visit(item, inheritedConversationId, inheritedOwnership)
        }
        return
      }
      const node = asRecord(nodeValue)
      if (!node) return
      const nodeConversationId =
        readConversationId(node) ?? inheritedConversationId
      if (
        nodeConversationId !== undefined &&
        ownedConversationId !== null &&
        nodeConversationId !== ownedConversationId
      ) {
        return
      }
      const messageId = readMessageId(node)
      const parentMessageId = readParentMessageId(node)
      const hasIdentity =
        messageId !== undefined || parentMessageId !== undefined
      const hasOwnedIdentity =
        (messageId !== undefined && this.ownedMessageIds.has(messageId)) ||
        (parentMessageId !== undefined &&
          this.ownedMessageIds.has(parentMessageId))
      const eventMessage = asRecord(asRecord(node.v)?.message)
      const eventMessageId = eventMessage
        ? readMessageId(eventMessage)
        : undefined
      const eventParentMessageId = eventMessage
        ? readParentMessageId(eventMessage)
        : undefined
      const hasOwnedEventMessage =
        (eventMessageId !== undefined &&
          this.ownedMessageIds.has(eventMessageId)) ||
        (eventParentMessageId !== undefined &&
          this.ownedMessageIds.has(eventParentMessageId))
      if (
        ownedConversationId === null &&
        nodeConversationId !== undefined &&
        (hasOwnedIdentity || hasOwnedEventMessage)
      ) {
        ownedConversationId = nodeConversationId
        this.ownedConversationId = nodeConversationId
      }
      const ownsReferences = hasIdentity
        ? hasOwnedIdentity
        : inheritedOwnership || hasOwnedEventMessage
      if (ownsReferences) {
        collectNodeReferenceUrls(
          node,
          this.aggregatedReferenceUrls,
          (reference) => {
            const referenceNode = asRecord(reference)
            const referenceConversationId = referenceNode
              ? readConversationId(referenceNode)
              : undefined
            const referenceMessageId = referenceNode
              ? readMessageId(referenceNode)
              : undefined
            const referenceParentMessageId = referenceNode
              ? readParentMessageId(referenceNode)
              : undefined
            const referenceHasIdentity =
              referenceMessageId !== undefined ||
              referenceParentMessageId !== undefined
            const referenceHasOwnedIdentity =
              (referenceMessageId !== undefined &&
                this.ownedMessageIds.has(referenceMessageId)) ||
              (referenceParentMessageId !== undefined &&
                this.ownedMessageIds.has(referenceParentMessageId))
            return (
              (referenceConversationId === undefined ||
                referenceConversationId === ownedConversationId) &&
              (!referenceHasIdentity || referenceHasOwnedIdentity)
            )
          }
        )
      }
      for (const child of Object.values(node)) {
        visit(child, nodeConversationId, ownsReferences)
      }
    }

    visit(value, conversationId)
  }

  private processFrame(frame: string): void {
    for (const chunk of extractChatGptJsonChunks(frame)) {
      let parsedChunk: unknown
      try {
        parsedChunk = JSON.parse(chunk)
      } catch {
        continue
      }
      const chunkRecord = asRecord(parsedChunk)
      const chunkConversationId =
        chunkRecord === null ? undefined : readConversationId(chunkRecord)
      if (
        chunkConversationId !== undefined &&
        this.ownedConversationId !== null &&
        chunkConversationId !== this.ownedConversationId
      ) {
        continue
      }
      if (
        chunkConversationId === undefined &&
        this.restrictConversation &&
        this.ownedConversationId === null
      ) {
        continue
      }
      this.recordOwnedProgress(parsedChunk, chunkConversationId)
      for (const response of this.collectDirectResponses(
        parsedChunk,
        chunkConversationId
      )) {
        this.acceptDirectResponse(response)
      }
      this.collectOwnedReferenceUrls(parsedChunk, chunkConversationId)
      for (const item of extractChatGptEncodedItems(
        parsedChunk,
        chunkConversationId
      )) {
        if (
          item.conversationId !== undefined &&
          this.ownedConversationId !== null &&
          item.conversationId !== this.ownedConversationId
        ) {
          continue
        }
        const parsedData = readChatGptEncodedData(item.encodedItem)
        if (parsedData === null) continue
        this.recordOwnedProgress(
          parsedData,
          item.conversationId ?? chunkConversationId
        )
        const eventType = readChatGptEncodedEventType(item.encodedItem)
        if (eventType === 'delta') {
          const delta = asRecord(parsedData)
          if (!delta) continue
          const deltaValue = asRecord(delta.v)
          const message = deltaValue ? asRecord(deltaValue.message) : null
          if (message) this.applyAssistantMessage(message, item.conversationId)
          if (
            delta.p === '/message/content/parts/0' &&
            delta.o === 'append' &&
            typeof delta.v === 'string'
          ) {
            this.appendToActiveMessage(delta.v)
          } else if (delta.o === 'patch' && Array.isArray(delta.v)) {
            this.applyPatchOperations(delta.v)
          } else if (typeof delta.v === 'string') {
            this.appendToActiveMessage(delta.v)
          }
          this.collectOwnedReferenceUrls(
            parsedData,
            item.conversationId ?? chunkConversationId
          )
          continue
        }
        const payload = asRecord(parsedData)
        if (payload?.type === 'message_stream_complete') {
          this.markActiveMessageFinished()
        }
        this.collectOwnedReferenceUrls(
          parsedData,
          item.conversationId ?? chunkConversationId
        )
      }
    }
  }
}

export function countChatGptOwnedWebSocketProgress(
  frames: readonly string[],
  options: {
    expectedConversationId?: string | null
    expectedMessageId?: string
    expectedParentMessageId?: string
  }
): number {
  const tracker = new ChatGptWebSocketResponseTracker(
    options.expectedConversationId,
    options
  )
  tracker.pushFrames(frames)
  return tracker.getOwnedProgressCount()
}

export function parseChatGptWebSocketFrames(
  frames: readonly string[],
  expectedConversationId?: string | null,
  options: ChatGptWebSocketResponseTrackerOptions = {}
): ChatGPTParsedResponse | null {
  return new ChatGptWebSocketResponseTracker(
    expectedConversationId,
    options
  ).pushFrames(frames)
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

  const activeResponse =
    activeMessageId === null ? null : streamedResponses.get(activeMessageId)
  if (activeResponse?.text.trim()) {
    return stripParsedResponse(activeResponse)
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

  return asRecord(rootRecord.mapping) !== null
    ? pickMappedResponse(rootRecord)
    : pickBestResponse(collectResponses(root, readConversationId(rootRecord)))
}
