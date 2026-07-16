import test from 'node:test'
import assert from 'node:assert/strict'

import { ClaudeAdapter } from '../../../src/providers/adapters/adapter-claude.ts'

const MODEL_SELECTOR = '[role="menuitemradio"][data-trigger-disabled]:visible'
const EFFORT_SELECTOR =
  '[role="menuitemradio"][data-testid^="effort-option-"]:visible'
const ANY_RADIO_SELECTOR = `${MODEL_SELECTOR}, ${EFFORT_SELECTOR}`

test('ClaudeAdapter changes only selectable models and effort levels', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const page = createClaudeModelPage()
  adapter.page = page
  adapter.getRestoreTimeoutMs = () => 1000

  await adapter.changeModel('2+2')

  assert.equal(page.selectedModel, 1)
  assert.equal(page.selectedEffort, 1)
  assert.ok(page.queriedSelectors.includes(MODEL_SELECTOR))
  assert.ok(page.queriedSelectors.includes(EFFORT_SELECTOR))
})

test('ClaudeAdapter changes models when effort controls are unavailable', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const page = createClaudeModelPage({ hasEffort: false })
  adapter.page = page
  adapter.getRestoreTimeoutMs = () => 1000

  await adapter.changeModel('2')

  assert.equal(page.selectedModel, 1)
})

test('ClaudeAdapter closes model menus when selection fails', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  adapter.page = createClaudeModelPage()
  adapter.getRestoreTimeoutMs = () => 1000
  let closeCalls = 0
  adapter.closeModelMenus = async () => {
    closeCalls += 1
  }

  await assert.rejects(adapter.changeModel('3'), /does not have model 3/)

  assert.equal(closeCalls, 1)
})

test('ClaudeAdapter rejects a model menu that remains expanded', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const expanded = { count: async () => 1 }
  const empty = { count: async () => 0 }
  adapter.page = {
    keyboard: { press: async () => undefined },
    locator: (selector: string) => {
      if (selector.includes('[aria-expanded="true"]')) return expanded
      if (selector === '[role="menu"]:visible') {
        return { filter: () => empty }
      }
      return empty
    },
  }

  await assert.rejects(
    adapter.closeModelMenus(),
    /model menu did not close cleanly/
  )
})

test('ClaudeAdapter uploads all requested files through the file input', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const uploads: string[][] = []
  const input = {
    count: async () => 1,
    first: () => input,
    setInputFiles: async (paths: string[]) => {
      uploads.push(paths)
    },
  }
  adapter.page = {
    locator: (selector: string) => {
      assert.equal(selector, 'input[data-testid="file-upload"]')
      return input
    },
  }

  await adapter.attachFile(['C:/tmp/one.txt', 'C:/tmp/two.png'])

  assert.deepEqual(uploads, [['C:/tmp/one.txt', 'C:/tmp/two.png']])
})

test('ClaudeAdapter reports login only when the composer is ready', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  adapter.isComposerReady = async () => true
  adapter.isLoginPageVisible = async () => false
  assert.equal(await adapter.isLoggedIn(), true)

  adapter.isLoginPageVisible = async () => true
  assert.equal(await adapter.isLoggedIn(), false)
})

test('ClaudeAdapter reads and idempotently changes web_search', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const page = createClaudeCapabilityPage()
  adapter.page = page
  adapter.getComposerRoot = () => page.root

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

test('ClaudeAdapter hides disabled or ambiguous web_search controls', async () => {
  for (const options of [
    { enabled: false },
    { disabled: true },
    { triggerCount: 2 },
    { itemCount: 2 },
  ]) {
    const adapter = Object.create(ClaudeAdapter.prototype) as any
    const page = createClaudeCapabilityPage(options)
    adapter.page = page
    adapter.getComposerRoot = () => page.root

    assert.equal(await adapter.hasToggleCapability('web_search'), false)
    assert.equal(page.open, false)
  }
})

test('ClaudeAdapter rejects invalid web_search checkbox state and closes the menu', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const page = createClaudeCapabilityPage({ checked: null })
  adapter.page = page
  adapter.getComposerRoot = () => page.root

  await assert.rejects(
    adapter.getToggleState('web_search'),
    (error: any) => error.detailCode === 'claude_web_search_state_invalid'
  )
  assert.equal(page.open, false)
})

test('ClaudeAdapter rejects an unverified web_search change and closes the menu', async () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as any
  const page = createClaudeCapabilityPage({ applyClick: false })
  adapter.page = page
  adapter.getComposerRoot = () => page.root

  await assert.rejects(
    adapter.setToggleState('web_search', 'on'),
    (error: any) => error.detailCode === 'claude_web_search_state_mismatch'
  )
  assert.equal(page.open, false)
})

function createClaudeModelPage({ hasEffort = true } = {}) {
  const page = {
    selectedModel: 0,
    selectedEffort: 0,
    queriedSelectors: [] as string[],
    url: () => 'https://claude.ai/new',
    keyboard: {
      press: async () => undefined,
    },
    locator: (selector: string): any => {
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
        return {
          filter: ({ has }: { has: any }) => {
            if (has === modelCollection) {
              return {
                first: () => mainMenu,
                count: async () => 1,
              }
            }
            if (has === anyRadioCollection) {
              return emptyLocator()
            }
            return {
              last: () => effortMenu,
              count: async () => (hasEffort ? 1 : 0),
            }
          },
        }
      }
      if (
        selector === '[data-base-ui-inert]' ||
        selector ===
          'button[data-testid="model-selector-dropdown"][aria-expanded="true"]' ||
        selector === '[data-testid="effort-menu-trigger"]:visible'
      ) {
        return emptyLocator()
      }
      throw new Error(`Unexpected page selector: ${selector}`)
    },
  }

  const modelItems = ['Sonnet', 'Haiku'].map((name, index) => ({
    innerText: async () => name,
    getAttribute: async (attribute: string) =>
      attribute === 'aria-checked' && page.selectedModel === index
        ? 'true'
        : 'false',
    click: async () => {
      page.selectedModel = index
    },
  }))
  const effortItems = ['Low', 'Medium'].map((name, index) => ({
    innerText: async () => name,
    getAttribute: async (attribute: string) =>
      attribute === 'aria-checked' && page.selectedEffort === index
        ? 'true'
        : 'false',
    click: async () => {
      page.selectedEffort = index
    },
  }))
  const modelCollection = collection(modelItems)
  const effortCollection = collection(effortItems)
  const anyRadioCollection = emptyLocator()
  const mainMenu = {
    locator: (selector: string) => {
      page.queriedSelectors.push(selector)
      if (selector === MODEL_SELECTOR) return modelCollection
      if (
        selector ===
        '[role="menuitem"][aria-haspopup="menu"]:not([data-testid="effort-menu-trigger"])'
      ) {
        return firstLocator({ isVisible: async () => false })
      }
      throw new Error(`Unexpected main menu selector: ${selector}`)
    },
  }
  const effortMenu = {
    locator: (selector: string) => {
      page.queriedSelectors.push(selector)
      assert.equal(selector, EFFORT_SELECTOR)
      return effortCollection
    },
  }
  const modelTrigger = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => undefined,
  }
  const effortTrigger = {
    isVisible: async () => true,
    click: async () => undefined,
    locator: (selector: string) => {
      assert.equal(selector, 'xpath=ancestor::*[@role="menu"][1]')
      return firstLocator(mainMenu)
    },
  }
  return page
}

function collection(items: any[]) {
  return {
    count: async () => items.length,
    nth: (index: number) => items[index],
  }
}

function firstLocator(target: any) {
  return {
    first: () => target,
  }
}

function emptyLocator() {
  return {
    count: async () => 0,
  }
}

function missingLocator() {
  return {
    isVisible: async () => false,
  }
}

function createClaudeCapabilityPage({
  triggerCount = 1,
  itemCount = 1,
  enabled = true,
  disabled = false,
  checked = 'false' as string | null,
  applyClick = true,
} = {}) {
  let open = false
  let currentChecked = checked
  let itemClicks = 0
  const trigger = {
    isVisible: async () => true,
    isEnabled: async () => true,
    getAttribute: async (name: string) =>
      name === 'aria-expanded' ? String(open) : null,
    click: async () => {
      open = true
    },
  }
  const item = {
    isVisible: async () => true,
    isEnabled: async () => enabled,
    getAttribute: async (name: string) => {
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
  }
  const triggerCollection = {
    count: async () => triggerCount,
    first: () => trigger,
  }
  const expandedTriggerCollection = {
    count: async () => (open ? triggerCount : 0),
  }
  const itemCollection = {
    count: async () => (open ? itemCount : 0),
    first: () => item,
  }
  const root = {
    locator: (selector: string) =>
      selector.includes('[aria-expanded="true"]')
        ? expandedTriggerCollection
        : triggerCollection,
  }
  const page = {
    root,
    get open() {
      return open
    },
    get state() {
      return currentChecked === 'true' ? 'on' : 'off'
    },
    get itemClicks() {
      return itemClicks
    },
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      assert.equal(role, 'menuitemcheckbox')
      assert.deepEqual(options, { name: 'Web search', exact: true })
      return itemCollection
    },
    locator: (selector: string) => {
      assert.equal(selector, '[role="menu"]:visible')
      return { count: async () => (open ? 1 : 0) }
    },
    keyboard: {
      press: async (key: string) => {
        assert.equal(key, 'Escape')
        open = false
      },
    },
  }
  return page
}
