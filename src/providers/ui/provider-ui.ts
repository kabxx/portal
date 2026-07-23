import type { Locator, Page } from 'playwright'

import { getProviderDefinition } from '../provider-definition-pack.ts'
import type { ProviderId } from '../provider-id.ts'

export type LocatorCandidates = readonly [string, ...string[]]

export type LocatorRoot = Pick<Page, 'locator'> | Locator

type SelectorTree = {
  readonly [key: string]: LocatorCandidates | SelectorTree
}

export class ProviderUiSelectorError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderUiSelectorError'
  }
}

export class ProviderUiContractError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ProviderUiContractError'
  }
}

export function defineProviderUiModelPositions<
  T extends Readonly<Record<string, number>>,
>(
  provider: ProviderId,
  positions: T
): Readonly<T> & Readonly<Record<string, number>> {
  assertExactDomainKeys(
    provider,
    'model',
    getProviderDefinition(provider).models.map((model) => model.key),
    Object.keys(positions)
  )
  const values = Object.values(positions)
  if (
    values.some(
      (position) =>
        !Number.isSafeInteger(position) || position < 1 || position > 64
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new ProviderUiContractError(
      `${provider} UI model positions must be unique integers from 1 to 64.`
    )
  }
  return deepFreeze(structuredClone(positions))
}

export function defineProviderUiCapabilityMap<T extends object>(
  provider: ProviderId,
  capabilities: T
): Readonly<T> {
  assertExactDomainKeys(
    provider,
    'capability',
    getProviderDefinition(provider).capabilities.map(
      (capability) => capability.key
    ),
    Object.keys(capabilities)
  )
  return deepFreeze(structuredClone(capabilities))
}

export function defineProviderUiSelectors<T extends SelectorTree>(
  selectors: T
): Readonly<T>
export function defineProviderUiSelectors(
  selectors: unknown
): Readonly<SelectorTree>
export function defineProviderUiSelectors(
  selectors: unknown
): Readonly<SelectorTree> {
  validateSelectorTree(selectors, 'selectors')
  return deepFreeze(structuredClone(selectors))
}

export function joinCssLocatorCandidates(
  candidates: LocatorCandidates,
  suffix = ''
): string {
  return candidates.map((candidate) => `${candidate}${suffix}`).join(', ')
}

export function mapCssLocatorCandidates(
  candidates: LocatorCandidates,
  transform: (candidate: string, index: number) => string
): string {
  return candidates.map(transform).join(', ')
}

export async function resolveUniqueVisibleLocator(
  root: LocatorRoot,
  candidates: LocatorCandidates
): Promise<Locator | null> {
  const locator = root.locator(joinCssLocatorCandidates(candidates))
  let resolved: Locator | null = null
  const count = await locator.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index)
    if (!(await target.isVisible().catch(() => false))) {
      continue
    }
    if (resolved !== null) {
      return null
    }
    resolved = target
  }
  return resolved
}

function validateSelectorTree(
  value: unknown,
  path: string
): asserts value is SelectorTree {
  if (!isSelectorTree(value)) {
    throw new ProviderUiSelectorError(`${path} must contain a selector group.`)
  }
  if (Object.keys(value).length === 0) {
    throw new ProviderUiSelectorError(`${path} must contain a selector group.`)
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    const childPath = `${path}.${key}`
    if (Array.isArray(child)) {
      const candidates: readonly unknown[] = child
      if (candidates.length === 0 || candidates.length > 8) {
        throw new ProviderUiSelectorError(
          `${childPath} must contain 1-8 non-empty selector candidates.`
        )
      }
      const seen = new Set<string>()
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.trim() === '') {
          throw new ProviderUiSelectorError(
            `${childPath} must contain 1-8 non-empty selector candidates.`
          )
        }
        if (seen.has(candidate)) {
          throw new ProviderUiSelectorError(
            `${childPath} must not contain duplicate selector candidates.`
          )
        }
        seen.add(candidate)
        const trimmed = candidate.trim()
        if (
          candidate.length > 512 ||
          trimmed !== candidate ||
          /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?=/i.test(trimmed) ||
          /^(?:\/\/|\.\.|\(\s*\/\/)/.test(trimmed) ||
          candidate.includes(',') ||
          candidate.includes('>>') ||
          /\[\s*(?:aria-(?:label|labelledby|description|describedby|details|errormessage|placeholder|roledescription|valuetext)|title|alt|label|placeholder|value)\b/i.test(
            candidate
          ) ||
          /:(?:visible|has-text|text|text-is|text-matches|nth-match|light|near|right-of|left-of|above|below)(?:\(|\b)/i.test(
            candidate
          )
        ) {
          throw new ProviderUiSelectorError(
            `${childPath} contains an unsupported selector candidate.`
          )
        }
      }
      continue
    }
    if (!isSelectorTree(child)) {
      throw new ProviderUiSelectorError(
        `${childPath} must be a selector group.`
      )
    }
    validateSelectorTree(child, childPath)
  }
}

function isSelectorTree(value: unknown): value is SelectorTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactDomainKeys(
  provider: ProviderId,
  kind: 'model' | 'capability',
  domainKeys: readonly string[],
  uiKeys: readonly string[]
): void {
  const expected = [...domainKeys].sort()
  const actual = [...uiKeys].sort()
  if (expected.join('\0') !== actual.join('\0')) {
    throw new ProviderUiContractError(
      `${provider} UI ${kind} keys must match its provider definition exactly.`
    )
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}
