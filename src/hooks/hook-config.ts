import { randomUUID } from 'node:crypto'

import type { ProviderId } from '../providers/provider-id.ts'
import {
  HOOK_EVENTS,
  type AgentHookHandler,
  type HookErrorPolicy,
  type HookEventName,
  type HookHandler,
  type HookMatchConfig,
  type HooksConfig,
  type HookSnapshot,
} from './hook-types.ts'

export class HookConfigError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'HookConfigError'
  }
}

const HOOK_FIELDS = new Set(['enabled', 'maxDepth', 'handlers'])
const HANDLER_FIELDS = new Set([
  'name',
  'enabled',
  'type',
  'events',
  'match',
  'timeoutMs',
  'onError',
  'command',
  'prompt',
  'provider',
  'tools',
  'maxTurns',
])
const MATCH_FIELDS = new Set(['tool', 'provider'])
const EVENT_NAMES = new Set<string>(HOOK_EVENTS)
const PROVIDER_IDS = new Set<string>([
  'chatgpt',
  'gemini',
  'deepseek',
  'doubao',
  'grok',
  'glm',
  'qwen',
  'kimi',
])

export function createDefaultHooksConfig(): HooksConfig {
  return { enabled: false, maxDepth: 1, handlers: [] }
}

export function parseHooksConfig(value: unknown): HooksConfig {
  if (value === undefined) {
    return createDefaultHooksConfig()
  }
  if (!isRecord(value)) {
    throw new HookConfigError('hooks must be an object')
  }
  assertFields(value, HOOK_FIELDS, 'hooks')
  const enabled = value.enabled ?? false
  if (typeof enabled !== 'boolean') {
    throw new HookConfigError('hooks.enabled must be a boolean')
  }
  const maxDepth = value.maxDepth ?? 1
  if (!isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) {
    throw new HookConfigError('hooks.maxDepth must be an integer from 0 to 8')
  }
  const rawHandlers = value.handlers ?? []
  if (!Array.isArray(rawHandlers)) {
    throw new HookConfigError('hooks.handlers must be an array')
  }
  const handlers = rawHandlers.map((handler, index) =>
    parseHandler(handler, `hooks.handlers[${index}]`)
  )
  const names = new Set<string>()
  for (const handler of handlers) {
    if (names.has(handler.name)) {
      throw new HookConfigError(`Duplicate hook handler name: ${handler.name}`)
    }
    names.add(handler.name)
  }
  return { enabled, maxDepth, handlers }
}

export function createHookSnapshot(config: HooksConfig): HookSnapshot {
  return deepFreeze({
    ...structuredClone(config),
    revision: randomUUID(),
    loadedAt: Date.now(),
  })
}

function parseHandler(value: unknown, label: string): HookHandler {
  if (!isRecord(value)) {
    throw new HookConfigError(`${label} must be an object`)
  }
  assertFields(value, HANDLER_FIELDS, label)
  const name = requireString(value.name, `${label}.name`)
  const enabled = value.enabled ?? true
  if (typeof enabled !== 'boolean') {
    throw new HookConfigError(`${label}.enabled must be a boolean`)
  }
  if (
    value.type !== 'command' &&
    value.type !== 'prompt' &&
    value.type !== 'agent'
  ) {
    throw new HookConfigError(`${label}.type must be command, prompt, or agent`)
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    throw new HookConfigError(`${label}.events must be a non-empty array`)
  }
  const events = value.events.map((event, index) => {
    if (!isHookEventName(event)) {
      throw new HookConfigError(
        `${label}.events[${index}] is not a supported hook event`
      )
    }
    return event
  })
  const timeoutMs = value.timeoutMs ?? 5_000
  if (!isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new HookConfigError(
      `${label}.timeoutMs must be an integer from 1 to 300000`
    )
  }
  const onErrorValue =
    value.onError ?? (events.includes('tool.before') ? 'deny' : 'continue')
  if (onErrorValue !== 'deny' && onErrorValue !== 'continue') {
    throw new HookConfigError(`${label}.onError must be deny or continue`)
  }
  const onError: HookErrorPolicy = onErrorValue
  const base = {
    name,
    enabled,
    events,
    match: parseMatch(value.match, `${label}.match`),
    timeoutMs,
    onError,
  }

  if (value.type === 'command') {
    if (
      !Array.isArray(value.command) ||
      value.command.length === 0 ||
      value.command.some((part) => typeof part !== 'string' || part === '')
    ) {
      throw new HookConfigError(
        `${label}.command must be a non-empty string array`
      )
    }
    const command = value.command.filter(
      (part): part is string => typeof part === 'string'
    )
    return { ...base, type: 'command', command }
  }

  const prompt = requireString(value.prompt, `${label}.prompt`)
  const provider = parseProvider(value.provider, `${label}.provider`)
  if (value.type === 'prompt') {
    return {
      ...base,
      type: 'prompt',
      prompt,
      ...(provider === undefined ? {} : { provider }),
    }
  }

  const tools = value.tools ?? []
  if (!isStringArray(tools) || tools.some((tool) => tool.trim() === '')) {
    throw new HookConfigError(`${label}.tools must be a string array`)
  }
  if (tools.includes('spawn')) {
    throw new HookConfigError(`${label}.tools cannot include spawn`)
  }
  const maxTurns = value.maxTurns ?? 8
  if (!isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) {
    throw new HookConfigError(
      `${label}.maxTurns must be an integer from 1 to 32`
    )
  }
  return {
    ...base,
    type: 'agent',
    prompt,
    ...(provider === undefined ? {} : { provider }),
    tools: [...new Set(tools)],
    maxTurns,
  } satisfies AgentHookHandler
}

function parseMatch(value: unknown, label: string): HookMatchConfig {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new HookConfigError(`${label} must be an object`)
  assertFields(value, MATCH_FIELDS, label)
  const tool = value.tool
  if (tool !== undefined && (typeof tool !== 'string' || tool.trim() === '')) {
    throw new HookConfigError(`${label}.tool must be a non-empty string`)
  }
  const provider = parseProvider(value.provider, `${label}.provider`)
  return {
    ...(typeof tool === 'string' ? { tool } : {}),
    ...(provider === undefined ? {} : { provider }),
  }
}

function parseProvider(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string')
    throw new HookConfigError(`${label} must be a provider name`)
  const provider = normalizeProviderId(value)
  if (provider === null)
    throw new HookConfigError(`${label} is not a supported provider`)
  return provider
}

function normalizeProviderId(value: string): ProviderId | null {
  const normalized = value.trim().toLowerCase()
  return isProviderId(normalized) ? normalized : null
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HookConfigError(`${label} must be a non-empty string`)
  }
  return value
}

function assertFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  label: string
): void {
  const fields = Object.keys(value).filter((field) => !supported.has(field))
  if (fields.length > 0)
    throw new HookConfigError(
      `Unsupported ${label} fields: ${fields.join(', ')}`
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === 'string' && EVENT_NAMES.has(value)
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.has(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
