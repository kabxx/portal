import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  ensurePrivateDirectory,
  ensurePrivateFile,
} from '../shared/private-files.ts'
import { freezeImmutableData } from './immutable-data.ts'
import type {
  InstalledPluginRecord,
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
}

export class JsonPluginStore implements PluginStore {
  readonly #filePath: string
  #tail: Promise<void> = Promise.resolve()

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
    let result: readonly InstalledPluginRecord[] = Object.freeze([])
    const operation = this.#tail.then(async () => {
      const next = Object.freeze([...update(await this.read())])
      await this.replace(next)
      result = next
    })
    this.#tail = operation.catch(() => undefined)
    await operation
    return result
  }
}

const RECORD_FIELDS = new Set([
  'manifest',
  'source',
  'trust',
  'enabled',
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
  if (source.kind !== 'local-directory' && source.kind !== 'package-archive') {
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
    installedAt,
    updatedAt,
  }
  freezeImmutableData(parsed)
  return parsed
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
