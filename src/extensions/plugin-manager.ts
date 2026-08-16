import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { lt, satisfies } from 'semver'

import type {
  InstalledPluginRecord,
  PluginCapabilityExpansionPolicy,
  PluginDiagnostic,
  PluginResolutionSnapshot,
  PluginTrustGrant,
  PluginUpdatePolicy,
} from './plugin-contracts.ts'
import { readPluginManifest } from './plugin-manifest.ts'
import type { PluginStore } from './plugin-store.ts'

export interface AddLocalPluginOptions {
  readonly capabilities?: readonly string[]
  readonly updatePolicy?: PluginUpdatePolicy
  readonly capabilityExpansion?: PluginCapabilityExpansionPolicy
}

export interface UpdateLocalPluginOptions {
  readonly allowCapabilityExpansion?: boolean
  readonly allowDowngrade?: boolean
}

export class PluginManagerError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PluginManagerError'
  }
}

export class PluginManager {
  readonly #store: PluginStore
  readonly #clock: () => number
  readonly #supportedApiVersion: number

  public constructor(options: {
    readonly store: PluginStore
    readonly clock?: () => number
    readonly supportedApiVersion?: number
  }) {
    this.#store = options.store
    this.#clock = options.clock ?? Date.now
    this.#supportedApiVersion = options.supportedApiVersion ?? 1
  }

  public async list(): Promise<readonly InstalledPluginRecord[]> {
    return await this.#store.read()
  }

  public async addLocalDirectory(
    sourceDirectory: string,
    options: AddLocalPluginOptions = {}
  ): Promise<InstalledPluginRecord> {
    const records = await this.addLocalDirectories([sourceDirectory], options)
    return records[0]!
  }

  public async addLocalDirectories(
    sourceDirectories: readonly string[],
    options: AddLocalPluginOptions = {}
  ): Promise<readonly InstalledPluginRecord[]> {
    if (sourceDirectories.length === 0) {
      throw new PluginManagerError('At least one plugin source is required.')
    }
    const records = await Promise.all(
      sourceDirectories.map(
        async (sourceDirectory) =>
          await this.#prepareLocalDirectory(sourceDirectory, options)
      )
    )
    const ids = new Set<string>()
    for (const record of records) {
      if (ids.has(record.manifest.id)) {
        throw new PluginManagerError(
          `Plugin appears more than once in the install transaction: ${record.manifest.id}`
        )
      }
      ids.add(record.manifest.id)
    }
    await this.#store.update((packages) => {
      const installed = new Set(packages.map((item) => item.manifest.id))
      for (const record of records) {
        if (installed.has(record.manifest.id)) {
          throw new PluginManagerError(
            `Plugin is already installed: ${record.manifest.id}`
          )
        }
      }
      const next = [...packages, ...records]
      validateEnabledDependencyGraph(next)
      return next
    })
    return Object.freeze(records)
  }

  async #prepareLocalDirectory(
    sourceDirectory: string,
    options: AddLocalPluginOptions
  ): Promise<InstalledPluginRecord> {
    const directory = await realpath(sourceDirectory)
    const stats = await lstat(directory)
    if (!stats.isDirectory())
      throw new PluginManagerError('Plugin source must be a directory.')
    const manifest = await readPluginManifest(directory)
    const digest = await digestDirectory(directory)
    const declaredCapabilities = [...manifest.capabilities]
    const capabilities = options.capabilities ?? declaredCapabilities
    for (const capability of capabilities) {
      if (!declaredCapabilities.includes(capability)) {
        throw new PluginManagerError(
          `Plugin grant exceeds declared capability: ${capability}`
        )
      }
    }
    const now = new Date(this.#clock()).toISOString()
    const trust: PluginTrustGrant = Object.freeze({
      capabilities: Object.freeze([...capabilities]),
      updatePolicy: options.updatePolicy ?? 'pinned',
      capabilityExpansion: options.capabilityExpansion ?? 'ask',
    })
    const record: InstalledPluginRecord = Object.freeze({
      manifest,
      source: Object.freeze({
        kind: 'local-directory',
        locator: directory,
        digest,
      }),
      trust,
      enabled: true,
      installedAt: now,
      updatedAt: now,
    })
    return record
  }

  public async enable(id: string): Promise<boolean> {
    return await this.#setEnabled(id, true)
  }

  public async disable(id: string): Promise<boolean> {
    return await this.#setEnabled(id, false)
  }

  public async remove(id: string): Promise<boolean> {
    let removed = false
    await this.#store.update((packages) => {
      removed = packages.some((record) => record.manifest.id === id)
      return removed
        ? packages.filter((record) => record.manifest.id !== id)
        : packages
    })
    return removed
  }

  public async updateLocalDirectory(
    id: string,
    options: UpdateLocalPluginOptions = {}
  ): Promise<InstalledPluginRecord | null> {
    const current = await this.inspect(id)
    if (current === null) return null
    if (current.source.kind !== 'local-directory') {
      throw new PluginManagerError(
        `Plugin ${id} is not installed from a local directory.`
      )
    }
    const directory = await realpath(current.source.locator)
    const manifest = await readPluginManifest(directory)
    if (manifest.id !== id) {
      throw new PluginManagerError(
        `Updated manifest ID ${manifest.id} does not match installed plugin ${id}.`
      )
    }
    if (
      options.allowDowngrade !== true &&
      lt(manifest.version, current.manifest.version)
    ) {
      throw new PluginManagerError(
        `Plugin ${id} cannot downgrade from ${current.manifest.version} to ${manifest.version}.`
      )
    }
    const previouslyGranted = current.trust.capabilities.filter((capability) =>
      manifest.capabilities.includes(capability)
    )
    const expanded = manifest.capabilities.filter(
      (capability) => !current.manifest.capabilities.includes(capability)
    )
    let capabilities = previouslyGranted
    if (expanded.length > 0) {
      if (current.trust.capabilityExpansion === 'auto-allow') {
        capabilities = [...previouslyGranted, ...expanded]
      } else if (
        current.trust.capabilityExpansion === 'ask' &&
        options.allowCapabilityExpansion !== true
      ) {
        throw new PluginManagerError(
          `Plugin ${id} requests new capabilities: ${expanded.join(', ')}.`
        )
      } else if (options.allowCapabilityExpansion === true) {
        capabilities = [...previouslyGranted, ...expanded]
      }
    }
    const digest = await digestDirectory(directory)
    let updated: InstalledPluginRecord | null = null
    await this.#store.update((packages) => {
      const index = packages.findIndex((record) => record.manifest.id === id)
      if (index < 0) return packages
      const latest = packages[index]!
      if (latest.source.digest !== current.source.digest) {
        throw new PluginManagerError(
          `Plugin ${id} changed while its update was being prepared.`
        )
      }
      updated = Object.freeze({
        manifest,
        source: Object.freeze({
          kind: 'local-directory' as const,
          locator: directory,
          digest,
        }),
        trust: Object.freeze({
          ...latest.trust,
          capabilities: Object.freeze(capabilities),
        }),
        enabled: latest.enabled,
        installedAt: latest.installedAt,
        updatedAt: new Date(this.#clock()).toISOString(),
      })
      const next = [...packages]
      next[index] = updated
      validateEnabledDependencyGraph(next)
      return next
    })
    return updated
  }

  public async inspect(id: string): Promise<InstalledPluginRecord | null> {
    return (
      (await this.#store.read()).find((record) => record.manifest.id === id) ??
      null
    )
  }

  public async diagnose(): Promise<readonly PluginDiagnostic[]> {
    const packages = await this.#store.read()
    const diagnostics: PluginDiagnostic[] = []
    const records = new Map(
      packages.map((record) => [record.manifest.id, record])
    )
    for (const record of packages) {
      if (record.manifest.apiVersion !== this.#supportedApiVersion) {
        diagnostics.push({
          packageId: record.manifest.id,
          code: 'api-version-unsupported',
          message:
            `${record.manifest.id} requires Portal plugin API ` +
            `${record.manifest.apiVersion}; this Portal supports ${this.#supportedApiVersion}.`,
        })
      }
      try {
        const digest = await digestDirectory(record.source.locator)
        if (digest !== record.source.digest) {
          diagnostics.push({
            packageId: record.manifest.id,
            code: 'digest-mismatch',
            message: `Installed source digest changed for ${record.manifest.id}.`,
          })
        }
      } catch {
        diagnostics.push({
          packageId: record.manifest.id,
          code: 'source-missing',
          message: `Installed source is unavailable for ${record.manifest.id}.`,
        })
      }
      for (const dependency of record.manifest.dependencies) {
        const dependencyRecord = records.get(dependency.id)
        if (dependencyRecord === undefined) {
          diagnostics.push({
            packageId: record.manifest.id,
            code: 'missing-dependency',
            message: `${record.manifest.id} requires ${dependency.id}.`,
          })
        } else if (!dependencyRecord.enabled) {
          diagnostics.push({
            packageId: record.manifest.id,
            code: 'disabled-dependency',
            message: `${record.manifest.id} requires disabled ${dependency.id}.`,
          })
        } else if (
          !satisfies(dependencyRecord.manifest.version, dependency.versionRange)
        ) {
          diagnostics.push({
            packageId: record.manifest.id,
            code: 'version-mismatch',
            message: `${record.manifest.id} requires ${dependency.id}@${dependency.versionRange}.`,
          })
        }
      }
    }
    return Object.freeze(diagnostics)
  }

  public async resolveEnabled(): Promise<PluginResolutionSnapshot> {
    const packages = await this.#store.read()
    const records = new Map(
      packages.map((record) => [record.manifest.id, record])
    )
    const diagnostics = [...(await this.diagnose())]
    const resolved: InstalledPluginRecord[] = []
    const invalid = new Set(
      diagnostics.map((diagnostic) => diagnostic.packageId)
    )
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const valid = new Set<string>()
    const visit = (id: string, stack: readonly string[]): boolean => {
      if (valid.has(id)) return true
      if (visited.has(id)) return false
      if (visiting.has(id)) {
        const cycleStart = stack.indexOf(id)
        const cycle = cycleStart < 0 ? [id] : stack.slice(cycleStart)
        for (const packageId of cycle) {
          if (
            !diagnostics.some(
              (diagnostic) =>
                diagnostic.packageId === packageId &&
                diagnostic.code === 'dependency-cycle'
            )
          ) {
            diagnostics.push({
              packageId,
              code: 'dependency-cycle',
              message: `Plugin dependency cycle includes ${cycle.join(' -> ')} -> ${id}.`,
            })
          }
          invalid.add(packageId)
        }
        return false
      }
      const record = records.get(id)
      if (record === undefined || !record.enabled || invalid.has(id)) {
        visited.add(id)
        return false
      }
      visiting.add(id)
      let dependenciesValid = true
      const nextStack = [...stack, id]
      for (const dependency of record.manifest.dependencies) {
        if (!visit(dependency.id, nextStack)) dependenciesValid = false
      }
      visiting.delete(id)
      visited.add(id)
      if (!dependenciesValid || invalid.has(id)) return false
      valid.add(id)
      resolved.push(record)
      return true
    }
    for (const record of packages) {
      if (record.enabled) visit(record.manifest.id, [])
    }
    return Object.freeze({
      generation: createGeneration(packages),
      packages: Object.freeze(resolved),
      diagnostics: Object.freeze(diagnostics),
    })
  }

  async #setEnabled(id: string, enabled: boolean): Promise<boolean> {
    let changed = false
    await this.#store.update((packages) => {
      const index = packages.findIndex((record) => record.manifest.id === id)
      if (index < 0) return packages
      changed = true
      const current = packages[index]!
      const next = Object.freeze({
        ...current,
        enabled,
        updatedAt: new Date(this.#clock()).toISOString(),
      })
      const updated = [...packages]
      updated[index] = next
      return updated
    })
    return changed
  }
}

export async function digestDirectory(directory: string): Promise<string> {
  const rootStats = await lstat(directory)
  if (rootStats.isSymbolicLink()) {
    throw new PluginManagerError(
      'Plugin source root must not be a symbolic link.'
    )
  }
  if (!rootStats.isDirectory()) {
    throw new PluginManagerError('Plugin source must be a directory.')
  }
  const hash = createHash('sha256')
  await hashDirectory(hash, path.resolve(directory), '')
  return hash.digest('hex')
}

async function hashDirectory(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name)
  )
  for (const entry of entries) {
    const relative =
      relativeDirectory === ''
        ? entry.name
        : `${relativeDirectory}/${entry.name}`
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new PluginManagerError(`Symlink is not allowed: ${relative}`)
    if (entry.isDirectory()) {
      if (entry.name === 'data') continue
      await hashDirectory(hash, absolute, relative)
      continue
    }
    if (!entry.isFile())
      throw new PluginManagerError(`Unsupported package entry: ${relative}`)
    hash.update(relative)
    hash.update('\0')
    hash.update(await readFile(absolute))
  }
}

function createGeneration(packages: readonly InstalledPluginRecord[]): string {
  const hash = createHash('sha256')
  for (const record of [...packages].sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id)
  )) {
    hash.update(record.manifest.id)
    hash.update('\0')
    hash.update(record.manifest.version)
    hash.update('\0')
    hash.update(record.source.digest)
    hash.update('\0')
    hash.update(record.enabled ? 'enabled' : 'disabled')
    hash.update('\0')
    for (const capability of [...record.trust.capabilities].sort()) {
      hash.update(capability)
      hash.update('\0')
    }
  }
  return hash.digest('hex').slice(0, 24)
}

function validateEnabledDependencyGraph(
  packages: readonly InstalledPluginRecord[]
): void {
  const records = new Map(
    packages.map((record) => [record.manifest.id, record])
  )
  for (const record of packages) {
    if (!record.enabled) continue
    for (const dependency of record.manifest.dependencies) {
      const dependencyRecord = records.get(dependency.id)
      if (dependencyRecord === undefined) {
        throw new PluginManagerError(
          `${record.manifest.id} requires missing plugin ${dependency.id}.`
        )
      }
      if (!dependencyRecord.enabled) {
        throw new PluginManagerError(
          `${record.manifest.id} requires disabled plugin ${dependency.id}.`
        )
      }
      if (
        !satisfies(dependencyRecord.manifest.version, dependency.versionRange)
      ) {
        throw new PluginManagerError(
          `${record.manifest.id} requires ${dependency.id}@${dependency.versionRange}, ` +
            `but ${dependencyRecord.manifest.version} is installed.`
        )
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, stack: readonly string[]): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id)
      const cycle =
        cycleStart < 0 ? [...stack, id] : [...stack.slice(cycleStart), id]
      throw new PluginManagerError(
        `Plugin dependency cycle: ${cycle.join(' -> ')}`
      )
    }
    const record = records.get(id)
    if (record === undefined || !record.enabled) return
    visiting.add(id)
    const nextStack = [...stack, id]
    for (const dependency of record.manifest.dependencies) {
      visit(dependency.id, nextStack)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const record of packages) {
    if (record.enabled) visit(record.manifest.id, [])
  }
}
