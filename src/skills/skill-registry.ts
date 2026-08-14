import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
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

import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  PRIVATE_FILE_MODE,
} from '../shared/private-files.ts'
import { validateSkillName } from './skill-manifest.ts'

export interface SkillRegistryEntry {
  directory: string
  enabled: boolean
}

export interface SkillRegistryIssue {
  name: string
  message: string
}

export interface SkillRegistryData {
  entries: Map<string, SkillRegistryEntry>
  issues: readonly SkillRegistryIssue[]
}

export interface SkillRegistryTransaction {
  readonly registry: SkillRegistryData
  commit(): Promise<void>
  noChange(): void
}

export class SkillRegistryError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SkillRegistryError'
  }
}

const REGISTRY_VERSION = 1
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25
const localTails = new Map<string, Promise<void>>()

export async function readSkillRegistry(
  registryPath: string
): Promise<SkillRegistryData | null> {
  const contents = await readRegistryContents(registryPath)
  return contents === null ? null : parseRegistryContents(contents)
}

export function parseSkillRegistry(document: unknown): SkillRegistryData {
  return parseEntries(document)
}

export async function writeSkillRegistry(
  registryPath: string,
  entries: ReadonlyMap<string, SkillRegistryEntry>
): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    await writeRegistryUnlocked(registryPath, entries)
  })
}

export async function ensureSkillRegistry(
  registryPath: string,
  entries: ReadonlyMap<string, SkillRegistryEntry>
): Promise<SkillRegistryData> {
  return await withRegistryLock(registryPath, async () => {
    const existing = await readSkillRegistry(registryPath)
    if (existing !== null) return existing
    await writeRegistryUnlocked(registryPath, entries)
    return { entries: new Map(entries), issues: [] }
  })
}

export async function updateSkillRegistry<T>(
  registryPath: string,
  update: (registry: SkillRegistryData) => T
): Promise<T> {
  return await withSkillRegistryTransaction(
    registryPath,
    async (transaction) => {
      const result = update(transaction.registry)
      await transaction.commit()
      return result
    }
  )
}

export async function withSkillRegistryTransaction<T>(
  registryPath: string,
  action: (transaction: SkillRegistryTransaction) => Promise<T> | T
): Promise<T> {
  return await withRegistryLock(registryPath, async () => {
    const registry = (await readSkillRegistry(registryPath)) ?? {
      entries: new Map<string, SkillRegistryEntry>(),
      issues: [],
    }
    let state: 'pending' | 'committed' | 'unchanged' = 'pending'
    const transaction: SkillRegistryTransaction = {
      registry,
      async commit() {
        if (state !== 'pending') {
          throw new SkillRegistryError(
            'Skill registry transaction has already been completed'
          )
        }
        state = 'committed'
        await writeRegistryUnlocked(registryPath, registry.entries)
      },
      noChange() {
        if (state !== 'pending') {
          throw new SkillRegistryError(
            'Skill registry transaction has already been completed'
          )
        }
        state = 'unchanged'
      },
    }
    const result = await action(transaction)
    if (state === 'pending') {
      throw new SkillRegistryError(
        'Skill registry transaction must call commit() or noChange()'
      )
    }
    return result
  })
}

export function resolveSkillDirectory(
  registryPath: string,
  directory: string
): string {
  return path.resolve(path.dirname(registryPath), directory)
}

function parseRegistryDocument(value: unknown): SkillRegistryData {
  if (!isRecord(value))
    throw new SkillRegistryError('Registry must be an object')
  assertFields(value, new Set(['version', 'skills']), 'registry')
  if (value.version !== REGISTRY_VERSION) {
    throw new SkillRegistryError(
      `Unsupported Skill registry version: ${String(value.version)}`
    )
  }
  return parseEntries(value.skills)
}

async function readRegistryContents(
  registryPath: string
): Promise<string | null> {
  const file = await lstatRegularFileOrMissing(registryPath)
  return file === null ? null : await readFile(registryPath, 'utf8')
}

function parseRegistryContents(contents: string): SkillRegistryData {
  let raw: unknown
  try {
    raw = JSON.parse(contents.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new SkillRegistryError(`Invalid JSON: ${getErrorMessage(error)}`)
  }
  return parseRegistryDocument(raw)
}

function parseEntries(document: unknown): SkillRegistryData {
  if (!isRecord(document)) {
    throw new SkillRegistryError('skills must be an object keyed by name')
  }
  const entries = new Map<string, SkillRegistryEntry>()
  const issues: SkillRegistryIssue[] = []
  for (const [name, value] of Object.entries(document)) {
    try {
      validateSkillName(name)
      if (!isRecord(value))
        throw new SkillRegistryError('Entry must be an object')
      assertFields(value, new Set(['directory', 'enabled']), 'entry')
      if (
        typeof value.directory !== 'string' ||
        value.directory.trim() === ''
      ) {
        throw new SkillRegistryError('Entry requires a non-empty directory')
      }
      if (typeof value.enabled !== 'boolean') {
        throw new SkillRegistryError('Entry requires a boolean enabled value')
      }
      entries.set(name, { directory: value.directory, enabled: value.enabled })
    } catch (error) {
      issues.push({ name, message: getErrorMessage(error) })
    }
  }
  return { entries, issues }
}

async function writeRegistryUnlocked(
  registryPath: string,
  entries: ReadonlyMap<string, SkillRegistryEntry>
): Promise<void> {
  const skills = Object.fromEntries(
    [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))
  )
  await writePrivateFileAtomic(
    registryPath,
    `${JSON.stringify({ version: REGISTRY_VERSION, skills }, null, 2)}\n`
  )
}

async function writePrivateFileAtomic(filePath: string, contents: string) {
  const directory = path.dirname(filePath)
  await ensurePrivateDirectory(directory)
  const existing = await lstatRegularFileOrMissing(filePath)
  let mode = PRIVATE_FILE_MODE
  if (process.platform !== 'win32' && existing !== null) {
    mode = existing.mode & 0o700
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    if (process.platform !== 'win32') await chmod(temporaryPath, mode)
    await rename(temporaryPath, filePath)
    await ensurePrivateFile(filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function lstatRegularFileOrMissing(
  filePath: string
): Promise<Stats | null> {
  try {
    const file = await lstat(filePath)
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new SkillRegistryError(
        `Skill registry path must be a regular file: ${filePath}`
      )
    }
    return file
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function withRegistryLock<T>(
  registryPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockDirectory = path.join(
    path.dirname(path.resolve(registryPath)),
    '.locks'
  )
  await ensureSafeLockDirectory(lockDirectory)
  const resolvedDirectory = await realpath(lockDirectory)
  const lockPath = path.join(resolvedDirectory, 'skills.lock')
  const key = process.platform === 'win32' ? lockPath.toLowerCase() : lockPath
  const previous = localTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  localTails.set(key, current)
  await previous
  try {
    return await withFileLock(lockPath, registryPath, action)
  } finally {
    release()
    if (localTails.get(key) === current) localTails.delete(key)
  }
}

async function withFileLock<T>(
  lockPath: string,
  registryPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockFile = await openSafeLockFile(lockPath)
  const deadline = Date.now() + LOCK_WAIT_MS
  let acquired = false
  try {
    while (!tryLock(lockFile.fd)) {
      if (Date.now() >= deadline) {
        throw new SkillRegistryError(
          `Timed out waiting for Skill registry lock: ${registryPath}`
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

async function ensureSafeLockDirectory(lockDirectory: string): Promise<void> {
  const existing = await lstatPathOrMissing(lockDirectory)
  if (
    existing !== null &&
    (!existing.isDirectory() || existing.isSymbolicLink())
  ) {
    throw new SkillRegistryError(
      `Skill lock directory path must be a regular directory: ${lockDirectory}`
    )
  }
  await ensurePrivateDirectory(lockDirectory)
  const current = await lstat(lockDirectory)
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new SkillRegistryError(
      `Skill lock directory path must be a regular directory: ${lockDirectory}`
    )
  }
}

async function openSafeLockFile(lockPath: string) {
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
      throw new SkillRegistryError(
        `Skill lock path must be a regular file: ${lockPath}`
      )
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
      throw new SkillRegistryError(
        `Skill lock path must be a regular file: ${lockPath}`
      )
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

function assertFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field))
  if (unsupported.length > 0) {
    throw new SkillRegistryError(
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
