import { createHash } from 'node:crypto'

export const KEYBINDING_ACTIONS = [
  'app.interrupt',
  'app.exit',
  'input.submit',
  'input.newline',
  'input.complete',
  'input.clear',
  'input.deleteWordBackward',
  'input.deleteBackward',
  'input.deleteForward',
  'input.lineStart',
  'input.lineEnd',
  'input.moveLeft',
  'input.moveRight',
  'input.moveUp',
  'input.moveDown',
] as const

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]
export type KeybindingConfig = Record<KeybindingAction, readonly string[]>

export interface KeybindingInputEvent {
  return?: boolean
  escape?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  home?: boolean
  end?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  eventType?: 'press' | 'repeat' | 'release'
}

export interface KeybindingSnapshot {
  readonly bindings: KeybindingConfig
  readonly revision: string
}

export class KeybindingConfigError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'KeybindingConfigError'
  }
}

const ACTION_SET = new Set<string>(KEYBINDING_ACTIONS)
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super'] as const
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER)
const NAMED_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'home',
  'end',
  'left',
  'right',
  'up',
  'down',
  'space',
])

export function createDefaultKeybindings(
  platform: NodeJS.Platform = process.platform
): KeybindingConfig {
  const newline = platform === 'darwin' ? 'alt+enter' : 'shift+enter'
  return freezeBindings({
    'app.interrupt': ['ctrl+c'],
    'app.exit': ['ctrl+d'],
    'input.submit': ['enter'],
    'input.newline': [newline, 'ctrl+j'],
    'input.complete': ['tab'],
    'input.clear': ['ctrl+u', 'escape'],
    'input.deleteWordBackward': ['ctrl+w'],
    'input.deleteBackward': ['backspace'],
    'input.deleteForward': ['delete'],
    'input.lineStart': ['home', 'ctrl+a'],
    'input.lineEnd': ['end', 'ctrl+e'],
    'input.moveLeft': ['left'],
    'input.moveRight': ['right'],
    'input.moveUp': ['up'],
    'input.moveDown': ['down'],
  })
}

export function parseKeybindingConfig(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): KeybindingConfig {
  const defaults = createDefaultKeybindings(platform)
  if (value === undefined) {
    return defaults
  }
  if (!isRecord(value)) {
    throw new KeybindingConfigError('keybindings must be an object')
  }

  const unknownActions = Object.keys(value).filter(
    (action) => !ACTION_SET.has(action)
  )
  if (unknownActions.length > 0) {
    throw new KeybindingConfigError(
      `Unsupported keybinding actions: ${unknownActions.join(', ')}`
    )
  }

  const bindings: Record<KeybindingAction, string[]> = {
    'app.interrupt': [],
    'app.exit': [],
    'input.submit': [],
    'input.newline': [],
    'input.complete': [],
    'input.clear': [],
    'input.deleteWordBackward': [],
    'input.deleteBackward': [],
    'input.deleteForward': [],
    'input.lineStart': [],
    'input.lineEnd': [],
    'input.moveLeft': [],
    'input.moveRight': [],
    'input.moveUp': [],
    'input.moveDown': [],
  }
  const owners = new Map<string, KeybindingAction>()
  for (const action of KEYBINDING_ACTIONS) {
    const rawBindings = value[action]
    if (rawBindings !== undefined && !Array.isArray(rawBindings)) {
      throw new KeybindingConfigError(`keybindings.${action} must be an array`)
    }
    const source = rawBindings ?? defaults[action]
    const normalized: string[] = []
    const local = new Set<string>()
    for (const rawBinding of source) {
      if (typeof rawBinding !== 'string') {
        throw new KeybindingConfigError(
          `keybindings.${action} entries must be strings`
        )
      }
      const binding = normalizeConfiguredKey(rawBinding)
      if (local.has(binding)) {
        throw new KeybindingConfigError(
          `Duplicate keybinding for ${action}: ${binding}`
        )
      }
      const owner = owners.get(binding)
      if (owner !== undefined) {
        throw new KeybindingConfigError(
          `Keybinding ${binding} is assigned to both ${owner} and ${action}`
        )
      }
      local.add(binding)
      owners.set(binding, action)
      normalized.push(binding)
    }
    bindings[action] = normalized
  }

  if (bindings['input.submit'].length === 0) {
    throw new KeybindingConfigError(
      'keybindings.input.submit must contain at least one key'
    )
  }
  return freezeBindings(bindings)
}

export function createKeybindingSnapshot(
  bindings: KeybindingConfig
): KeybindingSnapshot {
  const revision = createHash('sha256')
    .update(JSON.stringify(bindings))
    .digest('hex')
    .slice(0, 12)
  return Object.freeze({ bindings, revision })
}

export function resolveKeybindingAction(
  snapshot: KeybindingSnapshot,
  input: string,
  key: KeybindingInputEvent
): KeybindingAction | null {
  const configuredKey = normalizeInputEvent(input, key)
  if (configuredKey === null) {
    return null
  }
  for (const action of KEYBINDING_ACTIONS) {
    if (snapshot.bindings[action].includes(configuredKey)) {
      return action
    }
  }
  return null
}

export function normalizeInputEvent(
  input: string,
  key: KeybindingInputEvent
): string | null {
  if (key.eventType === 'release') {
    return null
  }

  if (
    input === '\n' &&
    key.meta !== true &&
    key.shift !== true &&
    key.super !== true
  ) {
    return 'ctrl+j'
  }

  let base: string | null = null
  if (key.return === true || input === '\r') base = 'enter'
  else if (key.escape === true) base = 'escape'
  else if (key.tab === true || input === '\t') base = 'tab'
  else if (key.backspace === true) base = 'backspace'
  else if (key.delete === true) base = 'delete'
  else if (key.home === true) base = 'home'
  else if (key.end === true) base = 'end'
  else if (key.leftArrow === true) base = 'left'
  else if (key.rightArrow === true) base = 'right'
  else if (key.upArrow === true) base = 'up'
  else if (key.downArrow === true) base = 'down'
  else if ([...input].length === 1)
    base = input === ' ' ? 'space' : input.toLowerCase()

  if (base === null) {
    return null
  }
  return formatKey(base, {
    ctrl: key.ctrl === true,
    alt: key.meta === true,
    shift: key.shift === true,
    super: key.super === true,
  })
}

function normalizeConfiguredKey(value: string): string {
  if (value.length === 0) {
    throw new KeybindingConfigError('Keybindings cannot be empty strings')
  }
  if (/\s/.test(value)) {
    throw new KeybindingConfigError(
      `Invalid keybinding ${JSON.stringify(value)}: chords and whitespace are not supported`
    )
  }
  const parts = value.toLowerCase().split('+')
  const base = parts.pop()
  if (base === undefined || base === '') {
    throw new KeybindingConfigError(`Invalid keybinding: ${value}`)
  }

  const modifiers = new Set<string>()
  for (const modifier of parts) {
    if (!MODIFIER_SET.has(modifier)) {
      throw new KeybindingConfigError(
        `Unknown modifier in keybinding ${value}: ${modifier || '(empty)'}`
      )
    }
    if (modifiers.has(modifier)) {
      throw new KeybindingConfigError(
        `Duplicate modifier in keybinding ${value}: ${modifier}`
      )
    }
    modifiers.add(modifier)
  }

  if (!NAMED_KEYS.has(base) && [...base].length !== 1) {
    throw new KeybindingConfigError(
      `Unknown key in keybinding ${value}: ${base}`
    )
  }
  if (modifiers.size === 0 && (!NAMED_KEYS.has(base) || base === 'space')) {
    throw new KeybindingConfigError(
      `Unmodified printable keys are not supported: ${value}`
    )
  }
  return formatKey(base, {
    ctrl: modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
    super: modifiers.has('super'),
  })
}

function formatKey(
  base: string,
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; super: boolean }
): string {
  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers[modifier]),
    base,
  ].join('+')
}

function freezeBindings(
  bindings: Record<KeybindingAction, readonly string[]>
): KeybindingConfig {
  for (const action of KEYBINDING_ACTIONS) {
    Object.freeze(bindings[action])
  }
  return Object.freeze(bindings)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
