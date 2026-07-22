import { Buffer } from 'node:buffer'

import {
  abortable,
  type AbortOptions,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import type { ProviderPage } from './adapters/adapter-base.ts'
import type { ProviderId } from './provider-id.ts'

export type ComposerLimitUnit =
  | 'utf16_code_units'
  | 'unicode_code_points'
  | 'utf8_bytes'

export type ComposerLimitConfidence = 'exact' | 'safe_cap'

export type ComposerLimit =
  | {
      kind: 'unknown'
      provider: ProviderId | 'unknown'
      source: 'unknown'
    }
  | {
      kind: 'known'
      provider: ProviderId
      limit: number
      unit: ComposerLimitUnit
      source: 'dom' | 'verified_fallback'
      confidence: ComposerLimitConfidence
    }

export type ComposerLimitOverage = {
  status: 'over_limit'
  limit: Extract<ComposerLimit, { kind: 'known' }>
  measured: number
}

export type ComposerLimitCheck =
  | {
      status: 'unknown'
      limit: Extract<ComposerLimit, { kind: 'unknown' }>
    }
  | {
      status: 'within_limit'
      limit: Extract<ComposerLimit, { kind: 'known' }>
      measured: number
    }
  | ComposerLimitOverage

export interface VerifiedComposerLimitFallback {
  readonly limit: number
  readonly unit: ComposerLimitUnit
  readonly confidence: ComposerLimitConfidence
  readonly verifiedAt: string
  readonly verificationScope: string
}

interface ComposerLimitDomSource {
  readonly selector: string
  readonly read: 'attribute' | 'property'
  readonly name: string
  readonly unit: ComposerLimitUnit
}

interface ComposerLimitDomResult {
  limit: number
  unit: ComposerLimitUnit
}

const HTML_MAX_LENGTH_READS = (
  selector: string
): readonly ComposerLimitDomSource[] => [
  {
    selector,
    read: 'attribute',
    name: 'maxlength',
    unit: 'utf16_code_units',
  },
  {
    selector,
    read: 'property',
    name: 'maxLength',
    unit: 'utf16_code_units',
  },
]

const PROVIDER_COMPOSER_DOM_SOURCES: Readonly<
  Record<ProviderId, readonly ComposerLimitDomSource[]>
> = {
  chatgpt: HTML_MAX_LENGTH_READS('#prompt-textarea'),
  gemini: HTML_MAX_LENGTH_READS(
    '[data-test-id="textarea-wrapper"] rich-textarea [role="textbox"][contenteditable="true"]'
  ),
  deepseek: HTML_MAX_LENGTH_READS('textarea'),
  doubao: HTML_MAX_LENGTH_READS('textarea.semi-input-textarea'),
  grok: HTML_MAX_LENGTH_READS(
    '[data-testid="chat-input"] [role="textbox"][contenteditable="true"]'
  ),
  glm: HTML_MAX_LENGTH_READS('#chat-input'),
  qwen: HTML_MAX_LENGTH_READS('.message-input-textarea'),
  kimi: HTML_MAX_LENGTH_READS(
    '.chat-editor .chat-input-editor[contenteditable="true"]'
  ),
}

// Exact limits are provider boundaries; safe caps are conservative Portal limits
// backed by a real request or an explicit provider configuration value.
export const VERIFIED_COMPOSER_LIMIT_FALLBACKS: Readonly<
  Partial<Record<ProviderId, VerifiedComposerLimitFallback>>
> = {
  chatgpt: {
    limit: 65_534,
    unit: 'utf16_code_units',
    confidence: 'exact',
    verifiedAt: '2026-07-20',
    verificationScope:
      'chatgpt.com web composer; current signed-in Portal Profile account; default model and mode; boundary verified with ASCII, CJK, and emoji input',
  },
  gemini: {
    limit: 32_000,
    unit: 'utf16_code_units',
    confidence: 'exact',
    verifiedAt: '2026-07-20',
    verificationScope:
      'gemini.google.com web composer; current signed-in Portal Profile account; default model and mode; editor truncation boundary verified with ASCII, CJK, and emoji input; exact-boundary ASCII request returned HTTP 200',
  },
  qwen: {
    limit: 131_072,
    unit: 'utf16_code_units',
    confidence: 'exact',
    verifiedAt: '2026-07-20',
    verificationScope:
      'chat.qwen.ai web composer; current signed-in Portal Profile account; Qwen3.7-Plus automatic mode; exact-boundary ASCII request returned HTTP 200; over-boundary input was rejected; counting unit verified with emoji input',
  },
  deepseek: {
    limit: 163_840,
    unit: 'utf16_code_units',
    confidence: 'safe_cap',
    verifiedAt: '2026-07-22',
    verificationScope:
      'chat.deepseek.com provider config exposed input_character_limit values 2,621,440 (quick), 163,840 (expert), and 2,621,440 (vision); 163,840 is the conservative cross-mode Portal cap; a 100-character real request returned an assistant reply',
  },
  doubao: {
    limit: 2_000_000,
    unit: 'utf16_code_units',
    confidence: 'safe_cap',
    verifiedAt: '2026-07-20',
    verificationScope:
      'doubao.com web composer; current signed-in Portal Profile account; 2,000,000 ASCII characters were retained, sent through /chat/completion, and returned HTTP 200; finite provider maximum was not reached',
  },
  grok: {
    limit: 100_000,
    unit: 'utf16_code_units',
    confidence: 'safe_cap',
    verifiedAt: '2026-07-22',
    verificationScope:
      'grok.com web composer; current signed-in Portal Profile account; 100,000 ASCII characters produced a real request and exact marker reply; 500,000 was retained but did not complete within 240 seconds, so 100,000 is the Portal cap rather than a claimed provider maximum',
  },
  glm: {
    limit: 100_000,
    unit: 'utf16_code_units',
    confidence: 'safe_cap',
    verifiedAt: '2026-07-22',
    verificationScope:
      'chat.z.ai web composer; current signed-in Portal Profile account; 100,000 ASCII characters produced a real /api/v2/chat/completions request and exact marker reply; larger UI boundary testing was affected by anti-bot verification',
  },
  kimi: {
    limit: 2_000_000,
    unit: 'utf16_code_units',
    confidence: 'safe_cap',
    verifiedAt: '2026-07-20',
    verificationScope:
      'kimi.com web composer; current signed-in Portal Profile account; 2,000,000 ASCII characters were sent through ChatService/Chat and returned HTTP 200; finite provider maximum was not reached',
  },
}

function isComposerLimitUnit(value: unknown): value is ComposerLimitUnit {
  return (
    value === 'utf16_code_units' ||
    value === 'unicode_code_points' ||
    value === 'utf8_bytes'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDomResult(value: unknown): ComposerLimitDomResult | null {
  if (!isRecord(value)) {
    return null
  }

  return typeof value.limit === 'number' &&
    Number.isSafeInteger(value.limit) &&
    value.limit > 0 &&
    isComposerLimitUnit(value.unit)
    ? { limit: value.limit, unit: value.unit }
    : null
}

export type ComposerTextOrigin = 'user' | 'internal' | 'tool_result'

export class ComposerLimitExceededError extends Error {
  public constructor(
    public readonly check: ComposerLimitOverage,
    public readonly origin: ComposerTextOrigin
  ) {
    const limitLabel =
      check.limit.confidence === 'safe_cap'
        ? `${check.limit.provider} Portal safety cap`
        : `${check.limit.provider} composer limit`
    super(
      `Input exceeds the ${limitLabel}: ${check.measured} ${formatComposerLimitUnit(check.limit.unit)}; limit ${check.limit.limit} (${check.limit.source}, ${check.limit.confidence}).`
    )
    this.name = 'ComposerLimitExceededError'
  }
}

export function resolveComposerLimitResult(
  provider: ProviderId,
  domResult: unknown,
  fallback: VerifiedComposerLimitFallback | undefined
): ComposerLimit {
  const parsedDom = parseDomResult(domResult)
  const validFallback =
    fallback !== undefined &&
    Number.isSafeInteger(fallback.limit) &&
    fallback.limit > 0
      ? fallback
      : undefined
  if (
    parsedDom !== null &&
    (validFallback === undefined ||
      (parsedDom.unit === validFallback.unit &&
        parsedDom.limit <= validFallback.limit))
  ) {
    return {
      kind: 'known',
      provider,
      limit: parsedDom.limit,
      unit: parsedDom.unit,
      source: 'dom',
      confidence: 'exact',
    }
  }
  if (validFallback !== undefined) {
    return {
      kind: 'known',
      provider,
      limit: validFallback.limit,
      unit: validFallback.unit,
      source: 'verified_fallback',
      confidence: validFallback.confidence,
    }
  }
  return { kind: 'unknown', provider, source: 'unknown' }
}

export async function resolveProviderComposerLimit(
  page: ProviderPage,
  provider: ProviderId,
  options: AbortOptions = {}
): Promise<ComposerLimit> {
  throwIfAborted(options.signal)
  const sources = PROVIDER_COMPOSER_DOM_SOURCES[provider]
  const domResult =
    typeof page.evaluate === 'function'
      ? await abortable(
          page
            .evaluate((orderedSources: readonly ComposerLimitDomSource[]) => {
              const isVisible = (element: Element) => {
                const style = window.getComputedStyle(element)
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.visibility !== 'collapse' &&
                  element.getClientRects().length > 0
                )
              }

              for (const source of orderedSources) {
                const targets = [
                  ...document.querySelectorAll(source.selector),
                ].filter(isVisible)
                if (targets.length !== 1) {
                  continue
                }
                const target = targets[0]!
                const raw: string | number | null =
                  source.read === 'attribute'
                    ? target.getAttribute(source.name)
                    : target instanceof HTMLInputElement ||
                        target instanceof HTMLTextAreaElement
                      ? target.maxLength
                      : null
                const limit =
                  typeof raw === 'number'
                    ? raw
                    : typeof raw === 'string' && raw.trim() !== ''
                      ? Number(raw)
                      : Number.NaN
                if (Number.isSafeInteger(limit) && limit > 0) {
                  return { limit, unit: source.unit }
                }
              }
              return null
            }, sources)
            .catch(() => null),
          options.signal
        )
      : null
  throwIfAborted(options.signal)

  return resolveComposerLimitResult(
    provider,
    domResult,
    VERIFIED_COMPOSER_LIMIT_FALLBACKS[provider]
  )
}

export function measureComposerText(
  text: string,
  unit: ComposerLimitUnit
): number {
  if (unit === 'utf16_code_units') {
    return text.length
  }
  if (unit === 'unicode_code_points') {
    return [...text].length
  }
  return Buffer.byteLength(text, 'utf8')
}

export function checkComposerLimit(
  text: string,
  limit: ComposerLimit
): ComposerLimitCheck {
  if (limit.kind === 'unknown') {
    return { status: 'unknown', limit }
  }
  const measured = measureComposerText(text, limit.unit)
  return {
    status: measured > limit.limit ? 'over_limit' : 'within_limit',
    limit,
    measured,
  }
}

export function formatComposerLimitUnit(unit: ComposerLimitUnit): string {
  if (unit === 'utf16_code_units') return 'UTF-16 code units'
  if (unit === 'unicode_code_points') return 'Unicode code points'
  return 'UTF-8 bytes'
}

export function createComposerLimitToolDelivery(check: ComposerLimitOverage): {
  status: 'not_delivered'
  code: 'COMPOSER_LIMIT_EXCEEDED'
  message: string
  measured: number
  limit: number
  unit: ComposerLimitUnit
  source: 'dom' | 'verified_fallback'
  confidence: ComposerLimitConfidence
} {
  const limitLabel =
    check.limit.confidence === 'safe_cap'
      ? `${check.limit.provider} Portal safety cap`
      : `${check.limit.provider} composer limit`
  return {
    status: 'not_delivered',
    code: 'COMPOSER_LIMIT_EXCEEDED',
    message: `The original tool result was not delivered because it exceeds the ${limitLabel}.`,
    measured: check.measured,
    limit: check.limit.limit,
    unit: check.limit.unit,
    source: check.limit.source,
    confidence: check.limit.confidence,
  }
}
