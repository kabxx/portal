import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Document, isMap, isScalar, parse, stringify } from 'yaml'
import {
  createDefaultHooksConfig,
  HookConfigError,
  parseHooksConfig,
} from '../hooks/hook-config.ts'
import type { HooksConfig } from '../hooks/hook-types.ts'

export interface PortalBrowserConfig {
  name: string
  executablePath: string
  profilePath: string
  remoteDebuggingPort: number
}

export interface PortalInstructionScopeConfig {
  global: boolean
  local: boolean
}

export interface PortalAgentInstructionsConfig {
  claude: PortalInstructionScopeConfig
  codex: PortalInstructionScopeConfig
}

export interface PortalApiConfig {
  host: string
  port: number
  token: string | null
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

export interface PortalAdvancedApiConfig {
  requestBodyLimitKB: number
  requestTimeoutSeconds: number
  sseHeartbeatSeconds: number
}

export interface PortalAdvancedInstructionsConfig {
  codexSizeLimitKB: number
  claudeSizeLimitKB: number
  fileCountLimit: number
  importDepthLimit: number
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
  api: PortalAdvancedApiConfig
  instructions: PortalAdvancedInstructionsConfig
  hooks: PortalAdvancedHooksConfig
}

export interface PortalConfigDocument {
  browser: PortalBrowserConfig
  agentInstructions: PortalAgentInstructionsConfig
  api: PortalApiConfig
  mcp: Record<string, unknown>
  skills: unknown[]
  hooks: HooksConfig
  advanced: PortalAdvancedConfig
}

export class PortalConfigError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PortalConfigError'
  }
}

const DEFAULT_LOCK_STALE_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 5_000
const CONFIG_FIELDS = new Set([
  'browser',
  'agentInstructions',
  'api',
  'mcp',
  'skills',
  'hooks',
  'advanced',
])
const BROWSER_FIELDS = new Set([
  'name',
  'executablePath',
  'profilePath',
  'remoteDebuggingPort',
])
const AGENT_INSTRUCTIONS_FIELDS = new Set(['claude', 'codex'])
const INSTRUCTION_SCOPE_FIELDS = new Set(['global', 'local'])
const API_FIELDS = new Set(['host', 'port', 'token'])
const ADVANCED_FIELDS = new Set([
  'browser',
  'provider',
  'runtime',
  'command',
  'skillInstall',
  'api',
  'instructions',
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
  'responseTimeoutMinutes',
  'restoreTimeoutSeconds',
  'historyLoadTimeoutSeconds',
  'historyPageTimeoutSeconds',
])
const ADVANCED_PROVIDER_MANAGED_FIELDS = new Set([
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
const ADVANCED_API_FIELDS = new Set([
  'requestBodyLimitKB',
  'requestTimeoutSeconds',
  'sseHeartbeatSeconds',
])
const ADVANCED_INSTRUCTIONS_FIELDS = new Set([
  'codexSizeLimitKB',
  'claudeSizeLimitKB',
  'fileCountLimit',
  'importDepthLimit',
])
const ADVANCED_HOOKS_FIELDS = new Set(['commandOutputLimitMB'])
const localTails = new Map<string, Promise<void>>()

export function createDefaultPortalConfig(
  dataDirectory: string = path.resolve('data'),
  browser: PortalBrowserConfig = createDefaultBrowserConfig(dataDirectory)
): PortalConfigDocument {
  return {
    browser,
    agentInstructions: {
      claude: createDefaultInstructionScope(),
      codex: createDefaultInstructionScope(),
    },
    api: {
      host: '127.0.0.1',
      port: 8787,
      token: null,
    },
    mcp: {
      connectionStrategy: 'per-thread',
      servers: {},
    },
    skills: [],
    hooks: createDefaultHooksConfig(),
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
      restoreTimeoutSeconds: 60,
      historyLoadTimeoutSeconds: 60,
      historyPageTimeoutSeconds: 10,
    },
    runtime: {
      initializationAttemptLimit: 3,
      requestAttemptLimit: 3,
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
    api: {
      requestBodyLimitKB: 256,
      requestTimeoutSeconds: 0,
      sseHeartbeatSeconds: 15,
    },
    instructions: {
      codexSizeLimitKB: 32,
      claudeSizeLimitKB: 96,
      fileCountLimit: 128,
      importDepthLimit: 4,
    },
    hooks: {
      commandOutputLimitMB: 1,
    },
  }
}

export function createDefaultBrowserConfig(
  dataDirectory: string = path.resolve('data')
): PortalBrowserConfig {
  const name = 'edge'
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          path.join(
            path.resolve(
              process.env.LOCALAPPDATA ?? 'C:\\Users\\Default\\AppData\\Local'
            ),
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe'
          ),
        ]
      : [
          '/usr/bin/microsoft-edge',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
        ]

  return {
    name,
    executablePath:
      candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!,
    profilePath: path.join(path.resolve(dataDirectory), 'profiles', name),
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

export function parsePortalConfig(document: unknown): PortalConfigDocument {
  if (!isRecord(document)) {
    throw new PortalConfigError('Config root must be an object')
  }
  assertSupportedFields(document, CONFIG_FIELDS, 'config root')

  const browser = document.browser
  if (!isRecord(browser)) {
    throw new PortalConfigError('browser must be an object')
  }
  assertSupportedFields(browser, BROWSER_FIELDS, 'browser')
  if (typeof browser.name !== 'string' || browser.name.trim() === '') {
    throw new PortalConfigError('browser.name must be a non-empty string')
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
    !Number.isSafeInteger(browser.remoteDebuggingPort) ||
    (browser.remoteDebuggingPort as number) <= 0 ||
    (browser.remoteDebuggingPort as number) > 65_535
  ) {
    throw new PortalConfigError(
      'browser.remoteDebuggingPort must be an integer from 1 to 65535'
    )
  }

  const agentInstructions = document.agentInstructions
  const agentInstructionsLabel = 'agentInstructions'
  if (agentInstructions !== undefined && !isRecord(agentInstructions)) {
    throw new PortalConfigError(`${agentInstructionsLabel} must be an object`)
  }
  if (agentInstructions !== undefined) {
    assertSupportedFields(
      agentInstructions,
      AGENT_INSTRUCTIONS_FIELDS,
      agentInstructionsLabel
    )
  }
  const claude = parseInstructionScope(
    agentInstructions?.claude,
    `${agentInstructionsLabel}.claude`
  )
  const codex = parseInstructionScope(
    agentInstructions?.codex,
    `${agentInstructionsLabel}.codex`
  )

  const api = document.api
  if (api !== undefined && !isRecord(api)) {
    throw new PortalConfigError('api must be an object')
  }
  if (api !== undefined) {
    assertSupportedFields(api, API_FIELDS, 'api')
  }
  const apiRecord = isRecord(api) ? api : {}
  const host = apiRecord.host ?? '127.0.0.1'
  if (typeof host !== 'string' || host.trim() === '') {
    throw new PortalConfigError('api.host must be a non-empty string')
  }
  const port = apiRecord.port ?? 8787
  if (
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535
  ) {
    throw new PortalConfigError('api.port must be an integer from 1 to 65535')
  }
  const token = apiRecord.token ?? null
  if (token !== null && typeof token !== 'string') {
    throw new PortalConfigError('api.token must be a string or null')
  }

  const mcp = document.mcp
  if (!isRecord(mcp)) {
    throw new PortalConfigError('mcp must be an object')
  }
  const skills = document.skills
  if (!Array.isArray(skills)) {
    throw new PortalConfigError('skills must be an array')
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
  const advanced = parseAdvancedConfig(document.advanced)

  return {
    browser: {
      name: browser.name,
      executablePath: browser.executablePath,
      profilePath: browser.profilePath,
      remoteDebuggingPort: browser.remoteDebuggingPort as number,
    },
    agentInstructions: { claude, codex },
    api: { host, port, token },
    mcp: { ...mcp },
    skills: [...skills],
    hooks,
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
  const api = parseOptionalRecord(advanced.api, 'advanced.api')
  const instructions = parseOptionalRecord(
    advanced.instructions,
    'advanced.instructions'
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
  assertSupportedFields(api, ADVANCED_API_FIELDS, 'advanced.api')
  assertSupportedFields(
    instructions,
    ADVANCED_INSTRUCTIONS_FIELDS,
    'advanced.instructions'
  )
  assertSupportedFields(hooks, ADVANCED_HOOKS_FIELDS, 'advanced.hooks')

  const legacyResponseTimeoutMinutes =
    provider.responseTimeoutMinutes === undefined
      ? null
      : parsePositiveInteger(
          provider.responseTimeoutMinutes,
          5,
          'advanced.provider.responseTimeoutMinutes'
        )
  const legacyResponseTimeoutSeconds =
    legacyResponseTimeoutMinutes === null || legacyResponseTimeoutMinutes === 5
      ? 30
      : legacyResponseTimeoutMinutes * 60

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
        legacyResponseTimeoutSeconds,
        'advanced.provider.responseStartTimeoutSeconds'
      ),
      responseStallTimeoutSeconds: parsePositiveInteger(
        provider.responseStallTimeoutSeconds,
        legacyResponseTimeoutSeconds,
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
    api: {
      requestBodyLimitKB: parsePositiveInteger(
        api.requestBodyLimitKB,
        defaults.api.requestBodyLimitKB,
        'advanced.api.requestBodyLimitKB'
      ),
      requestTimeoutSeconds: parseNonNegativeInteger(
        api.requestTimeoutSeconds,
        defaults.api.requestTimeoutSeconds,
        'advanced.api.requestTimeoutSeconds'
      ),
      sseHeartbeatSeconds: parsePositiveInteger(
        api.sseHeartbeatSeconds,
        defaults.api.sseHeartbeatSeconds,
        'advanced.api.sseHeartbeatSeconds'
      ),
    },
    instructions: {
      codexSizeLimitKB: parsePositiveInteger(
        instructions.codexSizeLimitKB,
        defaults.instructions.codexSizeLimitKB,
        'advanced.instructions.codexSizeLimitKB'
      ),
      claudeSizeLimitKB: parsePositiveInteger(
        instructions.claudeSizeLimitKB,
        defaults.instructions.claudeSizeLimitKB,
        'advanced.instructions.claudeSizeLimitKB'
      ),
      fileCountLimit: parsePositiveInteger(
        instructions.fileCountLimit,
        defaults.instructions.fileCountLimit,
        'advanced.instructions.fileCountLimit'
      ),
      importDepthLimit: parsePositiveInteger(
        instructions.importDepthLimit,
        defaults.instructions.importDepthLimit,
        'advanced.instructions.importDepthLimit'
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
  if (
    !isRecord(document) ||
    !isRecord(document.api) ||
    !isRecord(document.hooks) ||
    !isRecord(document.advanced)
  ) {
    return false
  }
  const apiComplete = ['host', 'port', 'token'].every((field) =>
    Object.hasOwn(document.api as Record<string, unknown>, field)
  )
  const advancedSections: Array<
    readonly [name: string, fields: ReadonlySet<string>]
  > = [
    ['browser', ADVANCED_BROWSER_FIELDS],
    ['provider', ADVANCED_PROVIDER_MANAGED_FIELDS],
    ['runtime', ADVANCED_RUNTIME_FIELDS],
    ['command', ADVANCED_COMMAND_FIELDS],
    ['skillInstall', ADVANCED_SKILL_INSTALL_FIELDS],
    ['api', ADVANCED_API_FIELDS],
    ['instructions', ADVANCED_INSTRUCTIONS_FIELDS],
    ['hooks', ADVANCED_HOOKS_FIELDS],
  ]
  const advancedComplete = advancedSections.every(([name, fields]) => {
    const section = (document.advanced as Record<string, unknown>)[name]
    return (
      isRecord(section) &&
      !(
        name === 'provider' && Object.hasOwn(section, 'responseTimeoutMinutes')
      ) &&
      [...fields].every((field) => Object.hasOwn(section, field))
    )
  })
  return apiComplete && advancedComplete
}

export async function updatePortalConfig(
  configPath: string,
  update: (config: PortalConfigDocument) => void,
  defaults: PortalConfigDocument
): Promise<PortalConfigDocument> {
  return await withConfigLock(configPath, async () => {
    const current =
      (await readPortalConfig(configPath)) ?? cloneConfig(defaults)
    update(current)
    await writePortalConfigUnlocked(configPath, current)
    return current
  })
}

async function writePortalConfigUnlocked(
  configPath: string,
  config: PortalConfigDocument,
  includeComments = false
): Promise<void> {
  const directory = path.dirname(configPath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`
  )
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(
      temporaryPath,
      includeComments
        ? stringifyInitialPortalConfig(config)
        : stringify(config),
      {
        encoding: 'utf8',
        flag: 'wx',
      }
    )
    await rename(temporaryPath, configPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = localTails.get(configPath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  localTails.set(configPath, current)
  await previous

  try {
    return await withFileLock(configPath, action)
  } finally {
    release()
    if (localTails.get(configPath) === current) {
      localTails.delete(configPath)
    }
  }
}

async function withFileLock<T>(
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  await mkdir(path.dirname(configPath), { recursive: true })
  const lockPath = `${configPath}.lock`
  const deadline = Date.now() + DEFAULT_LOCK_WAIT_MS

  while (true) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error
      }
      try {
        const details = await stat(lockPath)
        if (Date.now() - details.mtimeMs > DEFAULT_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if (isNodeError(statError) && statError.code === 'ENOENT') {
          continue
        }
        throw statError
      }
      if (Date.now() >= deadline) {
        throw new PortalConfigError(
          `Timed out waiting for config lock: ${configPath}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  try {
    return await action()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

function cloneConfig(config: PortalConfigDocument): PortalConfigDocument {
  return {
    browser: { ...config.browser },
    agentInstructions: {
      claude: { ...config.agentInstructions.claude },
      codex: { ...config.agentInstructions.codex },
    },
    api: { ...config.api },
    mcp: structuredClone(config.mcp),
    skills: structuredClone(config.skills),
    hooks: structuredClone(config.hooks),
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
      [
        'agentInstructions',
        'Project instruction sources loaded into runtimes.',
      ],
      ['api', 'Local HTTP API listener and authentication settings.'],
      ['mcp', 'Model Context Protocol server configuration.'],
      ['skills', 'Registered Skill directories and enabled states.'],
      ['hooks', 'Lifecycle hook handlers and execution policy.'],
      ['advanced', 'Low-frequency runtime tuning and resource limits.'],
    ],
    true
  )
  commentMap(
    document,
    ['browser'],
    [
      ['name', 'Chromium-based browser type to launch.'],
      ['executablePath', 'Path to the browser executable.'],
      ['profilePath', 'Directory that stores the dedicated browser profile.'],
      ['remoteDebuggingPort', 'Local CDP port used to control the browser.'],
    ]
  )
  commentMap(
    document,
    ['agentInstructions'],
    [
      ['claude', 'Enable global or project-local Claude instruction files.'],
      ['codex', 'Enable global or project-local Codex instruction files.'],
    ]
  )
  for (const source of ['claude', 'codex']) {
    commentMap(
      document,
      ['agentInstructions', source],
      [
        ['global', 'Load the user-level instruction file when available.'],
        ['local', 'Load instruction files from the current project.'],
      ]
    )
  }
  commentMap(
    document,
    ['api'],
    [
      ['host', 'Network interface used by the local HTTP API.'],
      ['port', 'TCP port used by the local HTTP API.'],
      ['token', 'Bearer token required by the API, or null to disable it.'],
    ]
  )
  commentMap(
    document,
    ['mcp'],
    [
      ['connectionStrategy', 'How MCP connections are scoped across threads.'],
      ['servers', 'MCP servers keyed by their unique local names.'],
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
    ['advanced'],
    [
      ['browser', 'Browser startup and shutdown timing.'],
      ['provider', 'Web provider response and history timing.'],
      ['runtime', 'Runtime retry, cancellation, and shutdown behavior.'],
      ['command', 'Local command output and process termination limits.'],
      ['skillInstall', 'Skill download, extraction, and file limits.'],
      ['api', 'HTTP API request and event-stream limits.'],
      ['instructions', 'Project instruction loading limits.'],
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
    ['advanced', 'api'],
    [
      ['requestBodyLimitKB', 'Maximum HTTP API request body size, in KB.'],
      [
        'requestTimeoutSeconds',
        'HTTP request timeout in seconds; 0 disables the timeout.',
      ],
      [
        'sseHeartbeatSeconds',
        'Seconds between HTTP event-stream heartbeat messages.',
      ],
    ]
  )
  commentMap(
    document,
    ['advanced', 'instructions'],
    [
      [
        'codexSizeLimitKB',
        'Maximum Codex instruction bytes loaded, expressed in KB.',
      ],
      [
        'claudeSizeLimitKB',
        'Maximum Claude instruction bytes loaded, expressed in KB.',
      ],
      ['fileCountLimit', 'Maximum instruction files scanned for one project.'],
      [
        'importDepthLimit',
        'Maximum nested depth for imported instruction files.',
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

function createDefaultInstructionScope(): PortalInstructionScopeConfig {
  return { global: false, local: true }
}

function parseInstructionScope(
  value: unknown,
  label: string
): PortalInstructionScopeConfig {
  if (value === undefined) {
    return createDefaultInstructionScope()
  }
  if (!isRecord(value)) {
    throw new PortalConfigError(`${label} must be an object`)
  }
  assertSupportedFields(value, INSTRUCTION_SCOPE_FIELDS, label)

  const global = value.global
  const local = value.local
  if (global !== undefined && typeof global !== 'boolean') {
    throw new PortalConfigError(`${label}.global must be a boolean`)
  }
  if (local !== undefined && typeof local !== 'boolean') {
    throw new PortalConfigError(`${label}.local must be a boolean`)
  }
  return {
    global: global === undefined ? false : global,
    local: local === undefined ? true : local,
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

function parsePositiveInteger(
  value: unknown,
  fallback: number,
  label: string
): number {
  const parsed = value === undefined ? fallback : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) {
    throw new PortalConfigError(`${label} must be a positive integer`)
  }
  return parsed as number
}

function parseNonNegativeInteger(
  value: unknown,
  fallback: number,
  label: string
): number {
  const parsed = value === undefined ? fallback : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new PortalConfigError(`${label} must be a non-negative integer`)
  }
  return parsed as number
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
