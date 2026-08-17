import { constants } from 'node:fs'
import {
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

import {
  ensurePrivateDirectory,
  ensurePrivateFile,
} from '../shared/private-files.ts'
import { freezeImmutableData } from './immutable-data.ts'
import type {
  InstalledPluginRecord,
  PluginStoreRepairResult,
  PluginStoreDocument,
} from './plugin-contracts.ts'
import { parsePluginManifest } from './plugin-manifest.ts'

export class PluginStoreError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PluginStoreError'
  }
}

export interface PluginStore {
  read(): Promise<readonly InstalledPluginRecord[]>
  replace(packages: readonly InstalledPluginRecord[]): Promise<void>
  update(
    update: (
      packages: readonly InstalledPluginRecord[]
    ) => readonly InstalledPluginRecord[]
  ): Promise<readonly InstalledPluginRecord[]>
  repair(): Promise<PluginStoreRepairResult>
}

const localTails = new Map<string, Promise<void>>()
const LOCK_RETRY_MS = 25
const LOCK_WAIT_MS = 5000
const PRIVATE_FILE_MODE = 0o600

export class JsonPluginStore implements PluginStore {
  readonly #filePath: string

  public constructor(filePath: string) {
    this.#filePath = path.resolve(filePath)
  }

  public async read(): Promise<readonly InstalledPluginRecord[]> {
    let text: string
    try {
      text = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return Object.freeze([])
      throw new PluginStoreError(
        `Unable to read plugin records: ${getErrorMessage(error)}`
      )
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch (error) {
      throw new PluginStoreError(
        `Plugin records are not valid JSON: ${getErrorMessage(error)}`
      )
    }
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 1 ||
      !Array.isArray(raw.packages)
    ) {
      throw new PluginStoreError('Plugin records have an unsupported schema.')
    }
    const packages = raw.packages.map((record, index) =>
      parseInstalledRecord(record, index)
    )
    const seen = new Set<string>()
    for (const record of packages) {
      const id = record.manifest.id
      if (typeof id !== 'string' || seen.has(id)) {
        throw new PluginStoreError(
          `Plugin records contain a duplicate or invalid ID: ${String(id)}`
        )
      }
      seen.add(id)
    }
    freezeImmutableData(raw)
    return Object.freeze(packages)
  }

  public async replace(
    packages: readonly InstalledPluginRecord[]
  ): Promise<void> {
    await this.#withLock(async () => await this.#replaceUnlocked(packages))
  }

  async #replaceUnlocked(
    packages: readonly InstalledPluginRecord[]
  ): Promise<void> {
    const document: PluginStoreDocument = {
      schemaVersion: 1,
      packages: Object.freeze([...packages]),
    }
    const serialized = JSON.stringify(document, null, 2) + '\n'
    const directory = path.dirname(this.#filePath)
    await ensurePrivateDirectory(directory)
    const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
      await ensurePrivateFile(temporary)
      try {
        await rename(temporary, this.#filePath)
      } catch (error) {
        if (!isReplaceRace(error)) throw error
        await rm(this.#filePath, { force: true })
        await rename(temporary, this.#filePath)
      }
      await ensurePrivateFile(this.#filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new PluginStoreError(
        `Unable to write plugin records: ${getErrorMessage(error)}`
      )
    }
  }

  public async update(
    update: (
      packages: readonly InstalledPluginRecord[]
    ) => readonly InstalledPluginRecord[]
  ): Promise<readonly InstalledPluginRecord[]> {
    return await this.#withLock(async () => {
      const next = Object.freeze([...update(await this.read())])
      await this.#replaceUnlocked(next)
      return next
    })
  }

  public async repair(): Promise<PluginStoreRepairResult> {
    return await this.#withLock(async () => {
      let backupPath: string | null = null
      try {
        await readFile(this.#filePath)
        backupPath = `${this.#filePath}.corrupt.${Date.now()}`
        await rename(this.#filePath, backupPath)
      } catch (error) {
        if (!isMissingFile(error)) {
          throw new PluginStoreError(
            `Unable to preserve plugin records: ${getErrorMessage(error)}`
          )
        }
      }
      await this.#replaceUnlocked(Object.freeze([]))
      return Object.freeze({ backupPath })
    })
  }

  async #withLock<T>(action: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.#filePath)
    await ensurePrivateDirectory(directory)
    const lockDirectory = path.join(directory, '.locks')
    await ensureSafeLockDirectory(lockDirectory)
    const resolvedLockDirectory = await realpath(lockDirectory)
    const lockPath = path.join(resolvedLockDirectory, 'plugins.lock')
    const key = process.platform === 'win32' ? lockPath.toLowerCase() : lockPath
    const previous = localTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    localTails.set(key, current)
    await previous
    try {
      return await withFileLock(lockPath, action)
    } finally {
      release()
      if (localTails.get(key) === current) localTails.delete(key)
    }
  }
}

const RECORD_FIELDS = new Set([
  'manifest',
  'source',
  'trust',
  'enabled',
  'disabledContributions',
  'installedAt',
  'updatedAt',
])
const SOURCE_FIELDS = new Set(['kind', 'locator', 'digest'])
const TRUST_FIELDS = new Set([
  'capabilities',
  'updatePolicy',
  'capabilityExpansion',
])

function parseInstalledRecord(
  value: unknown,
  index: number
): InstalledPluginRecord {
  const label = `packages[${index}]`
  const record = strictRecord(value, RECORD_FIELDS, label)
  const manifest = parsePluginManifest(record.manifest)
  const source = strictRecord(record.source, SOURCE_FIELDS, `${label}.source`)
  if (
    source.kind !== 'built-in' &&
    source.kind !== 'local-directory' &&
    source.kind !== 'package-archive'
  ) {
    throw new PluginStoreError(`${label}.source.kind is unsupported.`)
  }
  if (typeof source.locator !== 'string' || source.locator.trim() === '') {
    throw new PluginStoreError(`${label}.source.locator must be a string.`)
  }
  if (
    typeof source.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.digest)
  ) {
    throw new PluginStoreError(
      `${label}.source.digest must be a SHA-256 digest.`
    )
  }
  const trust = strictRecord(record.trust, TRUST_FIELDS, `${label}.trust`)
  const capabilities = stringArray(
    trust.capabilities,
    `${label}.trust.capabilities`
  )
  for (const capability of capabilities) {
    if (!manifest.capabilities.includes(capability)) {
      throw new PluginStoreError(
        `${label}.trust grants undeclared capability ${capability}.`
      )
    }
  }
  if (
    trust.updatePolicy !== 'pinned' &&
    trust.updatePolicy !== 'trust-source' &&
    trust.updatePolicy !== 'trust-publisher' &&
    trust.updatePolicy !== 'trust-all-manual-adds'
  ) {
    throw new PluginStoreError(`${label}.trust.updatePolicy is unsupported.`)
  }
  if (
    trust.capabilityExpansion !== 'auto-allow' &&
    trust.capabilityExpansion !== 'deny' &&
    trust.capabilityExpansion !== 'ask'
  ) {
    throw new PluginStoreError(
      `${label}.trust.capabilityExpansion is unsupported.`
    )
  }
  if (typeof record.enabled !== 'boolean') {
    throw new PluginStoreError(`${label}.enabled must be a boolean.`)
  }
  const disabledContributions = parseDisabledContributions(
    record.disabledContributions,
    manifest,
    label
  )
  const installedAt = timestamp(record.installedAt, `${label}.installedAt`)
  const updatedAt = timestamp(record.updatedAt, `${label}.updatedAt`)
  const parsed: InstalledPluginRecord = {
    manifest,
    source: Object.freeze({
      kind: source.kind,
      locator: source.locator,
      digest: source.digest,
    }),
    trust: Object.freeze({
      capabilities,
      updatePolicy: trust.updatePolicy,
      capabilityExpansion: trust.capabilityExpansion,
    }),
    enabled: record.enabled,
    disabledContributions,
    installedAt,
    updatedAt,
  }
  freezeImmutableData(parsed)
  return parsed
}

function parseDisabledContributions(
  value: unknown,
  manifest: InstalledPluginRecord['manifest'],
  label: string
): InstalledPluginRecord['disabledContributions'] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new PluginStoreError(
      `${label}.disabledContributions must be an array.`
    )
  }
  const declared = new Map(
    manifest.contributions.map((item) => [`${item.point}\0${item.id}`, item])
  )
  const seen = new Set<string>()
  const result = value.map((item, index) => {
    const entry = strictRecord(
      item,
      new Set(['point', 'id', 'version']),
      `${label}.disabledContributions[${index}]`
    )
    if (
      typeof entry.point !== 'string' ||
      typeof entry.id !== 'string' ||
      typeof entry.version !== 'number'
    ) {
      throw new PluginStoreError(
        `${label}.disabledContributions[${index}] is invalid.`
      )
    }
    const key = `${entry.point}\0${entry.id}`
    const declaration = declared.get(key)
    if (declaration === undefined || declaration.version !== entry.version) {
      throw new PluginStoreError(
        `${label}.disabledContributions[${index}] is not declared by the manifest.`
      )
    }
    if (seen.has(key)) {
      throw new PluginStoreError(
        `${label}.disabledContributions contains duplicate ${entry.point}:${entry.id}.`
      )
    }
    seen.add(key)
    return Object.freeze({
      point: declaration.point,
      id: declaration.id,
      version: declaration.version,
    })
  })
  return Object.freeze(result)
}

async function ensureSafeLockDirectory(lockDirectory: string): Promise<void> {
  try {
    const existing = await lstat(lockDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new PluginStoreError(
        'Plugin lock directory path must be a regular directory.'
      )
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  await ensurePrivateDirectory(lockDirectory)
  const current = await lstat(lockDirectory)
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new PluginStoreError(
      'Plugin lock directory path must be a regular directory.'
    )
  }
}

async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>
): Promise<T> {
  const flags =
    constants.O_RDWR |
    constants.O_CREAT |
    constants.O_APPEND |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  const lockFile = await open(lockPath, flags, PRIVATE_FILE_MODE)
  let acquired = false
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
      throw new PluginStoreError('Plugin lock path must be a regular file.')
    }
    const deadline = Date.now() + LOCK_WAIT_MS
    while (!tryLock(lockFile.fd)) {
      if (Date.now() >= deadline) {
        throw new PluginStoreError('Timed out waiting for plugin store lock.')
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

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): Record<string, unknown> {
  if (!isRecord(value))
    throw new PluginStoreError(`${label} must be an object.`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new PluginStoreError(`Unknown ${label} field: ${key}`)
  }
  return value
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value))
    throw new PluginStoreError(`${label} must be an array.`)
  const seen = new Set<string>()
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PluginStoreError(`${label}[${index}] must be a string.`)
    }
    if (seen.has(item))
      throw new PluginStoreError(`${label} contains duplicate ${item}.`)
    seen.add(item)
    return item
  })
  return Object.freeze(result)
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new PluginStoreError(`${label} must be an ISO timestamp.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isReplaceRace(error: unknown): boolean {
  return (
    isNodeError(error) && (error.code === 'EEXIST' || error.code === 'EPERM')
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
