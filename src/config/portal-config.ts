import { randomUUID } from 'node:crypto'
import { constants, existsSync, type Stats } from 'node:fs'
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { tryLock, unlock } from 'fs-native-extensions'
import { Document, isMap, parseDocument } from 'yaml'

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
  type KeybindingAction,
  type KeybindingConfig,
} from '../keybindings/keybinding-config.ts'
import { getDefaultBrowserExecutableCandidates } from '../platform/platform-defaults.ts'
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PRIVATE_FILE_MODE,
} from '../shared/private-files.ts'

export interface PortalBrowserConfig {
  engine: 'chromium'
  executablePath: string
  profilePath: string
  remoteDebuggingPort: 0
}

export interface PortalMcpServerConfig {
  host: string
  port: number
}

export interface PortalConfigDocument {
  browser: PortalBrowserConfig
  projectInstructions: boolean
  mcp: PortalMcpServerConfig
  hooks: HooksConfig
  keybindings: KeybindingConfig
}

export interface PortalConfigTransaction {
  readonly config: PortalConfigDocument
  commit(): Promise<void>
  noChange(): void
}

export class PortalConfigError extends Error {
  public constructor(message: string, configPath?: string) {
    super(
      configPath === undefined
        ? message
        : `${message}\nConfig: ${path.resolve(configPath)}\nDocumentation: https://github.com/kabxx/portal/blob/main/docs/user/configuration.md`
    )
    this.name = 'PortalConfigError'
  }
}

const DEFAULT_LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25
const CONFIG_FIELDS = new Set([
  'browser',
  'projectInstructions',
  'mcp',
  'hooks',
  'keybindings',
])
const BROWSER_FIELDS = new Set(['executablePath'])
const MCP_FIELDS = new Set(['host', 'port'])
const localTails = new Map<string, Promise<void>>()

export function createDefaultPortalConfig(
  dataDirectory: string = path.resolve('data')
): PortalConfigDocument {
  const candidates = getDefaultBrowserExecutableCandidates()
  return {
    browser: {
      engine: 'chromium',
      executablePath:
        candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!,
      profilePath: path.join(
        path.resolve(dataDirectory),
        'profiles',
        'chromium'
      ),
      remoteDebuggingPort: 0,
    },
    projectInstructions: false,
    mcp: { host: '127.0.0.1', port: 8788 },
    hooks: createDefaultHooksConfig(),
    keybindings: createDefaultKeybindings(),
  }
}

export async function readPortalConfig(
  configPath: string
): Promise<PortalConfigDocument | null> {
  const contents = await readRegularTextFile(configPath, 'Config')
  if (contents === null) return null
  try {
    const document = parseConfigDocument(contents)
    return parsePortalConfig(
      document.toJS(),
      createDefaultPortalConfig(path.dirname(configPath))
    )
  } catch (error) {
    throw withConfigContext(error, configPath)
  }
}

export function parsePortalConfig(
  rawDocument: unknown,
  defaults: PortalConfigDocument = createDefaultPortalConfig()
): PortalConfigDocument {
  if (!isRecord(rawDocument)) {
    throw new PortalConfigError('Config root must be an object')
  }
  assertSupportedFields(rawDocument, CONFIG_FIELDS, 'config root')
  const browser = parseOptionalRecord(rawDocument.browser, 'browser')
  assertSupportedFields(browser, BROWSER_FIELDS, 'browser')
  const executablePath =
    browser.executablePath ?? defaults.browser.executablePath
  if (typeof executablePath !== 'string' || executablePath.trim() === '') {
    throw new PortalConfigError(
      'browser.executablePath must be a non-empty string'
    )
  }

  const projectInstructions = rawDocument.projectInstructions ?? false
  if (typeof projectInstructions !== 'boolean') {
    throw new PortalConfigError('projectInstructions must be a boolean')
  }

  const mcp = parseOptionalRecord(rawDocument.mcp, 'mcp')
  assertSupportedFields(mcp, MCP_FIELDS, 'mcp')
  const host = mcp.host ?? defaults.mcp.host
  if (typeof host !== 'string' || host.trim() === '') {
    throw new PortalConfigError('mcp.host must be a non-empty string')
  }
  const port = mcp.port ?? defaults.mcp.port
  if (!isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new PortalConfigError('mcp.port must be an integer from 1 to 65535')
  }

  let hooks: HooksConfig
  try {
    hooks = parseHooksConfig(rawDocument.hooks)
  } catch (error) {
    if (error instanceof HookConfigError) {
      throw new PortalConfigError(error.message)
    }
    throw error
  }
  let keybindings: KeybindingConfig
  try {
    keybindings = parseKeybindingConfig(rawDocument.keybindings)
  } catch (error) {
    if (error instanceof KeybindingConfigError) {
      throw new PortalConfigError(error.message)
    }
    throw error
  }
  return {
    browser: { ...defaults.browser, executablePath },
    projectInstructions,
    mcp: { host, port },
    hooks,
    keybindings,
  }
}

export async function ensurePortalConfig(
  configPath: string,
  defaults: PortalConfigDocument = createDefaultPortalConfig(
    path.dirname(configPath)
  )
): Promise<PortalConfigDocument> {
  try {
    return await withConfigLock(configPath, async () => {
      const contents = await readRegularTextFile(configPath, 'Config')
      if (contents === null) return cloneConfig(defaults)
      const document = parseConfigDocument(contents)
      const raw: unknown = document.toJS()
      if (!isRecord(raw))
        throw new PortalConfigError('Config root must be an object')
      const config = parsePortalConfig(raw, defaults)
      await ensurePrivateFile(configPath)
      return config
    })
  } catch (error) {
    throw withConfigContext(error, configPath)
  }
}

export async function readPortalKeybindings(
  configPath: string
): Promise<KeybindingConfig> {
  return (
    (await readPortalConfig(configPath)) ??
    createDefaultPortalConfig(path.dirname(configPath))
  ).keybindings
}

export async function resetPortalKeybindings(
  configPath: string,
  keybindings: KeybindingConfig
): Promise<KeybindingConfig> {
  try {
    return await withConfigLock(configPath, async () => {
      const defaults = createDefaultPortalConfig(path.dirname(configPath))
      const document = await readConfigDocumentOrEmpty(configPath)
      if (!isMap(document.contents)) {
        throw new PortalConfigError('Config root must be an object')
      }
      try {
        const before = parsePortalConfig(document.toJS(), defaults)
        if (deepEqual(before.keybindings, keybindings)) return keybindings
      } catch {
        // Reset remains a recovery path for malformed keybinding overrides.
      }
      const overrides = serializeKeybindingOverrides(keybindings)
      if (Object.keys(overrides).length === 0) document.delete('keybindings')
      else document.set('keybindings', overrides)
      parsePortalConfig(document.toJS(), defaults)
      if (existsSync(configPath) || document.contents.items.length > 0) {
        await writePortalConfigContentsUnlocked(configPath, String(document))
      }
      return keybindings
    })
  } catch (error) {
    throw withConfigContext(error, configPath)
  }
}

export async function updatePortalConfig(
  configPath: string,
  update: (config: PortalConfigDocument) => void,
  defaults: PortalConfigDocument = createDefaultPortalConfig(
    path.dirname(configPath)
  )
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
  defaults: PortalConfigDocument = createDefaultPortalConfig(
    path.dirname(configPath)
  )
): Promise<T> {
  try {
    return await withConfigLock(configPath, async () => {
      const document = await readConfigDocumentOrEmpty(configPath)
      const before = parsePortalConfig(document.toJS(), defaults)
      const config = cloneConfig(before)
      let state: 'pending' | 'committed' | 'unchanged' = 'pending'
      const transaction: PortalConfigTransaction = {
        config,
        async commit() {
          if (state !== 'pending') throw completedTransactionError()
          state = 'committed'
          if (deepEqual(before, config)) return
          applyResolvedDiff(document, before, config, defaults)
          parsePortalConfig(document.toJS(), defaults)
          if (existsSync(configPath) || hasDocumentEntries(document)) {
            await writePortalConfigContentsUnlocked(
              configPath,
              String(document)
            )
          }
        },
        noChange() {
          if (state !== 'pending') throw completedTransactionError()
          state = 'unchanged'
        },
      }
      const result = await action(transaction)
      if (state === 'pending') {
        throw new PortalConfigError(
          'Config transaction must call commit() or noChange()'
        )
      }
      return result
    })
  } catch (error) {
    throw withConfigContext(error, configPath)
  }
}

function applyResolvedDiff(
  document: Document,
  before: PortalConfigDocument,
  after: PortalConfigDocument,
  defaults: PortalConfigDocument
): void {
  if (before.browser.executablePath !== after.browser.executablePath) {
    setOrDelete(
      document,
      ['browser', 'executablePath'],
      after.browser.executablePath === defaults.browser.executablePath
        ? undefined
        : after.browser.executablePath
    )
  }
  if (before.projectInstructions !== after.projectInstructions) {
    setOrDelete(
      document,
      ['projectInstructions'],
      after.projectInstructions ? true : undefined
    )
  }
  for (const field of ['host', 'port'] as const) {
    if (before.mcp[field] !== after.mcp[field]) {
      setOrDelete(
        document,
        ['mcp', field],
        after.mcp[field] === defaults.mcp[field] ? undefined : after.mcp[field]
      )
    }
  }
  if (before.hooks.enabled !== after.hooks.enabled) {
    setOrDelete(
      document,
      ['hooks', 'enabled'],
      after.hooks.enabled ? true : undefined
    )
  }
  if (!deepEqual(before.hooks.handlers, after.hooks.handlers)) {
    setOrDelete(
      document,
      ['hooks', 'handlers'],
      after.hooks.handlers.length === 0 ? undefined : after.hooks.handlers
    )
  }
  for (const action of KEYBINDING_ACTIONS) {
    if (!deepEqual(before.keybindings[action], after.keybindings[action])) {
      setOrDelete(
        document,
        ['keybindings', action],
        deepEqual(after.keybindings[action], defaults.keybindings[action])
          ? undefined
          : after.keybindings[action]
      )
    }
  }
  pruneEmptyMaps(document, ['browser', 'mcp', 'hooks', 'keybindings'])
}

function setOrDelete(
  document: Document,
  pathSegments: readonly string[],
  value: unknown
): void {
  if (value === undefined) document.deleteIn(pathSegments)
  else document.setIn(pathSegments, value)
}

function pruneEmptyMaps(document: Document, names: readonly string[]): void {
  for (const name of names) {
    const node = document.get(name, true)
    if (isMap(node) && node.items.length === 0) document.delete(name)
  }
}

function serializeKeybindingOverrides(
  keybindings: KeybindingConfig,
  defaults = createDefaultKeybindings()
): Partial<Record<KeybindingAction, readonly string[]>> {
  const overrides: Partial<Record<KeybindingAction, readonly string[]>> = {}
  for (const action of KEYBINDING_ACTIONS) {
    if (!deepEqual(keybindings[action], defaults[action])) {
      overrides[action] = [...keybindings[action]]
    }
  }
  return overrides
}

async function readConfigDocumentOrEmpty(
  configPath: string
): Promise<Document> {
  const contents = await readRegularTextFile(configPath, 'Config')
  return contents === null ? new Document({}) : parseConfigDocument(contents)
}

function parseConfigDocument(contents: string): Document {
  const document = parseDocument(contents.replace(/^\uFEFF/, ''), {
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    const location = document.errors[0]?.linePos?.[0]
    throw new PortalConfigError(
      location === undefined
        ? 'Invalid YAML'
        : `Invalid YAML at line ${location.line}, column ${location.col}`
    )
  }
  return document
}

async function writePortalConfigContentsUnlocked(
  configPath: string,
  contents: string
): Promise<void> {
  const directory = path.dirname(configPath)
  await ensurePrivateDirectory(directory)
  const existing = await lstatRegularFileOrMissing(configPath, 'Config')
  let mode = PRIVATE_FILE_MODE
  if (process.platform !== 'win32' && existing !== null) {
    mode = existing.mode & 0o700
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(
      temporaryPath,
      contents.endsWith('\n') ? contents : `${contents}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      }
    )
    if (process.platform !== 'win32') await chmod(temporaryPath, mode)
    await rename(temporaryPath, configPath)
    await ensurePrivateFile(configPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function readRegularTextFile(
  filePath: string,
  label: string
): Promise<string | null> {
  const file = await lstatRegularFileOrMissing(filePath, label)
  if (file === null) return null
  return await readFile(filePath, 'utf8')
}

async function lstatRegularFileOrMissing(
  filePath: string,
  label: string
): Promise<Stats | null> {
  try {
    const file = await lstat(filePath)
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new PortalConfigError(`${label} path must be a regular file`)
    }
    return file
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  const configDirectory = path.dirname(path.resolve(configPath))
  await ensurePrivateDirectory(configDirectory)
  const config = await lstatRegularFileOrMissing(configPath, 'Config')
  if (config !== null) await ensurePrivateFile(configPath)
  const lockDirectory = path.join(configDirectory, '.locks')
  await ensureSafeLockDirectory(lockDirectory, 'Config lock directory')
  const resolvedDirectory = await realpath(lockDirectory)
  const lockPath = path.join(resolvedDirectory, 'config.lock')
  const key = process.platform === 'win32' ? lockPath.toLowerCase() : lockPath
  const previous = localTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  localTails.set(key, current)
  await previous
  try {
    return await withFileLock(lockPath, configPath, action)
  } finally {
    release()
    if (localTails.get(key) === current) localTails.delete(key)
  }
}

async function withFileLock<T>(
  lockPath: string,
  configPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockFile = await openSafeLockFile(lockPath, 'Config lock')
  const deadline = Date.now() + DEFAULT_LOCK_WAIT_MS
  let acquired = false
  try {
    while (!tryLock(lockFile.fd)) {
      if (Date.now() >= deadline) {
        throw new PortalConfigError(
          `Timed out waiting for config lock: ${configPath}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
    acquired = true
    return await action()
  } finally {
    try {
      if (acquired) unlock(lockFile.fd)
    } finally {
      await lockFile.close()
    }
  }
}

async function ensureSafeLockDirectory(
  lockDirectory: string,
  label: string
): Promise<void> {
  const existing = await lstatPathOrMissing(lockDirectory)
  if (
    existing !== null &&
    (!existing.isDirectory() || existing.isSymbolicLink())
  ) {
    throw new PortalConfigError(`${label} path must be a regular directory`)
  }
  await ensurePrivateDirectory(lockDirectory)
  const current = await lstat(lockDirectory)
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new PortalConfigError(`${label} path must be a regular directory`)
  }
}

async function openSafeLockFile(lockPath: string, label: string) {
  const flags =
    constants.O_RDWR |
    constants.O_CREAT |
    constants.O_APPEND |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  let lockFile
  try {
    lockFile = await open(lockPath, flags, PRIVATE_FILE_MODE)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new PortalConfigError(`${label} path must be a regular file`)
    }
    throw error
  }
  try {
    const [opened, linked] = await Promise.all([
      lockFile.stat(),
      lstat(lockPath),
    ])
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new PortalConfigError(`${label} path must be a regular file`)
    }
    if (process.platform !== 'win32') {
      await lockFile.chmod(opened.mode & 0o700)
    }
    return lockFile
  } catch (error) {
    await lockFile.close()
    throw error
  }
}

async function lstatPathOrMissing(filePath: string): Promise<Stats | null> {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function cloneConfig(config: PortalConfigDocument): PortalConfigDocument {
  return {
    browser: { ...config.browser },
    projectInstructions: config.projectInstructions,
    mcp: { ...config.mcp },
    hooks: structuredClone(config.hooks),
    keybindings: structuredClone(config.keybindings),
  }
}

function hasDocumentEntries(document: Document): boolean {
  return isMap(document.contents) && document.contents.items.length > 0
}

function completedTransactionError(): PortalConfigError {
  return new PortalConfigError('Config transaction has already been completed')
}

function withConfigContext(error: unknown, configPath: string): Error {
  if (error instanceof PortalConfigError) {
    if (error.message.includes('\nConfig: ')) return error
    return new PortalConfigError(error.message, configPath)
  }
  return error instanceof Error ? error : new Error(String(error))
}

function parseOptionalRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value))
    throw new PortalConfigError(`${label} must be an object`)
  return value
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

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
