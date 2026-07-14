import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'

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

export interface PortalConfigDocument {
  browser: PortalBrowserConfig
  agentInstructions: PortalAgentInstructionsConfig
  api: PortalApiConfig
  mcp: Record<string, unknown>
  skills: unknown[]
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
  }
}

export async function ensurePortalConfig(
  configPath: string,
  defaults: PortalConfigDocument
): Promise<PortalConfigDocument> {
  return await withConfigLock(configPath, async () => {
    const existing = await readPortalConfig(configPath)
    if (existing !== null) {
      if (!(await hasCompleteApiSection(configPath))) {
        await writePortalConfigUnlocked(configPath, existing)
      }
      return existing
    }
    await writePortalConfigUnlocked(configPath, defaults)
    return defaults
  })
}

async function hasCompleteApiSection(configPath: string): Promise<boolean> {
  const contents = await readFile(configPath, 'utf8')
  const document: unknown = parse(contents.replace(/^\uFEFF/, ''))
  if (!isRecord(document) || !isRecord(document.api)) {
    return false
  }
  return ['host', 'port', 'token'].every((field) =>
    Object.hasOwn(document.api as Record<string, unknown>, field)
  )
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
  config: PortalConfigDocument
): Promise<void> {
  const directory = path.dirname(configPath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`
  )
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temporaryPath, stringify(config), {
      encoding: 'utf8',
      flag: 'wx',
    })
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
