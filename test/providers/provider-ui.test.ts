import assert from 'node:assert/strict'
import test from 'node:test'

import type { Locator } from 'playwright'

import {
  defineProviderUiCapabilityMap,
  defineProviderUiModelPositions,
  defineProviderUiSelectors,
  ProviderUiContractError,
  joinCssLocatorCandidates,
  mapCssLocatorCandidates,
  ProviderUiSelectorError,
  resolveUniqueVisibleLocator,
  type LocatorRoot,
} from '../../src/providers/ui/provider-ui.ts'

test('provider UI domain maps require exact model and capability keys', () => {
  const positions = defineProviderUiModelPositions('chatgpt', { chatgpt: 2 })
  assert.equal(positions.chatgpt, 2)
  assert.equal(Object.isFrozen(positions), true)

  const capabilities = defineProviderUiCapabilityMap('kimi', {
    search: { storageKey: 'selectSearch' },
  })
  assert.equal(capabilities.search.storageKey, 'selectSearch')
  assert.equal(Object.isFrozen(capabilities.search), true)

  assert.throws(
    () => defineProviderUiModelPositions('chatgpt', { missing: 1 }),
    ProviderUiContractError
  )
  assert.throws(
    () =>
      defineProviderUiModelPositions('gemini', {
        '3.5-flash-lite': 1,
        '3.6-flash': 1,
        '3.1-pro': 3,
      }),
    /must be unique integers/
  )
  assert.throws(
    () => defineProviderUiCapabilityMap('kimi', {}),
    ProviderUiContractError
  )
})

test('provider UI selector trees are cloned and deeply frozen', () => {
  const input = {
    composer: {
      input: ['#prompt'] as [string],
    },
  }

  const selectors = defineProviderUiSelectors(input)
  input.composer.input[0] = '#changed'

  assert.equal(selectors.composer.input[0], '#prompt')
  assert.notEqual(selectors, input)
  assert.equal(Object.isFrozen(selectors), true)
  assert.equal(Object.isFrozen(selectors.composer), true)
  assert.equal(Object.isFrozen(selectors.composer.input), true)
})

test('provider UI selector trees reject invalid groups and candidate lists', () => {
  assert.throws(() => defineProviderUiSelectors({}), ProviderUiSelectorError)
  assert.throws(
    () =>
      defineProviderUiSelectors({
        composer: { input: [] },
      }),
    /1-8 non-empty selector candidates/
  )
  assert.throws(
    () =>
      defineProviderUiSelectors({
        composer: {
          input: ['#a', '#b', '#c', '#d', '#e', '#f', '#g', '#h', '#i'],
        },
      }),
    /1-8 non-empty selector candidates/
  )
  assert.throws(
    () =>
      defineProviderUiSelectors({
        composer: { input: ['#prompt', '#prompt'] },
      }),
    /must not contain duplicate selector candidates/
  )
})

test('provider UI selector trees accept CSS and reject behavioral or text identity', () => {
  const invalidCandidates = [
    ' text=Send',
    'text=Send',
    'xpath=//button',
    '//button',
    '#first, #second',
    '#owner >> button',
    '[aria-label="Send"]',
    '[placeholder="Message"]',
    '[title="Upload"]',
    'button:visible',
    'button:has-text("Send")',
    `#${'x'.repeat(512)}`,
  ]

  for (const candidate of invalidCandidates) {
    assert.throws(
      () =>
        defineProviderUiSelectors({
          composer: { input: [candidate] },
        }),
      /unsupported selector candidate/,
      candidate
    )
  }

  assert.doesNotThrow(() =>
    defineProviderUiSelectors({
      composer: {
        input: [
          '#prompt',
          '[data-testid="composer"] [contenteditable="true"]',
          'button:has(svg[viewBox^="0 0 20"]):not(.disabled)',
          '.px-1\\.5',
        ],
      },
    })
  )
})

test('provider UI selector helpers build CSS unions without changing candidates', () => {
  const candidates = ['#prompt', '[data-testid="composer"]'] as const

  assert.equal(
    joinCssLocatorCandidates(candidates, ':visible'),
    '#prompt:visible, [data-testid="composer"]:visible'
  )
  assert.equal(
    mapCssLocatorCandidates(
      candidates,
      (candidate, index) => `${candidate}:nth-child(${index + 1})`
    ),
    '#prompt:nth-child(1), [data-testid="composer"]:nth-child(2)'
  )
  assert.deepEqual(candidates, ['#prompt', '[data-testid="composer"]'])
})

test('resolveUniqueVisibleLocator resolves one visible DOM target from one CSS union', async () => {
  const hidden = createLocatorTarget(false)
  const visible = createLocatorTarget(true)
  const calls: string[] = []
  const root = createLocatorRoot([hidden, visible], calls)

  const result = await resolveUniqueVisibleLocator(root, ['#prompt', '.prompt'])

  assert.equal(result, visible)
  assert.deepEqual(calls, ['#prompt, .prompt'])
})

test('resolveUniqueVisibleLocator rejects ambiguous or unreadable targets', async () => {
  const calls: string[] = []
  const ambiguous = createLocatorRoot(
    [createLocatorTarget(true), createLocatorTarget(true)],
    calls
  )
  assert.equal(
    await resolveUniqueVisibleLocator(ambiguous, ['#first', '#second']),
    null
  )
  assert.deepEqual(calls, ['#first, #second'])

  const unreadable: LocatorRoot = {
    locator: () => {
      const locator = {
        count: async () => await Promise.reject(new Error('detached')),
      }
      // The fake intentionally implements only the Locator methods used here.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return locator as unknown as Locator
    },
  }
  assert.equal(await resolveUniqueVisibleLocator(unreadable, ['#prompt']), null)
})

function createLocatorTarget(visible: boolean): Locator {
  const target = {
    isVisible: async () => visible,
  }
  // The fake intentionally implements only the Locator methods used here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return target as unknown as Locator
}

function createLocatorRoot(
  targets: readonly Locator[],
  calls: string[]
): LocatorRoot {
  const root = {
    locator: (selector: string) => {
      calls.push(selector)
      const locator = {
        count: async () => targets.length,
        nth: (index: number) => targets[index],
      }
      // The fake intentionally implements only the Locator methods used here.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return locator as unknown as Locator
    },
  }
  return root
}
