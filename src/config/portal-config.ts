import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { tryLock, unlock } from 'fs-native-extensions'
import {
  Document,
  isMap,
  isScalar,
  parse,
  parseDocument,
  stringify,
} from 'yaml'
import {
  createDefaultHooksConfig,
  HookConfigError,
  parseHooksConfig,
} from '../hooks/hook-config.ts'
import type { HooksConfig } from '../hooks/hook-types.ts'
import {
  KEYBINDING_ACTIONS,
  KeybindingConfigError,
  createDefaultKeybindings,
  parseKeybindingConfig,
  type KeybindingConfig,
} from '../keybindings/keybinding-config.ts'
import {
  getDefaultBrowserExecutableCandidates,
  type BrowserEngine,
} from '../platform/platform-defaults.ts'
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PRIVATE_FILE_MODE,
} from '../shared/private-files.ts'

export interface PortalBrowserConfig {
  engine: BrowserEngine
  executablePath: string
  profilePath: string
  remoteDebuggingPort: number
}

export interface PortalMcpServerConfig {
  host: string
  port: number
  token: string | null
}

export interface PortalListenersConfig {
  mcp: PortalMcpServerConfig
}

export interface PortalAdvancedBrowserConfig {
  startupTimeoutSeconds: number
  closeTimeoutSeconds: number
}

export interface PortalAdvancedProviderConfig {
  requestStartWarningAfterSeconds: number
  blockedWarningEverySeconds: number
  responseStartTimeoutSeconds: number
  responseStallTimeoutSeconds: number
  restoreTimeoutSeconds: number
  historyLoadTimeoutSeconds: number
  historyPageTimeoutSeconds: number
}

export interface PortalAdvancedRuntimeConfig {
  initializationAttemptLimit: number
  requestAttemptLimit: number
  spawnDepthLimit: number
  cancelWaitTimeoutSeconds: number
  shutdownCloseTimeoutSeconds: number
  childRuntimeCloseTimeoutSeconds: number
}

export interface PortalAdvancedCommandConfig {
  resultOutputLimitMB: number
  stopGraceSeconds: number
  stopTimeoutSeconds: number
}

export interface PortalAdvancedSkillInstallConfig {
  downloadTimeoutSeconds: number
  downloadLimitMB: number
  extractedSizeLimitMB: number
  fileCountLimit: number
  resourceFileCountLimit: number
  manifestSizeLimitKB: number
  redirectLimit: number
}

export interface PortalAdvancedHooksConfig {
  commandOutputLimitMB: number
}

export interface PortalAdvancedConfig {
  browser: PortalAdvancedBrowserConfig
  provider: PortalAdvancedProviderConfig
  runtime: PortalAdvancedRuntimeConfig
  command: PortalAdvancedCommandConfig
  skillInstall: PortalAdvancedSkillInstallConfig
  hooks: PortalAdvancedHooksConfig
}

export interface PortalConfigDocument {
  browser: PortalBrowserConfig
  projectInstructions: boolean
  listeners: PortalListenersConfig
  skills: Record<string, unknown>
  hooks: HooksConfig
  keybindings: KeybindingConfig
  advanced: PortalAdvancedConfig
}

export interface PortalConfigTransaction {
  readonly config: PortalConfigDocument
  commit(): Promise<void>
  noChange(): void
}

export class PortalConfigError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PortalConfigError'
  }
}

const DEFAULT_LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25
const CONFIG_FIELDS = new Set([
  'browser',
  'projectInstructions',
  'listeners',
  'skills',
  'hooks',
  'keybindings',
  'advanced',
])
const BROWSER_FIELDS = new Set([
  'engine',
  'executablePath',
  'profilePath',
  'remoteDebuggingPort',
])
const LISTENER_FIELDS = new Set(['mcp'])
const LISTENER_SERVER_FIELDS = new Set(['host', 'port', 'token'])
const ADVANCED_FIELDS = new Set([
  'browser',
  'provider',
  'runtime',
  'command',
  'skillInstall',
  'hooks',
])
const ADVANCED_BROWSER_FIELDS = new Set([
  'startupTimeoutSeconds',
  'closeTimeoutSeconds',
])
const ADVANCED_PROVIDER_FIELDS = new Set([
  'requestStartWarningAfterSeconds',
  'blockedWarningEverySeconds',
  'responseStartTimeoutSeconds',
  'responseStallTimeoutSeconds',
  'restoreTimeoutSeconds',
  'historyLoadTimeoutSeconds',
  'historyPageTimeoutSeconds',
])
const ADVANCED_RUNTIME_FIELDS = new Set([
  'initializationAttemptLimit',
  'requestAttemptLimit',
  'spawnDepthLimit',
  'cancelWaitTimeoutSeconds',
  'shutdownCloseTimeoutSeconds',
  'childRuntimeCloseTimeoutSeconds',
])
const ADVANCED_COMMAND_FIELDS = new Set([
  'resultOutputLimitMB',
  'stopGraceSeconds',
  'stopTimeoutSeconds',
])
const ADVANCED_SKILL_INSTALL_FIELDS = new Set([
  'downloadTimeoutSeconds',
  'downloadLimitMB',
  'extractedSizeLimitMB',
  'fileCountLimit',
  'resourceFileCountLimit',
  'manifestSizeLimitKB',
  'redirectLimit',
])
const ADVANCED_HOOKS_FIELDS = new Set(['commandOutputLimitMB'])
const localTails = new Map<string, Promise<void>>()

export function createDefaultPortalConfig(
  dataDirectory: string = path.resolve('data'),
  browser: PortalBrowserConfig = createDefaultBrowserConfig(dataDirectory)
): PortalConfigDocument {
  return {
    browser,
    projectInstructions: false,
    listeners: {
      mcp: {
        host: '127.0.0.1',
        port: 8788,
        token: null,
      },
    },
    skills: {},
    hooks: createDefaultHooksConfig(),
    keybindings: createDefaultKeybindings(),
    advanced: createDefaultAdvancedConfig(),
  }
}

export function createDefaultAdvancedConfig(): PortalAdvancedConfig {
  return {
    browser: {
      startupTimeoutSeconds: 60,
      closeTimeoutSeconds: 3,
    },
    provider: {
      requestStartWarningAfterSeconds: 30,
      blockedWarningEverySeconds: 30,
      responseStartTimeoutSeconds: 30,
      responseStallTimeoutSeconds: 30,
      restoreTimeoutSeconds: 180,
      historyLoadTimeoutSeconds: 60,
      historyPageTimeoutSeconds: 10,
    },
    runtime: {
      initializationAttemptLimit: 3,
      requestAttemptLimit: 3,
      spawnDepthLimit: 5,
      cancelWaitTimeoutSeconds: 3,
      shutdownCloseTimeoutSeconds: 3,
      childRuntimeCloseTimeoutSeconds: 2,
    },
    command: {
      resultOutputLimitMB: 4,
      stopGraceSeconds: 0.25,
      stopTimeoutSeconds: 3,
    },
    skillInstall: {
      downloadTimeoutSeconds: 60,
      downloadLimitMB: 100,
      extractedSizeLimitMB: 500,
      fileCountLimit: 5000,
      resourceFileCountLimit: 2000,
      manifestSizeLimitKB: 512,
      redirectLimit: 5,
    },
    hooks: {
      commandOutputLimitMB: 1,
    },
  }
}

export function createDefaultBrowserConfig(
  dataDirectory: string = path.resolve('data')
): PortalBrowserConfig {
  const engine = 'chromium'
  const candidates = getDefaultBrowserExecutableCandidates()

  return {
    engine,
    executablePath:
      candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!,
    profilePath: path.join(path.resolve(dataDirectory), 'profiles', engine),
    remoteDebuggingPort: 9222,
  }
}

export async function readPortalConfig(
  configPath: string
): Promise<PortalConfigDocument | null> {
  let contents: string
  try {
    contents = await readFile(configPath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null
    }
    throw error
  }

  let document: unknown
  try {
    document = parse(contents.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new PortalConfigError(`Invalid YAML: ${getErrorMessage(error)}`)
  }
  return parsePortalConfig(document)
}

function migrateLegacyConfig(
  document: Record<string, unknown>
): Record<string, unknown> {
  const outboundServers = document.mcpServers
  if (
    outboundServers !== undefined &&
    (!isRecord(outboundServers) || Object.keys(outboundServers).length > 0)
  ) {
    throw new PortalConfigError(
      'Outbound MCP clients are no longer supported. Back up and remove mcpServers before starting Portal.'
    )
  }

  const legacyInstructions = document.agentInstructions
  if (legacyInstructions !== undefined) {
    validateLegacyInstructions(legacyInstructions)
  }

  const migrated = { ...document }
  delete migrated.mcpServers
  delete migrated.agentInstructions
  if (isRecord(document.listeners)) {
    const listeners = { ...document.listeners }
    delete listeners.api
    migrated.listeners = listeners
  }
  if (isRecord(document.advanced)) {
    const advanced = { ...document.advanced }
    delete advanced.api
    delete advanced.instructions
    migrated.advanced = advanced
  }
  return migrated
}

function validateLegacyInstructions(value: unknown): void {
  if (!isRecord(value)) {
    throw new PortalConfigError(
      'Legacy agentInstructions must be removed before starting Portal.'
    )
  }
  const supportedSources = new Set(['claude', 'codex'])
  if (Object.keys(value).some((field) => !supportedSources.has(field))) {
    throw new PortalConfigError(
      'Legacy agentInstructions contains unsupported fields and must be removed before starting Portal.'
    )
  }
  for (const source of supportedSources) {
    const scope = value[source]
    if (scope === undefined) continue
    if (!isRecord(scope)) {
      throw new PortalConfigError(
        'Legacy agentInstructions must contain only boolean global and local fields.'
      )
    }
    if (
      Object.keys(scope).some(
        (field) => field !== 'global' && field !== 'local'
      )
    ) {
      throw new PortalConfigError(
        'Legacy agentInstructions contains unsupported fields and must be removed before starting Portal.'
      )
    }
    for (const field of ['global', 'local']) {
      const enabled = scope[field]
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new PortalConfigError(
          'Legacy agentInstructions must contain only boolean global and local fields.'
        )
      }
      if (enabled === true) {
        throw new PortalConfigError(
          'Legacy project instruction sources were enabled. Remove agentInstructions and set projectInstructions explicitly after reviewing the Portal 2.0 semantics.'
        )
      }
    }
  }
}

export function parsePortalConfig(rawDocument: unknown): PortalConfigDocument {
  if (!isRecord(rawDocument)) {
    throw new PortalConfigError('Config root must be an object')
  }
  const document = migrateLegacyConfig(rawDocument)
  assertSupportedFields(document, CONFIG_FIELDS, 'config root')

  const browser = document.browser
  if (!isRecord(browser)) {
    throw new PortalConfigError('browser must be an object')
  }
  assertSupportedFields(browser, BROWSER_FIELDS, 'browser')
  if (browser.engine !== 'chromium') {
    throw new PortalConfigError('browser.engine must be "chromium"')
  }
  if (
    typeof browser.executablePath !== 'string' ||
    browser.executablePath.trim() === ''
  ) {
    throw new PortalConfigError(
      'browser.executablePath must be a non-empty string'
    )
  }
  if (
    typeof browser.profilePath !== 'string' ||
    browser.profilePath.trim() === ''
  ) {
    throw new PortalConfigError(
      'browser.profilePath must be a non-empty string'
    )
  }
  if (
    !isSafeInteger(browser.remoteDebuggingPort) ||
    browser.remoteDebuggingPort < 0 ||
    browser.remoteDebuggingPort > 65_535
  ) {
    throw new PortalConfigError(
      'browser.remoteDebuggingPort must be an integer from 0 to 65535'
    )
  }

  const projectInstructions = document.projectInstructions ?? false
  if (typeof projectInstructions !== 'boolean') {
    throw new PortalConfigError('projectInstructions must be a boolean')
  }

  const listeners = document.listeners
  if (listeners !== undefined && !isRecord(listeners)) {
    throw new PortalConfigError('listeners must be an object')
  }
  if (listeners !== undefined) {
    assertSupportedFields(listeners, LISTENER_FIELDS, 'listeners')
  }
  const listenersRecord = isRecord(listeners) ? listeners : {}

  const mcpServer = listenersRecord.mcp
  if (mcpServer !== undefined && !isRecord(mcpServer)) {
    throw new PortalConfigError('listeners.mcp must be an object')
  }
  if (mcpServer !== undefined) {
    assertSupportedFields(mcpServer, LISTENER_SERVER_FIELDS, 'listeners.mcp')
  }
  const mcpServerRecord = isRecord(mcpServer) ? mcpServer : {}
  const mcpServerHost = mcpServerRecord.host ?? '127.0.0.1'
  if (typeof mcpServerHost !== 'string' || mcpServerHost === '') {
    throw new PortalConfigError('listeners.mcp.host must be a non-empty string')
  }
  const mcpServerPort = mcpServerRecord.port ?? 8788
  if (
    typeof mcpServerPort !== 'number' ||
    !Number.isSafeInteger(mcpServerPort) ||
    mcpServerPort <= 0 ||
    mcpServerPort > 65_535
  ) {
    throw new PortalConfigError(
      'listeners.mcp.port must be an integer from 1 to 65535'
    )
  }
  const mcpServerToken = mcpServerRecord.token ?? null
  if (mcpServerToken !== null && typeof mcpServerToken !== 'string') {
    throw new PortalConfigError('listeners.mcp.token must be a string or null')
  }

  const skills = document.skills
  if (!isRecord(skills)) {
    throw new PortalConfigError('skills must be an object keyed by name')
  }
  let hooks: HooksConfig
  try {
    hooks = parseHooksConfig(document.hooks)
  } catch (error) {
    if (error instanceof HookConfigError) {
      throw new PortalConfigError(error.message)
    }
    throw error
  }
  let keybindings: KeybindingConfig
  try {
    keybindings = parseKeybindingConfig(document.keybindings)
  } catch (error) {
    if (error instanceof KeybindingConfigError) {
      throw new PortalConfigError(error.message)
    }
    throw error
  }
  const advanced = parseAdvancedConfig(document.advanced)

  return {
    browser: {
      engine: browser.engine,
      executablePath: browser.executablePath,
      profilePath: browser.profilePath,
      remoteDebuggingPort: browser.remoteDebuggingPort,
    },
    projectInstructions,
    listeners: {
      mcp: {
        host: mcpServerHost,
        port: mcpServerPort,
        token: mcpServerToken,
      },
    },
    skills: { ...skills },
    hooks,
    keybindings,
    advanced,
  }
}

export function parseAdvancedConfig(value: unknown): PortalAdvancedConfig {
  const defaults = createDefaultAdvancedConfig()
  const advanced = parseOptionalRecord(value, 'advanced')
  assertSupportedFields(advanced, ADVANCED_FIELDS, 'advanced')
  const browser = parseOptionalRecord(advanced.browser, 'advanced.browser')
  const provider = parseOptionalRecord(advanced.provider, 'advanced.provider')
  const runtime = parseOptionalRecord(advanced.runtime, 'advanced.runtime')
  const command = parseOptionalRecord(advanced.command, 'advanced.command')
  const skillInstall = parseOptionalRecord(
    advanced.skillInstall,
    'advanced.skillInstall'
  )
  const hooks = parseOptionalRecord(advanced.hooks, 'advanced.hooks')

  assertSupportedFields(browser, ADVANCED_BROWSER_FIELDS, 'advanced.browser')
  assertSupportedFields(provider, ADVANCED_PROVIDER_FIELDS, 'advanced.provider')
  assertSupportedFields(runtime, ADVANCED_RUNTIME_FIELDS, 'advanced.runtime')
  assertSupportedFields(command, ADVANCED_COMMAND_FIELDS, 'advanced.command')
  assertSupportedFields(
    skillInstall,
    ADVANCED_SKILL_INSTALL_FIELDS,
    'advanced.skillInstall'
  )
  assertSupportedFields(hooks, ADVANCED_HOOKS_FIELDS, 'advanced.hooks')

  return {
    browser: {
      startupTimeoutSeconds: parsePositiveInteger(
        browser.startupTimeoutSeconds,
        defaults.browser.startupTimeoutSeconds,
        'advanced.browser.startupTimeoutSeconds'
      ),
      closeTimeoutSeconds: parsePositiveInteger(
        browser.closeTimeoutSeconds,
        defaults.browser.closeTimeoutSeconds,
        'advanced.browser.closeTimeoutSeconds'
      ),
    },
    provider: {
      requestStartWarningAfterSeconds: parsePositiveInteger(
        provider.requestStartWarningAfterSeconds,
        defaults.provider.requestStartWarningAfterSeconds,
        'advanced.provider.requestStartWarningAfterSeconds'
      ),
      blockedWarningEverySeconds: parsePositiveInteger(
        provider.blockedWarningEverySeconds,
        defaults.provider.blockedWarningEverySeconds,
        'advanced.provider.blockedWarningEverySeconds'
      ),
      responseStartTimeoutSeconds: parsePositiveInteger(
        provider.responseStartTimeoutSeconds,
        defaults.provider.responseStartTimeoutSeconds,
        'advanced.provider.responseStartTimeoutSeconds'
      ),
      responseStallTimeoutSeconds: parsePositiveInteger(
        provider.responseStallTimeoutSeconds,
        defaults.provider.responseStallTimeoutSeconds,
        'advanced.provider.responseStallTimeoutSeconds'
      ),
      restoreTimeoutSeconds: parsePositiveInteger(
        provider.restoreTimeoutSeconds,
        defaults.provider.restoreTimeoutSeconds,
        'advanced.provider.restoreTimeoutSeconds'
      ),
      historyLoadTimeoutSeconds: parsePositiveInteger(
        provider.historyLoadTimeoutSeconds,
        defaults.provider.historyLoadTimeoutSeconds,
        'advanced.provider.historyLoadTimeoutSeconds'
      ),
      historyPageTimeoutSeconds: parsePositiveInteger(
        provider.historyPageTimeoutSeconds,
        defaults.provider.historyPageTimeoutSeconds,
        'advanced.provider.historyPageTimeoutSeconds'
      ),
    },
    runtime: {
      initializationAttemptLimit: parsePositiveInteger(
        runtime.initializationAttemptLimit,
        defaults.runtime.initializationAttemptLimit,
        'advanced.runtime.initializationAttemptLimit'
      ),
      requestAttemptLimit: parsePositiveInteger(
        runtime.requestAttemptLimit,
        defaults.runtime.requestAttemptLimit,
        'advanced.runtime.requestAttemptLimit'
      ),
      spawnDepthLimit: parseSpawnDepthLimit(
        runtime.spawnDepthLimit,
        defaults.runtime.spawnDepthLimit
      ),
      cancelWaitTimeoutSeconds: parsePositiveInteger(
        runtime.cancelWaitTimeoutSeconds,
        defaults.runtime.cancelWaitTimeoutSeconds,
        'advanced.runtime.cancelWaitTimeoutSeconds'
      ),
      shutdownCloseTimeoutSeconds: parsePositiveInteger(
        runtime.shutdownCloseTimeoutSeconds,
        defaults.runtime.shutdownCloseTimeoutSeconds,
        'advanced.runtime.shutdownCloseTimeoutSeconds'
      ),
      childRuntimeCloseTimeoutSeconds: parsePositiveInteger(
        runtime.childRuntimeCloseTimeoutSeconds,
        defaults.runtime.childRuntimeCloseTimeoutSeconds,
        'advanced.runtime.childRuntimeCloseTimeoutSeconds'
      ),
    },
    command: {
      resultOutputLimitMB: parsePositiveInteger(
        command.resultOutputLimitMB,
        defaults.command.resultOutputLimitMB,
        'advanced.command.resultOutputLimitMB'
      ),
      stopGraceSeconds: parsePositiveNumber(
        command.stopGraceSeconds,
        defaults.command.stopGraceSeconds,
        'advanced.command.stopGraceSeconds'
      ),
      stopTimeoutSeconds: parsePositiveInteger(
        command.stopTimeoutSeconds,
        defaults.command.stopTimeoutSeconds,
        'advanced.command.stopTimeoutSeconds'
      ),
    },
    skillInstall: {
      downloadTimeoutSeconds: parsePositiveInteger(
        skillInstall.downloadTimeoutSeconds,
        defaults.skillInstall.downloadTimeoutSeconds,
        'advanced.skillInstall.downloadTimeoutSeconds'
      ),
      downloadLimitMB: parsePositiveInteger(
        skillInstall.downloadLimitMB,
        defaults.skillInstall.downloadLimitMB,
        'advanced.skillInstall.downloadLimitMB'
      ),
      extractedSizeLimitMB: parsePositiveInteger(
        skillInstall.extractedSizeLimitMB,
        defaults.skillInstall.extractedSizeLimitMB,
        'advanced.skillInstall.extractedSizeLimitMB'
      ),
      fileCountLimit: parsePositiveInteger(
        skillInstall.fileCountLimit,
        defaults.skillInstall.fileCountLimit,
        'advanced.skillInstall.fileCountLimit'
      ),
      resourceFileCountLimit: parsePositiveInteger(
        skillInstall.resourceFileCountLimit,
        defaults.skillInstall.resourceFileCountLimit,
        'advanced.skillInstall.resourceFileCountLimit'
      ),
      manifestSizeLimitKB: parsePositiveInteger(
        skillInstall.manifestSizeLimitKB,
        defaults.skillInstall.manifestSizeLimitKB,
        'advanced.skillInstall.manifestSizeLimitKB'
      ),
      redirectLimit: parsePositiveInteger(
        skillInstall.redirectLimit,
        defaults.skillInstall.redirectLimit,
        'advanced.skillInstall.redirectLimit'
      ),
    },
    hooks: {
      commandOutputLimitMB: parsePositiveInteger(
        hooks.commandOutputLimitMB,
        defaults.hooks.commandOutputLimitMB,
        'advanced.hooks.commandOutputLimitMB'
      ),
    },
  }
}

export async function ensurePortalConfig(
  configPath: string,
  defaults: PortalConfigDocument,
  options: { rewriteWithComments?: boolean } = {}
): Promise<PortalConfigDocument> {
  return await withConfigLock(configPath, async () => {
    const existing = await readPortalConfig(configPath)
    if (existing !== null) {
      if (
        options.rewriteWithComments === true ||
        !(await hasCompleteManagedSections(configPath))
      ) {
        await writePortalConfigUnlocked(configPath, existing, true)
      }
      await ensurePrivateFile(configPath)
      return existing
    }
    await writePortalConfigUnlocked(configPath, defaults, true)
    return defaults
  })
}

async function hasCompleteManagedSections(
  configPath: string
): Promise<boolean> {
  const contents = await readFile(configPath, 'utf8')
  const document: unknown = parse(contents.replace(/^\uFEFF/, ''))
  if (!isRecord(document)) {
    return false
  }
  if (
    Object.hasOwn(document, 'mcpServers') ||
    Object.hasOwn(document, 'agentInstructions') ||
    !Object.hasOwn(document, 'projectInstructions')
  ) {
    return false
  }
  const listeners = document.listeners
  if (!isRecord(listeners)) {
    return false
  }
  const mcp = listeners.mcp
  const hooks = document.hooks
  const keybindings = document.keybindings
  const advanced = document.advanced
  if (
    !isRecord(mcp) ||
    !isRecord(hooks) ||
    !isRecord(keybindings) ||
    !isRecord(advanced)
  ) {
    return false
  }
  if (
    Object.hasOwn(listeners, 'api') ||
    Object.hasOwn(advanced, 'api') ||
    Object.hasOwn(advanced, 'instructions')
  ) {
    return false
  }
  const mcpServerComplete = ['host', 'port', 'token'].every((field) =>
    Object.hasOwn(mcp, field)
  )
  const keybindingsComplete = KEYBINDING_ACTIONS.every((action) =>
    Object.hasOwn(keybindings, action)
  )
  const advancedSections: Array<
    readonly [name: string, fields: ReadonlySet<string>]
  > = [
    ['browser', ADVANCED_BROWSER_FIELDS],
    ['provider', ADVANCED_PROVIDER_FIELDS],
    ['runtime', ADVANCED_RUNTIME_FIELDS],
    ['command', ADVANCED_COMMAND_FIELDS],
    ['skillInstall', ADVANCED_SKILL_INSTALL_FIELDS],
    ['hooks', ADVANCED_HOOKS_FIELDS],
  ]
  const advancedComplete = advancedSections.every(([name, fields]) => {
    const section = advanced[name]
    return (
      isRecord(section) &&
      [...fields].every((field) => Object.hasOwn(section, field))
    )
  })
  return mcpServerComplete && keybindingsComplete && advancedComplete
}

export async function readPortalKeybindings(
  configPath: string
): Promise<KeybindingConfig> {
  let contents: string
  try {
    contents = await readFile(configPath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PortalConfigError(`Portal config does not exist: ${configPath}`)
    }
    throw error
  }

  const document = parseConfigDocument(contents)
  const value: unknown = document.toJS()
  if (!isRecord(value)) {
    throw new PortalConfigError('Config root must be an object')
  }
  try {
    return parseKeybindingConfig(value.keybindings)
  } catch (error) {
    if (error instanceof KeybindingConfigError) {
      throw new PortalConfigError(error.message)
    }
    throw error
  }
}

export async function resetPortalKeybindings(
  configPath: string,
  keybindings: KeybindingConfig
): Promise<KeybindingConfig> {
  return await withConfigLock(configPath, async () => {
    const contents = await readFile(configPath, 'utf8')
    const document = parseConfigDocument(contents)
    if (!isMap(document.contents)) {
      throw new PortalConfigError('Config root must be an object')
    }

    const root = document.contents
    const existingIndex = root.items.findIndex(
      (pair) => isScalar(pair.key) && pair.key.value === 'keybindings'
    )
    if (existingIndex >= 0) {
      root.items.splice(existingIndex, 1)
    }
    const pair = document.createPair('keybindings', keybindings)
    if (isScalar(pair.key)) {
      pair.key.commentBefore =
        ' Terminal input shortcuts. Changes apply automatically.'
      pair.key.spaceBefore = true
    }
    const advancedIndex = root.items.findIndex(
      (item) => isScalar(item.key) && item.key.value === 'advanced'
    )
    if (advancedIndex >= 0) {
      const [advancedPair] = root.items.splice(advancedIndex, 1)
      root.items.push(pair, advancedPair!)
    } else {
      root.items.push(pair)
    }

    const candidate = parsePortalConfig(document.toJS())
    await writePortalConfigContentsUnlocked(configPath, String(document))
    return candidate.keybindings
  })
}

export async function updatePortalConfig(
  configPath: string,
  update: (config: PortalConfigDocument) => void,
  defaults: PortalConfigDocument
): Promise<PortalConfigDocument> {
  return await withPortalConfigTransaction(
    configPath,
    async (transaction) => {
      update(transaction.config)
      await transaction.commit()
      return transaction.config
    },
    defaults
  )
}

export async function withPortalConfigTransaction<T>(
  configPath: string,
  action: (transaction: PortalConfigTransaction) => Promise<T> | T,
  defaults: PortalConfigDocument
): Promise<T> {
  return await withConfigLock(configPath, async () => {
    const config = (await readPortalConfig(configPath)) ?? cloneConfig(defaults)
    let state: 'pending' | 'committed' | 'unchanged' = 'pending'
    let commitPromise: Promise<void> | undefined
    const transaction: PortalConfigTransaction = {
      config,
      async commit() {
        if (state !== 'pending') {
          throw new PortalConfigError(
            'Config transaction has already been completed'
          )
        }
        state = 'committed'
        commitPromise = writePortalConfigUnlocked(configPath, config)
        await commitPromise
      },
      noChange() {
        if (state !== 'pending') {
          throw new PortalConfigError(
            'Config transaction has already been completed'
          )
        }
        state = 'unchanged'
      },
    }

    let result: T
    try {
      result = await action(transaction)
    } catch (error) {
      await commitPromise?.catch(() => {})
      throw error
    }
    if (state === 'pending') {
      throw new PortalConfigError(
        'Config transaction must call commit() or noChange()'
      )
    }
    await commitPromise
    return result
  })
}

async function writePortalConfigUnlocked(
  configPath: string,
  config: PortalConfigDocument,
  includeComments = false
): Promise<void> {
  await writePortalConfigContentsUnlocked(
    configPath,
    includeComments ? stringifyInitialPortalConfig(config) : stringify(config)
  )
}

async function writePortalConfigContentsUnlocked(
  configPath: string,
  contents: string
): Promise<void> {
  const directory = path.dirname(configPath)
  let replacementMode = PRIVATE_FILE_MODE
  if (process.platform !== 'win32') {
    try {
      replacementMode = (await stat(configPath)).mode & 0o700
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`
  )
  await ensurePrivateDirectory(directory)
  try {
    await writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    if (process.platform !== 'win32') {
      await chmod(temporaryPath, replacementMode)
    }
    await rename(temporaryPath, configPath)
    await ensurePrivateFile(configPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lock = await resolveConfigLock(configPath)
  const previous = localTails.get(lock.key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  localTails.set(lock.key, current)
  await previous

  try {
    return await withFileLock(lock.path, configPath, action)
  } finally {
    release()
    if (localTails.get(lock.key) === current) {
      localTails.delete(lock.key)
    }
  }
}

async function resolveConfigLock(
  configPath: string
): Promise<{ path: string; key: string }> {
  const configDirectory = path.dirname(path.resolve(configPath))
  await ensurePrivateDirectory(configDirectory)
  if (existsSync(configPath)) {
    await ensurePrivateFile(configPath)
  }
  const lockDirectory = path.join(configDirectory, '.locks')
  await ensurePrivateDirectory(lockDirectory)
  const resolvedDirectory = await realpath(lockDirectory)
  const lockPath = path.join(resolvedDirectory, 'config.lock')
  return {
    path: lockPath,
    key: process.platform === 'win32' ? lockPath.toLowerCase() : lockPath,
  }
}

async function withFileLock<T>(
  lockPath: string,
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockFile = await open(lockPath, 'a+', PRIVATE_FILE_MODE)
  const deadline = Date.now() + DEFAULT_LOCK_WAIT_MS
  let acquired = false
  let result: T
  const cleanupErrors: unknown[] = []

  try {
    await ensurePrivateFile(lockPath)
    while (!tryLock(lockFile.fd)) {
      if (Date.now() >= deadline) {
        throw new PortalConfigError(
          `Timed out waiting for config lock: ${configPath}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
    acquired = true
    result = await action()
  } finally {
    if (acquired) {
      try {
        unlock(lockFile.fd)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await lockFile.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length === 1) {
    throw toError(cleanupErrors[0])
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Failed to release config lock')
  }
  return result
}

function cloneConfig(config: PortalConfigDocument): PortalConfigDocument {
  return {
    browser: { ...config.browser },
    projectInstructions: config.projectInstructions,
    listeners: {
      mcp: { ...config.listeners.mcp },
    },
    skills: structuredClone(config.skills),
    hooks: structuredClone(config.hooks),
    keybindings: structuredClone(config.keybindings),
    advanced: structuredClone(config.advanced),
  }
}

function stringifyInitialPortalConfig(config: PortalConfigDocument): string {
  const document = new Document(config)
  commentMap(
    document,
    [],
    [
      ['browser', 'Browser launch and profile settings.'],
      ['projectInstructions', 'Load AGENTS.md from the startup directory.'],
      ['listeners', 'Inbound network listeners exposed by Portal.'],
      ['skills', 'Registered Skill directories and enabled states.'],
      ['hooks', 'Lifecycle hook handlers and execution policy.'],
      ['keybindings', 'Terminal input shortcuts. Changes apply automatically.'],
      ['advanced', 'Low-frequency runtime tuning and resource limits.'],
    ],
    true
  )
  commentMap(
    document,
    ['browser'],
    [
      ['engine', 'Browser automation engine. Currently only chromium.'],
      ['executablePath', 'Path to the browser executable.'],
      ['profilePath', 'Directory that stores the dedicated browser profile.'],
      [
        'remoteDebuggingPort',
        'Local CDP port used to control the browser. Use 0 for a dynamic port.',
      ],
    ]
  )
  commentMap(
    document,
    ['listeners'],
    [['mcp', 'Portal MCP Server listener and authentication settings.']]
  )
  commentMap(
    document,
    ['listeners', 'mcp'],
    [
      ['host', 'Network interface used by the Portal MCP Server.'],
      ['port', 'TCP port used by the Portal MCP Server.'],
      [
        'token',
        'Bearer token used by the MCP Server; null or empty is allowed only on 127.0.0.1.',
      ],
    ]
  )
  commentMap(
    document,
    ['hooks'],
    [
      ['enabled', 'Enable or disable all configured hooks.'],
      ['maxDepth', 'Maximum nested hook dispatch depth.'],
      ['handlers', 'Hook handlers evaluated for lifecycle events.'],
    ]
  )
  commentMap(
    document,
    ['keybindings'],
    KEYBINDING_ACTIONS.map((action) => [action, `Shortcuts for ${action}.`])
  )
  commentMap(
    document,
    ['advanced'],
    [
      ['browser', 'Browser startup and shutdown timing.'],
      ['provider', 'Web provider response and history timing.'],
      ['runtime', 'Runtime retry, cancellation, and shutdown behavior.'],
      ['command', 'Local command output and process termination limits.'],
      ['skillInstall', 'Skill download, extraction, and file limits.'],
      ['hooks', 'Hook command resource limits.'],
    ],
    true
  )
  commentMap(
    document,
    ['advanced', 'browser'],
    [
      [
        'startupTimeoutSeconds',
        'Seconds allowed for browser startup and CDP connection.',
      ],
      [
        'closeTimeoutSeconds',
        'Seconds allowed for the browser to close cleanly.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'provider'],
    [
      [
        'requestStartWarningAfterSeconds',
        'Seconds before warning that a submitted request has not started.',
      ],
      [
        'blockedWarningEverySeconds',
        'Seconds between repeated blocked-request warnings.',
      ],
      [
        'responseStartTimeoutSeconds',
        'Seconds allowed for the first provider response activity after submit.',
      ],
      [
        'responseStallTimeoutSeconds',
        'Seconds allowed between provider response activities before the request fails.',
      ],
      [
        'restoreTimeoutSeconds',
        'Seconds allowed for a provider page to become ready.',
      ],
      [
        'historyLoadTimeoutSeconds',
        'Seconds allowed to load all available conversation history.',
      ],
      [
        'historyPageTimeoutSeconds',
        'Seconds allowed to load one history page.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'runtime'],
    [
      [
        'initializationAttemptLimit',
        'Maximum attempts to initialize a provider runtime.',
      ],
      [
        'requestAttemptLimit',
        'Maximum attempts for one retryable provider request.',
      ],
      [
        'spawnDepthLimit',
        'Maximum child spawn depth; 0 disables spawn and the root depth is 0.',
      ],
      [
        'cancelWaitTimeoutSeconds',
        'Seconds to wait for a cancelled thread operation to settle.',
      ],
      [
        'shutdownCloseTimeoutSeconds',
        'Seconds to wait for each resource during portal shutdown.',
      ],
      [
        'childRuntimeCloseTimeoutSeconds',
        'Seconds to wait for a hook child runtime to close.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'command'],
    [
      [
        'resultOutputLimitMB',
        'Maximum combined stdout and stderr retained per command, in MB.',
      ],
      [
        'stopGraceSeconds',
        'Seconds allowed for POSIX graceful process-tree termination before force kill; Windows uses Job/taskkill termination.',
      ],
      [
        'stopTimeoutSeconds',
        'Seconds to wait for a stopped command job to settle.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'skillInstall'],
    [
      [
        'downloadTimeoutSeconds',
        'Seconds allowed for one Skill download operation.',
      ],
      ['downloadLimitMB', 'Maximum downloaded Skill size, in MB.'],
      ['extractedSizeLimitMB', 'Maximum extracted Skill size, in MB.'],
      ['fileCountLimit', 'Maximum number of files in one installed Skill.'],
      [
        'resourceFileCountLimit',
        'Maximum resource files exposed by one Skill.',
      ],
      ['manifestSizeLimitKB', 'Maximum SKILL.md file size, in KB.'],
      [
        'redirectLimit',
        'Maximum HTTP redirects followed during a Skill download.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'hooks'],
    [
      [
        'commandOutputLimitMB',
        'Maximum output retained from one command hook, in MB.',
      ],
    ]
  )
  return String(document)
}

function commentMap(
  document: Document,
  path: readonly string[],
  comments: readonly (readonly [key: string, comment: string])[],
  addSpacing = false
): void {
  const node =
    path.length === 0 ? document.contents : document.getIn(path, true)
  if (!isMap(node)) {
    throw new PortalConfigError(
      `Cannot annotate config path: ${path.join('.')}`
    )
  }
  const commentByKey = new Map(comments)
  let matched = 0
  for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      continue
    }
    const comment = commentByKey.get(pair.key.value)
    if (comment === undefined) {
      continue
    }
    pair.key.commentBefore = ` ${comment}`
    pair.key.spaceBefore = addSpacing && matched > 0
    matched += 1
  }
}

function parseOptionalRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    throw new PortalConfigError(`${label} must be an object`)
  }
  return value
}

function parseConfigDocument(contents: string): Document {
  const document = parseDocument(contents.replace(/^\uFEFF/, ''))
  if (document.errors.length > 0) {
    throw new PortalConfigError(
      `Invalid YAML: ${document.errors.map((error) => error.message).join('; ')}`
    )
  }
  return document
}

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  label: string
): number {
  const parsed = value === undefined ? fallback : value
  if (!isSafeInteger(parsed) || parsed <= 0) {
    throw new PortalConfigError(`${label} must be a positive integer`)
  }
  return parsed
}

function parseSpawnDepthLimit(value: unknown, fallback: number): number {
  const parsed = value === undefined ? fallback : value
  if (!isSafeInteger(parsed) || parsed < 0 || parsed > 32) {
    throw new PortalConfigError(
      'advanced.runtime.spawnDepthLimit must be an integer from 0 to 32'
    )
  }
  return parsed
}

function parsePositiveNumber(
  value: unknown,
  fallback: number,
  label: string
): number {
  const parsed = value === undefined ? fallback : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new PortalConfigError(`${label} must be a positive number`)
  }
  return parsed
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error), { cause: error })
}

function assertSupportedFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  label: string
): void {
  const unsupported = Object.keys(value).filter(
    (field) => !supported.has(field)
  )
  if (unsupported.length > 0) {
    throw new PortalConfigError(
      `Unsupported ${label} fields: ${unsupported.join(', ')}`
    )
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
