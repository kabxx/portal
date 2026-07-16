import { extractToolCall } from '../tools/core/tool-registry.ts'

export type ConversationHistoryRole = 'user' | 'assistant'

export interface ConversationHistoryMessage {
  id: string
  parentId: string | null
  role: ConversationHistoryRole
  text: string
  format: 'plain' | 'markdown'
  createdAt: number | null
}

export interface ConversationHistoryResult {
  messages: ConversationHistoryMessage[]
  complete: boolean
  warning: string | null
}

export function emptyHistoryResult(warning: string): ConversationHistoryResult {
  return {
    messages: [],
    complete: false,
    warning,
  }
}

export function parseDeepSeekHistory(raw: string): ConversationHistoryResult {
  const root = parseJson(raw)
  const data = asRecord(asRecord(root)?.data)
  const bizData = asRecord(data?.biz_data)
  const rows = asArray(bizData?.chat_messages)
  const cacheControl = stringValue(bizData?.cache_control)?.toUpperCase()
  const complete = cacheControl === 'REPLACE'
  const incompleteWarning =
    cacheControl === 'MERGE'
      ? 'DeepSeek history is incomplete because the page returned only a cache delta.'
      : 'DeepSeek history completeness could not be verified from the response.'

  if (rows.length === 0) {
    return {
      messages: [],
      complete,
      warning: complete
        ? 'DeepSeek history contained no visible messages.'
        : cacheControl === null
          ? 'DeepSeek history response did not contain messages.'
          : incompleteWarning,
    }
  }

  const parsed = rows
    .map((value, index) => {
      const message = asRecord(value)
      if (!message) return null
      const rawRole = stringValue(message.role)?.toLowerCase()
      const role =
        rawRole === 'user'
          ? 'user'
          : rawRole === 'assistant'
            ? 'assistant'
            : null
      if (role === null) return null
      const fragments = asArray(message.fragments)
      const text = fragments
        .map((fragment) => {
          const record = asRecord(fragment)
          const type = stringValue(record?.type)
          return type === null || type === 'REQUEST' || type === 'RESPONSE'
            ? (stringValue(record?.content) ?? '')
            : ''
        })
        .join('')
        .trim()
      if (!text) return null
      const id = stringValue(message.message_id) ?? `deepseek-${index}`
      return historyMessage({
        id,
        parentId: nullableString(message.parent_id),
        role,
        text,
        createdAt: timestamp(message.inserted_at),
      })
    })
    .filter((item): item is ConversationHistoryMessage => item !== null)

  parsed.sort((a, b) => compareNumericIds(a.id, b.id))
  return {
    messages: parsed,
    complete,
    warning:
      parsed.length === 0
        ? 'DeepSeek history contained no visible messages.'
        : complete
          ? null
          : incompleteWarning,
  }
}

export function parseGlmHistory(
  metadataRaw: string,
  batchRaw: string | readonly string[]
): ConversationHistoryResult {
  const metadata = asRecord(parseJson(metadataRaw))
  const nodeMap = new Map<string, Record<string, unknown>>()
  const batchRaws: readonly string[] =
    typeof batchRaw === 'string' ? [batchRaw] : batchRaw
  for (const raw of batchRaws) {
    const nodesRecord = asRecord(asRecord(parseJson(raw))?.data)
    if (nodesRecord === null) continue
    for (const node of Object.values(nodesRecord)
      .map(asRecord)
      .filter(isRecord)) {
      const id = stringValue(node.id)
      if (id !== null) nodeMap.set(id, node)
    }
  }
  const nodes = [...nodeMap.values()]
  if (nodes.length === 0) {
    return emptyHistoryResult(
      'GLM history response did not contain message nodes.'
    )
  }

  const metadataCurrentId =
    stringValue(asRecord(asRecord(metadata?.chat)?.history)?.currentId) ??
    stringValue(asRecord(asRecord(metadata?.chat)?.history)?.current_id)
  const leafIds = findLeafIds(nodes)
  const currentId = metadataCurrentId ?? leafIds[0] ?? null
  const ambiguousLeaf = metadataCurrentId === null && leafIds.length > 1

  const chain: Record<string, unknown>[] = []
  const visited = new Set<string>()
  let nextId = currentId
  let reachedRoot = false
  while (nextId !== null && !visited.has(nextId)) {
    visited.add(nextId)
    const node = nodeMap.get(nextId)
    if (!node) break
    chain.push(node)
    const parentId =
      nullableString(node.parentId) ?? nullableString(node.parent_id)
    if (parentId === null) {
      reachedRoot = true
      break
    }
    nextId = parentId
  }
  chain.reverse()

  const messages = chain
    .map((node, index) => {
      const rawRole = stringValue(node.role)?.toLowerCase()
      const role =
        rawRole === 'user'
          ? 'user'
          : rawRole === 'assistant'
            ? 'assistant'
            : null
      if (role === null) return null
      const text = readGlmText(node, role)
      if (!text) return null
      return historyMessage({
        id: stringValue(node.id) ?? `glm-${index}`,
        parentId:
          nullableString(node.parentId) ?? nullableString(node.parent_id),
        role,
        text,
        createdAt: timestamp(node.created_at ?? node.timestamp),
      })
    })
    .filter((item): item is ConversationHistoryMessage => item !== null)

  return {
    messages,
    complete: reachedRoot && !ambiguousLeaf,
    warning:
      chain.length === 0
        ? 'GLM history graph did not contain an active branch.'
        : !reachedRoot || ambiguousLeaf
          ? 'GLM history is incomplete because the active branch did not resolve to one verified root.'
          : messages.length === 0
            ? 'GLM history contained no visible messages.'
            : null,
  }
}

export function parseGrokHistory(
  nodeRaw: string,
  responsesRaw: string
): ConversationHistoryResult {
  const nodeRoot = asRecord(parseJson(nodeRaw))
  const responseRoot = asRecord(parseJson(responsesRaw))
  const nodes = asArray(nodeRoot?.responseNodes).map(asRecord).filter(isRecord)
  const responses = asArray(responseRoot?.responses)
    .map(asRecord)
    .filter(isRecord)
  const responseMap = new Map<string, Record<string, unknown>>()
  for (const response of responses) {
    const id = stringValue(response.responseId)
    if (id !== null) responseMap.set(id, response)
  }
  if (nodes.length === 0 || responseMap.size === 0) {
    return emptyHistoryResult(
      'Grok history response did not contain message nodes.'
    )
  }

  const nodeMap = new Map<string, Record<string, unknown>>()
  for (const node of nodes) {
    const id = stringValue(node.responseId)
    if (id !== null) nodeMap.set(id, node)
  }
  const leaves = nodes.filter((node) => {
    const id = stringValue(node.responseId)
    return (
      id !== null &&
      !nodes.some(
        (candidate) => nullableString(candidate.parentResponseId) === id
      )
    )
  })
  const roots = nodes.filter((node) => {
    const parentId = nullableString(node.parentResponseId)
    return parentId === null || !nodeMap.has(parentId)
  })
  const leaf = leaves[0] ?? null
  const ordered: Record<string, unknown>[] = []
  const visited = new Set<string>()
  let current = leaf
  let reachedRoot = false
  while (current !== null) {
    const id = stringValue(current.responseId)
    if (id === null || visited.has(id)) break
    visited.add(id)
    ordered.push(current)
    const parentId = nullableString(current.parentResponseId)
    if (parentId === null || !nodeMap.has(parentId)) {
      reachedRoot = roots.length === 1 && roots[0] === current
      break
    }
    current = nodeMap.get(parentId) ?? null
  }
  ordered.reverse()

  const missingVisibleResponse = ordered.some((node) => {
    const sender = stringValue(node.sender)?.toLowerCase()
    if (sender !== 'human' && sender !== 'assistant') return false
    const id = stringValue(node.responseId)
    return id === null || !responseMap.has(id)
  })
  const graphComplete =
    reachedRoot &&
    roots.length === 1 &&
    leaves.length === 1 &&
    ordered.length === nodes.length &&
    !missingVisibleResponse

  const messages = ordered
    .map((node, index) => {
      const sender = stringValue(node.sender)?.toLowerCase()
      const role =
        sender === 'human'
          ? 'user'
          : sender === 'assistant'
            ? 'assistant'
            : null
      const id = stringValue(node.responseId)
      const response = id === null ? null : (responseMap.get(id) ?? null)
      if (
        role === null ||
        response === null ||
        response.partial === true ||
        response.isControl === true
      ) {
        return null
      }
      const text = readText(response.message)
      if (!text) return null
      return historyMessage({
        id: id ?? `grok-${index}`,
        parentId: nullableString(node.parentResponseId),
        role,
        text,
        createdAt: timestamp(response.createTime),
      })
    })
    .filter((item): item is ConversationHistoryMessage => item !== null)

  return {
    messages,
    complete: graphComplete,
    warning:
      ordered.length === 0
        ? 'Grok history graph did not contain an active branch.'
        : !graphComplete
          ? 'Grok history is incomplete because the response graph did not resolve to one fully loaded branch.'
          : messages.length === 0
            ? 'Grok history contained no visible messages.'
            : null,
  }
}

export function parseDoubaoHistory(
  raws: readonly string[]
): ConversationHistoryResult {
  const byId = new Map<string, ConversationHistoryMessage>()
  const indexById = new Map<string, bigint>()
  let sawResponse = false
  let complete = false

  for (const raw of raws) {
    const root = asRecord(parseJson(raw))
    const body = asRecord(
      asRecord(root?.downlink_body)?.pull_singe_chain_downlink_body
    )
    if (!body) continue
    sawResponse = true
    if (body.has_more === false) complete = true
    for (const value of asArray(body.messages)) {
      const message = asRecord(value)
      if (!message) continue
      const rawRole = numberValue(message.user_type)
      const role = rawRole === 1 ? 'user' : rawRole === 2 ? 'assistant' : null
      if (role === null) continue
      const text = readDoubaoText(message)
      const id = stringValue(message.message_id)
      if (!text || id === null) continue
      const index = stringValue(message.index_in_conv)
      if (index !== null && /^-?\d+$/.test(index)) {
        indexById.set(id, BigInt(index))
      }
      byId.set(
        id,
        historyMessage({
          id,
          parentId: null,
          role,
          text,
          createdAt: timestamp(message.create_time),
        })
      )
    }
  }

  const messages = [...byId.values()]
  messages.sort((a, b) => {
    const aIndex = indexById.get(a.id)
    const bIndex = indexById.get(b.id)
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex < bIndex ? -1 : aIndex > bIndex ? 1 : 0
    }
    return a.id.localeCompare(b.id)
  })
  if (!sawResponse)
    return emptyHistoryResult('Doubao history response was not captured.')
  return {
    messages,
    complete,
    warning: !complete
      ? 'Doubao history is incomplete because the page did not expose all pages.'
      : messages.length === 0
        ? 'Doubao history contained no visible messages.'
        : null,
  }
}

export function parseChatGptHistory(raw: string): ConversationHistoryResult {
  const root = asRecord(parseJson(raw))
  const mapping = asRecord(root?.mapping)
  const currentNode = stringValue(root?.current_node)
  if (mapping === null || currentNode === null) {
    return emptyHistoryResult(
      'ChatGPT history response did not contain a message graph.'
    )
  }

  const chain: Array<{ node: Record<string, unknown>; id: string }> = []
  const visited = new Set<string>()
  let nodeId: string | null = currentNode
  let reachedRoot = false
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId)
    const node = asRecord(mapping[nodeId])
    if (node === null) break
    chain.push({ node, id: nodeId })
    const parentId = nullableString(node.parent)
    if (parentId === null) {
      reachedRoot = true
      break
    }
    nodeId = parentId
  }
  chain.reverse()

  const messages = chain
    .map(({ node, id }) => {
      const message = asRecord(node.message)
      const role = stringValue(asRecord(message?.author)?.role)
      const content = asRecord(message?.content)
      const contentType = stringValue(content?.content_type)
      const metadata = asRecord(message?.metadata)
      if (
        message === null ||
        (role !== 'user' && role !== 'assistant') ||
        metadata?.is_visually_hidden_from_conversation === true ||
        (contentType !== 'text' && contentType !== 'multimodal_text')
      ) {
        return null
      }
      if (
        role === 'assistant' &&
        (stringValue(message.recipient) ?? 'all') !== 'all'
      ) {
        return null
      }
      const text = readText(content?.parts)
      if (!text) return null
      if (
        role === 'assistant' &&
        message.end_turn === false &&
        extractToolCall(text) === null
      ) {
        return null
      }
      return historyMessage({
        id: stringValue(message.id) ?? id,
        parentId: nullableString(node.parent),
        role,
        text,
        format: role === 'assistant' ? 'markdown' : 'plain',
        createdAt: timestamp(message.create_time),
      })
    })
    .filter((item): item is ConversationHistoryMessage => item !== null)

  return {
    messages,
    complete: reachedRoot,
    warning:
      chain.length === 0
        ? 'ChatGPT history graph did not contain an active branch.'
        : !reachedRoot
          ? 'ChatGPT history is incomplete because the active branch did not reach its root node.'
          : messages.length === 0
            ? 'ChatGPT history contained no visible messages.'
            : null,
  }
}

export function parseGeminiHistory(
  raws: readonly string[]
): ConversationHistoryResult {
  const byId = new Map<string, ConversationHistoryMessage>()
  let sawPayload = false
  let complete = false

  for (const raw of raws) {
    for (const wrapper of findRpcWrappers(raw, 'hNvQHb')) {
      const payload = parseJson(wrapper.payload)
      const payloadArray = Array.isArray(payload) ? payload : []
      if (payloadArray.length > 1 && payloadArray[1] === null) {
        complete = true
      }
      const turns: unknown[] = Array.isArray(payloadArray[0])
        ? payloadArray[0]
        : []
      sawPayload = true
      if (turns.length === 0) continue
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index]
        if (!Array.isArray(turn)) continue
        const identity = Array.isArray(turn[0]) ? turn[0] : []
        const conversationId = stringValue(identity[0])
        const responseId = stringValue(identity[1])
        const userText = readGeminiUserText(turn[2])
        const assistantText = readGeminiAssistantText(turn[3])
        const createdAt = timestamp(
          Array.isArray(turn[4]) ? turn[4][0] : turn[4]
        )
        const previousTurn =
          index > 0 && Array.isArray(turns[index - 1]) ? turns[index - 1] : null
        const previousIdentity =
          Array.isArray(previousTurn) && Array.isArray(previousTurn[0])
            ? previousTurn[0]
            : null
        const parentId =
          previousIdentity === null ? null : stringValue(previousIdentity[1])

        if (userText) {
          const id =
            conversationId && responseId
              ? `${conversationId}:user:${responseId}`
              : `gemini:${index}:user`
          byId.set(
            id,
            historyMessage({
              id,
              parentId,
              role: 'user',
              text: userText,
              format: 'plain',
              createdAt,
            })
          )
        }
        if (assistantText) {
          const id = responseId ?? `gemini:${index}:assistant`
          byId.set(
            id,
            historyMessage({
              id,
              parentId: userText
                ? conversationId && responseId
                  ? `${conversationId}:user:${responseId}`
                  : parentId
                : parentId,
              role: 'assistant',
              text: assistantText,
              format: 'markdown',
              createdAt,
            })
          )
        }
      }
    }
  }

  const messages = [...byId.values()]
  messages.sort(
    (a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)
  )
  if (!sawPayload)
    return emptyHistoryResult('Gemini history response was not captured.')
  return {
    messages,
    complete,
    warning: !complete
      ? 'Gemini history is incomplete because older pages were not fully loaded.'
      : messages.length === 0
        ? 'Gemini history contained no visible messages.'
        : null,
  }
}

function readGlmText(
  node: Record<string, unknown>,
  role: ConversationHistoryRole
): string {
  if (role === 'user') return readText(node.content)
  const blocks = asArray(node.content_blocks)
  return (
    blocks
      .filter((block) => {
        const record = asRecord(block)
        const type = stringValue(record?.type)
        return type === null || type === 'text'
      })
      .map((block) => readText(block))
      .filter(Boolean)
      .join('\n\n')
      .trim() || readText(node.content)
  )
}

function readDoubaoText(message: Record<string, unknown>): string {
  const blocks = asArray(message.content_block)
  const text = blocks
    .map((block) => readText(asRecord(asRecord(block)?.content)?.text_block))
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return text || readText(message.content)
}

function readGeminiUserText(value: unknown): string {
  const record = asArray(value)
  if (record && typeof record[0] === 'string') return record[0].trim()
  const nested = asArray(record?.[0])
  if (typeof nested?.[0] === 'string') {
    return nested[0].trim()
  }
  return readText(value)
}

function readGeminiAssistantText(value: unknown): string {
  const root = asArray(value)
  const first = asArray(root?.[0])
  const content = asArray(first?.[0])
  const preferred = content?.[1]
  const preferredText = readText(preferred)
  if (preferredText) return preferredText
  const candidates = collectStrings(value).filter((item) => item.length > 0)
  return (
    candidates.find((item) => item.length > 3 && !isGeminiMetadata(item)) ?? ''
  )
}

function findRpcWrappers(
  raw: string,
  rpcId: string
): Array<{ payload: string }> {
  const wrappers: Array<{ payload: string }> = []
  for (const chunk of extractJsonChunks(raw)) {
    const outer = parseJson(chunk)
    walk(outer, (value) => {
      if (
        Array.isArray(value) &&
        value[0] === 'wrb.fr' &&
        value[1] === rpcId &&
        typeof value[2] === 'string'
      ) {
        wrappers.push({ payload: value[2] })
      }
    })
  }
  return wrappers
}

function extractJsonChunks(value: string): string[] {
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith(")]}'", index)) {
      index += 3
      continue
    }
    if (value[index] !== '[' && value[index] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = index; end < value.length; end += 1) {
      const char = value[end]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '[' || char === '{') depth += 1
      if (char === ']' || char === '}') {
        depth -= 1
        if (depth === 0) {
          chunks.push(value.slice(index, end + 1))
          index = end
          break
        }
      }
    }
  }
  return chunks
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => readText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  const record = asRecord(value)
  if (record === null) return ''
  for (const key of ['text', 'content', 'parts', 'markdown', 'message']) {
    const text = readText(record[key], depth + 1)
    if (text) return text
  }
  return ''
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    output.push(value.trim())
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, output))
  }
  return output
}

function isGeminiMetadata(value: string): boolean {
  return (
    value === 'READY' ||
    /^[-_A-Za-z0-9]{1,24}$/.test(value) ||
    /^https?:\/\//.test(value)
  )
}

function historyMessage(
  input: Omit<ConversationHistoryMessage, 'format' | 'createdAt'> &
    Partial<Pick<ConversationHistoryMessage, 'format' | 'createdAt'>>
): ConversationHistoryMessage {
  return {
    ...input,
    format: input.format ?? (input.role === 'assistant' ? 'markdown' : 'plain'),
    createdAt: input.createdAt ?? null,
  }
}

function compareNumericIds(a: string, b: string): number {
  const aNumber = Number(a)
  const bNumber = Number(b)
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber))
    return aNumber - bNumber
  return a.localeCompare(b)
}

function findLeafIds(nodes: readonly Record<string, unknown>[]): string[] {
  const parents = new Set(
    nodes
      .map(
        (node) =>
          nullableString(node.parentId) ?? nullableString(node.parent_id)
      )
      .filter((value): value is string => value !== null)
  )
  return nodes
    .map((node) => stringValue(node.id))
    .filter((id): id is string => id !== null && !parents.has(id))
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric))
      return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isRecord(
  value: Record<string, unknown> | null
): value is Record<string, unknown> {
  return value !== null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function nullableString(value: unknown): string | null {
  return stringValue(value)
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value)
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit))
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => walk(item, visit))
}
