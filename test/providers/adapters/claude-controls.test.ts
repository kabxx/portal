import test from 'node:test'
import assert from 'node:assert/strict'
import type { Page } from 'playwright'

import { ClaudeAdapter } from '../../../src/providers/adapters/adapter-claude.ts'
import { isProviderAdapterError } from '../../../src/providers/adapters/adapter-base.ts'
import { createBrowserContextStub } from '../../helpers/fakes.ts'

const MODEL_SELECTOR = '[role="menuitemradio"][data-trigger-disabled]:visible'
const EFFORT_SELECTOR =
  '[role="menuitemradio"][data-testid^="effort-option-"]:visible'
const ANY_RADIO_SELECTOR = `${MODEL_SELECTOR}, ${EFFORT_SELECTOR}`
const INPUT_SELECTOR = '[data-testid="chat-input"]'
const COMPOSER_ROOT_SELECTOR =
  'xpath=ancestor::div[.//input[@data-testid="file-upload"] and .//*[@data-testid="model-selector-dropdown"]][1]'
const VOICE_BUTTON_SELECTOR = 'button:has(svg[viewBox^="0 0 21.2"])'

interface TestLocator {
  count(): Promise<number>
  first(): TestLocator
  last(): TestLocator
  nth(index: number): TestLocator
  filter(options: { has?: TestLocator; hasNot?: TestLocator }): TestLocator
  locator(selector: string): TestLocator
  isVisible(): Promise<boolean>
  isEnabled(): Promise<boolean>
  click(): Promise<void>
  focus(): Promise<void>
  getAttribute(name: string): Promise<string | null>
  innerText(): Promise<string>
  setInputFiles(paths: string[]): Promise<void>
}

interface TestPage {
  keyboard: {
    press(key: string): Promise<void>
  }
  url(): string
  locator(selector: string): TestLocator
  getByRole(
    role: string,
    options: { name: string; exact: boolean }
  ): TestLocator
}

class ClaudeAdapterHarness extends ClaudeAdapter {
  public constructor(page: TestPage) {
    super(createBrowserContextStub())
    this.page = page as unknown as Page
  }

  protected override getRestoreTimeoutMs(): number {
    return 1000
  }
}

test('ClaudeAdapter changes only selectable models and effort levels', async () => {
  const page = createClaudeModelPage()
  const adapter = new ClaudeAdapterHarness(page)

  await adapter.changeModel('2+2')

  assert.equal(page.selectedModel, 1)
  assert.equal(page.selectedEffort, 1)
  assert.ok(page.queriedSelectors.includes(MODEL_SELECTOR))
  assert.ok(page.queriedSelectors.includes(EFFORT_SELECTOR))
})

test('ClaudeAdapter changes models when effort controls are unavailable', async () => {
  const page = createClaudeModelPage({ hasEffort: false })
  const adapter = new ClaudeAdapterHarness(page)

  await adapter.changeModel('2')

  assert.equal(page.selectedModel, 1)
})

test('ClaudeAdapter closes model menus when selection fails', async () => {
  const page = createClaudeModelPage()
  const adapter = new ClaudeAdapterHarness(page)

  await assert.rejects(adapter.changeModel('3'), /does not have model 3/)

  assert.equal(page.escapePresses, 1)
})

test('ClaudeAdapter rejects a model menu that remains expanded', async () => {
  const page = createClaudeModelPage({ stuckMenus: true })
  const adapter = new ClaudeAdapterHarness(page)

  await assert.rejects(
    adapter.changeModel('3'),
    /model menu did not close cleanly/
  )
})

test('ClaudeAdapter uploads all requested files through the file input', async () => {
  const uploads: string[][] = []
  const input = createLocator({
    count: async () => 1,
    setInputFiles: async (paths) => {
      uploads.push(paths)
    },
  })
  const page = createPage({
    locator: (selector) => {
      assert.equal(selector, 'input[data-testid="file-upload"]')
      return input
    },
  })
  const adapter = new ClaudeAdapterHarness(page)

  await adapter.attachFile(['C:/tmp/one.txt', 'C:/tmp/two.png'])

  assert.deepEqual(uploads, [['C:/tmp/one.txt', 'C:/tmp/two.png']])
})

test('ClaudeAdapter uses the unique Voice Mode structure as page ready', async () => {
  for (const [options, expected] of [
    [{}, true],
    [{ buttonCount: 0 }, false],
    [{ buttonCount: 2 }, false],
    [{ visible: false }, false],
    [{ enabled: false }, false],
    [{ ariaDisabled: 'true' }, false],
  ] as const) {
    const page = createClaudeReadyPage(options)
    const adapter = new ClaudeAdapterHarness(page)

    assert.equal(await adapter.isLoggedIn(), expected)
  }
})

test('ClaudeAdapter gives login priority over Voice Mode ready', async () => {
  const page = createClaudeReadyPage({ loginVisible: true })
  const adapter = new ClaudeAdapterHarness(page)

  assert.equal(await adapter.isLoggedIn(), false)
})

test('ClaudeAdapter recognizes Claude authentication URL variants', async () => {
  const page = createClaudeReadyPage()
  const adapter = new ClaudeAdapterHarness(page)

  for (const pathname of [
    '/login',
    '/login/',
    '/login/continue',
    '/login?returnTo=%2Fnew',
    '/signup',
    '/signup/account',
  ]) {
    page.urlValue = `https://claude.ai${pathname}`
    assert.equal(await adapter.isLoggedIn(), false, pathname)
  }

  for (const pathname of ['/new', '/loginfoo', '/signups']) {
    page.urlValue = `https://claude.ai${pathname}`
    assert.equal(await adapter.isLoggedIn(), true, pathname)
  }
})

test('ClaudeAdapter classifies attachText login separately from a missing composer', async () => {
  const loginPage = createClaudeReadyPage({ loginVisible: true })
  const loginAdapter = new ClaudeAdapterHarness(loginPage)
  await assert.rejects(
    loginAdapter.attachText('setup'),
    (error) =>
      isProviderAdapterError(error) &&
      error.kind === 'auth' &&
      error.adapter === loginAdapter &&
      loginPage.inputReads === 0
  )

  let loginChecks = 0
  const redirectPage = createClaudeReadyPage({
    composerReady: false,
    loginVisible: () => {
      loginChecks += 1
      return loginChecks >= 2
    },
  })
  const redirectAdapter = new ClaudeAdapterHarness(redirectPage)

  await assert.rejects(
    redirectAdapter.attachText('setup'),
    (error) =>
      isProviderAdapterError(error) &&
      error.kind === 'auth' &&
      error.adapter === redirectAdapter
  )

  const missingPage = createClaudeReadyPage({ composerReady: false })
  const missingAdapter = new ClaudeAdapterHarness(missingPage)
  await assert.rejects(
    missingAdapter.attachText('setup'),
    (error) =>
      isProviderAdapterError(error) &&
      error.kind === 'ui' &&
      error.detailCode === 'claude_composer_missing'
  )
})

test('ClaudeAdapter reads and idempotently changes web_search', async () => {
  const page = createClaudeCapabilityPage()
  const adapter = new ClaudeAdapterHarness(page)

  assert.equal(await adapter.hasToggleCapability('web_search'), true)
  assert.equal(page.open, false)
  assert.equal(await adapter.getToggleState('web_search'), 'off')
  assert.equal(page.open, false)
  assert.equal(await adapter.setToggleState('web_search', 'on'), 'on')
  assert.equal(page.state, 'on')
  assert.equal(page.itemClicks, 1)
  assert.equal(page.open, false)
  assert.equal(await adapter.setToggleState('web_search', 'on'), 'on')
  assert.equal(page.itemClicks, 1)
  assert.equal(await adapter.setToggleState('web_search', 'off'), 'off')
  assert.equal(page.state, 'off')
  assert.equal(page.itemClicks, 2)
  assert.equal(page.open, false)
})

test('ClaudeAdapter rejects unsupported toggle capabilities before opening tools', async () => {
  const page = createClaudeCapabilityPage()
  const adapter = new ClaudeAdapterHarness(page)

  assert.equal(await adapter.hasToggleCapability('thinking'), false)
  await assert.rejects(
    adapter.getToggleState('thinking'),
    (error: unknown) =>
      isProviderAdapterError(error) &&
      error.kind === 'unsupported' &&
      error.action === 'webSearchStatus' &&
      error.detailCode === null
  )
  await assert.rejects(
    adapter.setToggleState('thinking', 'on'),
    (error: unknown) =>
      isProviderAdapterError(error) &&
      error.kind === 'unsupported' &&
      error.action === 'webSearchSet' &&
      error.detailCode === null
  )
  assert.equal(page.open, false)
  assert.equal(page.itemClicks, 0)
})

test('ClaudeAdapter hides disabled or ambiguous web_search controls', async () => {
  for (const options of [
    { enabled: false },
    { disabled: true },
    { triggerCount: 2 },
    { itemCount: 2 },
  ]) {
    const page = createClaudeCapabilityPage(options)
    const adapter = new ClaudeAdapterHarness(page)

    assert.equal(await adapter.hasToggleCapability('web_search'), false)
    assert.equal(page.open, false)
  }
})

test('ClaudeAdapter rejects invalid web_search checkbox state and closes the menu', async () => {
  const page = createClaudeCapabilityPage({ checked: null })
  const adapter = new ClaudeAdapterHarness(page)

  await assert.rejects(
    adapter.getToggleState('web_search'),
    (error: unknown) =>
      isProviderAdapterError(error) &&
      error.detailCode === 'claude_web_search_state_invalid'
  )
  assert.equal(page.open, false)
})

test('ClaudeAdapter rejects an unverified web_search change and closes the menu', async () => {
  const page = createClaudeCapabilityPage({ applyClick: false })
  const adapter = new ClaudeAdapterHarness(page)

  await assert.rejects(
    adapter.setToggleState('web_search', 'on'),
    (error: unknown) =>
      isProviderAdapterError(error) &&
      error.detailCode === 'claude_web_search_state_mismatch'
  )
  assert.equal(page.open, false)
})

interface ClaudeModelPageOptions {
  hasEffort?: boolean
  stuckMenus?: boolean
}

interface ClaudeModelPage extends TestPage {
  selectedModel: number
  selectedEffort: number
  readonly queriedSelectors: string[]
  readonly escapePresses: number
}

function createClaudeModelPage({
  hasEffort = true,
  stuckMenus = false,
}: ClaudeModelPageOptions = {}): ClaudeModelPage {
  let modelMenuOpen = false
  let effortMenuOpen = false
  let escapePresses = 0
  const page: ClaudeModelPage = {
    selectedModel: 0,
    selectedEffort: 0,
    queriedSelectors: [],
    get escapePresses() {
      return escapePresses
    },
    url: () => 'https://claude.ai/new',
    keyboard: {
      press: async (key) => {
        assert.equal(key, 'Escape')
        escapePresses += 1
        if (!stuckMenus) {
          modelMenuOpen = false
          effortMenuOpen = false
        }
      },
    },
    getByRole: () => createLocator(),
    locator: (selector) => {
      if (selector === 'button[data-testid="model-selector-dropdown"]') {
        return firstLocator(modelTrigger)
      }
      if (selector === '[data-testid="effort-menu-trigger"]') {
        return firstLocator(hasEffort ? effortTrigger : missingLocator())
      }
      if (selector === MODEL_SELECTOR) {
        return modelCollection
      }
      if (selector === EFFORT_SELECTOR) {
        return effortCollection
      }
      if (selector === ANY_RADIO_SELECTOR) {
        return anyRadioCollection
      }
      if (selector === '[role="menu"]:visible') {
        return createLocator({
          filter: ({ has }) => {
            if (has === modelCollection) {
              return createLocator({
                first: () => mainMenu,
                count: async () => (modelMenuOpen ? 1 : 0),
              })
            }
            if (has === anyRadioCollection) {
              return createLocator({
                count: async () => (modelMenuOpen || effortMenuOpen ? 1 : 0),
              })
            }
            return createLocator({
              last: () => effortMenu,
              count: async () => (effortMenuOpen ? 1 : 0),
            })
          },
        })
      }
      if (selector === '[data-base-ui-inert]') {
        return createLocator({
          count: async () => (modelMenuOpen || effortMenuOpen ? 1 : 0),
        })
      }
      if (
        selector ===
        'button[data-testid="model-selector-dropdown"][aria-expanded="true"]'
      ) {
        return createLocator({
          count: async () => (modelMenuOpen ? 1 : 0),
        })
      }
      if (selector === '[data-testid="effort-menu-trigger"]:visible') {
        return createLocator({
          count: async () => (hasEffort ? 1 : 0),
        })
      }
      throw new Error(`Unexpected page selector: ${selector}`)
    },
  }

  const modelItems = ['Sonnet', 'Haiku'].map((name, index) =>
    createLocator({
      innerText: async () => name,
      getAttribute: async (attribute) =>
        attribute === 'aria-checked' && page.selectedModel === index
          ? 'true'
          : 'false',
      click: async () => {
        page.selectedModel = index
      },
    })
  )
  const effortItems = ['Low', 'Medium'].map((name, index) =>
    createLocator({
      innerText: async () => name,
      getAttribute: async (attribute) =>
        attribute === 'aria-checked' && page.selectedEffort === index
          ? 'true'
          : 'false',
      click: async () => {
        page.selectedEffort = index
      },
    })
  )
  const modelCollection = collection(modelItems)
  const effortCollection = collection(effortItems)
  const anyRadioCollection = createLocator()
  const mainMenu = createLocator({
    locator: (selector) => {
      page.queriedSelectors.push(selector)
      if (selector === MODEL_SELECTOR) return modelCollection
      if (
        selector ===
        '[role="menuitem"][aria-haspopup="menu"]:not([data-testid="effort-menu-trigger"])'
      ) {
        return firstLocator(createLocator({ isVisible: async () => false }))
      }
      throw new Error(`Unexpected main menu selector: ${selector}`)
    },
  })
  const effortMenu = createLocator({
    locator: (selector) => {
      page.queriedSelectors.push(selector)
      assert.equal(selector, EFFORT_SELECTOR)
      return effortCollection
    },
  })
  const modelTrigger = createLocator({
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      modelMenuOpen = true
    },
  })
  const effortTrigger = createLocator({
    isVisible: async () => true,
    click: async () => {
      effortMenuOpen = true
    },
    locator: (selector) => {
      assert.equal(selector, 'xpath=ancestor::*[@role="menu"][1]')
      return firstLocator(mainMenu)
    },
  })
  return page
}

interface ClaudeReadyPageOptions {
  buttonCount?: number
  visible?: boolean
  enabled?: boolean
  ariaDisabled?: string | null
  composerReady?: boolean
  loginVisible?: boolean | (() => boolean)
}

interface ClaudeReadyPage extends TestPage {
  urlValue: string
  readonly inputReads: number
}

function createClaudeReadyPage(
  options: ClaudeReadyPageOptions = {}
): ClaudeReadyPage {
  const buttonCount = options.buttonCount ?? 1
  const visible = options.visible ?? true
  const enabled = options.enabled ?? true
  const ariaDisabled = options.ariaDisabled ?? null
  const composerReady = options.composerReady ?? true
  const loginVisible = options.loginVisible ?? false
  let inputReads = 0
  const voiceButton = createLocator({
    isVisible: async () => visible,
    isEnabled: async () => enabled,
    getAttribute: async (name) =>
      name === 'aria-disabled' ? ariaDisabled : null,
  })
  const composerRoot = createLocator({
    locator: (selector) => {
      assert.equal(selector, VOICE_BUTTON_SELECTOR)
      return createLocator({
        count: async () => buttonCount,
        first: () => voiceButton,
      })
    },
  })
  const input = createLocator({
    isVisible: async () => composerReady,
    getAttribute: async (name) =>
      name === 'contenteditable' && composerReady ? 'true' : null,
    locator: (selector) => {
      assert.equal(selector, COMPOSER_ROOT_SELECTOR)
      return composerRoot
    },
  })
  const loginControl = createLocator({
    isVisible: async () =>
      typeof loginVisible === 'function' ? loginVisible() : loginVisible,
  })
  const page: ClaudeReadyPage = {
    urlValue: 'https://claude.ai/new',
    get inputReads() {
      return inputReads
    },
    url: () => page.urlValue,
    keyboard: { press: async () => undefined },
    getByRole: () => createLocator(),
    locator: (selector) => {
      if (selector === INPUT_SELECTOR) {
        inputReads += 1
        return firstLocator(input)
      }
      if (selector === '[data-testid="email"], [data-testid="continue"]') {
        return firstLocator(loginControl)
      }
      throw new Error(`Unexpected ready selector: ${selector}`)
    },
  }
  return page
}

function collection(items: readonly TestLocator[]): TestLocator {
  return createLocator({
    count: async () => items.length,
    nth: (index) => items[index] ?? createLocator(),
  })
}

function firstLocator(target: TestLocator): TestLocator {
  return createLocator({ first: () => target })
}

function missingLocator(): TestLocator {
  return createLocator({ isVisible: async () => false })
}

interface ClaudeCapabilityPageOptions {
  triggerCount?: number
  itemCount?: number
  enabled?: boolean
  disabled?: boolean
  checked?: string | null
  applyClick?: boolean
}

interface ClaudeCapabilityPage extends TestPage {
  readonly open: boolean
  readonly state: 'on' | 'off'
  readonly itemClicks: number
}

function createClaudeCapabilityPage(
  options: ClaudeCapabilityPageOptions = {}
): ClaudeCapabilityPage {
  const triggerCount = options.triggerCount ?? 1
  const itemCount = options.itemCount ?? 1
  const enabled = options.enabled ?? true
  const disabled = options.disabled ?? false
  const checked = options.checked === undefined ? 'false' : options.checked
  const applyClick = options.applyClick ?? true
  let open = false
  let currentChecked = checked
  let itemClicks = 0
  const trigger = createLocator({
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async (name) =>
      name === 'aria-expanded' ? String(open) : null,
    click: async () => {
      open = true
    },
  })
  const item = createLocator({
    isVisible: async () => true,
    isEnabled: async () => enabled,
    getAttribute: async (name) => {
      if (name === 'aria-disabled') return disabled ? 'true' : null
      if (name === 'aria-checked') return currentChecked
      return null
    },
    click: async () => {
      itemClicks += 1
      if (applyClick) {
        currentChecked = currentChecked === 'true' ? 'false' : 'true'
      }
      open = false
    },
  })
  const triggerCollection = createLocator({
    count: async () => triggerCount,
    first: () => trigger,
  })
  const expandedTriggerCollection = createLocator({
    count: async () => (open ? triggerCount : 0),
  })
  const itemCollection = createLocator({
    count: async () => (open ? itemCount : 0),
    first: () => item,
  })
  const root = createLocator({
    locator: (selector) =>
      selector.includes('[aria-expanded="true"]')
        ? expandedTriggerCollection
        : triggerCollection,
  })
  const input = createLocator({
    locator: (selector) => {
      assert.equal(selector, COMPOSER_ROOT_SELECTOR)
      return root
    },
  })
  return {
    get open() {
      return open
    },
    get state() {
      return currentChecked === 'true' ? 'on' : 'off'
    },
    get itemClicks() {
      return itemClicks
    },
    url: () => 'https://claude.ai/new',
    getByRole: (role, roleOptions) => {
      assert.equal(role, 'menuitemcheckbox')
      assert.deepEqual(roleOptions, { name: 'Web search', exact: true })
      return itemCollection
    },
    locator: (selector) => {
      if (selector === INPUT_SELECTOR) return firstLocator(input)
      assert.equal(selector, '[role="menu"]:visible')
      return createLocator({ count: async () => (open ? 1 : 0) })
    },
    keyboard: {
      press: async (key) => {
        assert.equal(key, 'Escape')
        open = false
      },
    },
  }
}

function createPage(overrides: Partial<TestPage> = {}): TestPage {
  return {
    keyboard: { press: async () => undefined },
    url: () => 'https://claude.ai/new',
    locator: () => createLocator(),
    getByRole: () => createLocator(),
    ...overrides,
  }
}

function createLocator(overrides: Partial<TestLocator> = {}): TestLocator {
  const locator: TestLocator = {
    count: async () => 0,
    first: () => locator,
    last: () => locator,
    nth: () => locator,
    filter: () => locator,
    locator: () => locator,
    isVisible: async () => false,
    isEnabled: async () => false,
    click: async () => undefined,
    focus: async () => undefined,
    getAttribute: async () => null,
    innerText: async () => '',
    setInputFiles: async () => undefined,
    ...overrides,
  }
  return locator
}
