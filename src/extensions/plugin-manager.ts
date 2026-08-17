import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'
import { lt, satisfies } from 'semver'

import type {
  BuiltInPluginRecord,
  InstalledPluginRecord,
  PluginCapabilityExpansionPolicy,
  PluginDiagnostic,
  PluginContributionDeclaration,
  PluginContributionSelection,
  PluginResolutionSnapshot,
  PluginStoreRepairResult,
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

  /** Persist the bundled package set without executing any package code. */
  public async synchronizeBuiltIns(
    builtIns: readonly BuiltInPluginRecord[]
  ): Promise<void> {
    const definitions = new Map(
      builtIns.map((record) => [record.manifest.id, record])
    )
    await this.#store.update((packages) => {
      const next = packages.filter(
        (record) =>
          record.source.kind !== 'built-in' ||
          definitions.has(record.manifest.id)
      )
      const now = new Date(this.#clock()).toISOString()
      for (const definition of builtIns) {
        const index = next.findIndex(
          (record) => record.manifest.id === definition.manifest.id
        )
        if (index >= 0) {
          const current = next[index]!
          if (current.source.kind !== 'built-in') {
            throw new PluginManagerError(
              `Installed plugin ID is reserved by Portal: ${definition.manifest.id}`
            )
          }
          if (
            JSON.stringify({
              manifest: current.manifest,
              source: current.source,
              trust: current.trust,
            }) ===
            JSON.stringify({
              manifest: definition.manifest,
              source: definition.source,
              trust: definition.trust,
            })
          ) {
            continue
          }
          next[index] = Object.freeze({
            ...definition,
            enabled: current.enabled,
            disabledContributions: retainDeclaredContributions(
              current.disabledContributions,
              definition.manifest.contributions
            ),
            installedAt: current.installedAt,
            updatedAt: now,
          })
          continue
        }
        next.push(
          Object.freeze({
            ...definition,
            enabled: true,
            disabledContributions: Object.freeze([]),
            installedAt: now,
            updatedAt: now,
          })
        )
      }
      return next
    })
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
      disabledContributions: Object.freeze([]),
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
      const record = packages.find((item) => item.manifest.id === id)
      if (record === undefined) return packages
      if (record.source.kind === 'built-in') {
        throw new PluginManagerError(
          `Bundled plugin ${id} cannot be removed; disable it instead.`
        )
      }
      const dependents = packages
        .filter((item) =>
          item.manifest.dependencies.some((dependency) => dependency.id === id)
        )
        .map((item) => item.manifest.id)
      if (dependents.length > 0) {
        throw new PluginManagerError(
          `Plugin ${id} is required by installed plugin(s): ${dependents.join(', ')}. Disable or remove them first.`
        )
      }
      removed = true
      return packages.filter((record) => record.manifest.id !== id)
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
        disabledContributions: retainDeclaredContributions(
          latest.disabledContributions,
          manifest.contributions
        ),
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
    let packages: readonly InstalledPluginRecord[]
    try {
      packages = await this.#store.read()
    } catch (error) {
      return Object.freeze([
        Object.freeze({
          packageId: '<store>',
          code: 'invalid-record' as const,
          message: getErrorMessage(error),
        }),
      ])
    }
    const diagnostics = [...(await this.#diagnosePackages(packages, true))]
    resolveContributionDependencies(
      packages.filter(({ enabled }) => enabled),
      diagnostics,
      packages
    )
    return Object.freeze(diagnostics)
  }

  async #diagnosePackages(
    packages: readonly InstalledPluginRecord[],
    includeDisabled: boolean
  ): Promise<readonly PluginDiagnostic[]> {
    const diagnostics: PluginDiagnostic[] = []
    const records = new Map(
      packages.map((record) => [record.manifest.id, record])
    )
    for (const record of packages) {
      if (!includeDisabled && !record.enabled) continue
      if (record.manifest.apiVersion !== this.#supportedApiVersion) {
        diagnostics.push({
          packageId: record.manifest.id,
          code: 'api-version-unsupported',
          message:
            `${record.manifest.id} requires Portal plugin API ` +
            `${record.manifest.apiVersion}; this Portal supports ${this.#supportedApiVersion}.`,
        })
      }
      if (record.source.kind !== 'built-in') {
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
    const diagnostics = [...(await this.#diagnosePackages(packages, false))]
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
    const effectivePackages = resolveContributionDependencies(
      resolved,
      diagnostics,
      packages
    )
    return Object.freeze({
      generation: createGeneration(packages),
      packages: effectivePackages,
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

  public async setContributionEnabled(
    packageId: string,
    point: string,
    contributionId: string,
    enabled: boolean
  ): Promise<boolean> {
    let changed = false
    await this.#store.update((packages) => {
      const index = packages.findIndex(
        (record) => record.manifest.id === packageId
      )
      if (index < 0) return packages
      const current = packages[index]!
      const declaration = current.manifest.contributions.find(
        (item) => item.point === point && item.id === contributionId
      )
      if (declaration === undefined) {
        throw new PluginManagerError(
          `Plugin ${packageId} does not declare ${point}:${contributionId}.`
        )
      }
      const isDisabled = current.disabledContributions.some(
        (item) => item.point === point && item.id === contributionId
      )
      if (enabled === !isDisabled) {
        changed = true
        return packages
      }
      const disabledContributions = enabled
        ? current.disabledContributions.filter(
            (item) => item.point !== point || item.id !== contributionId
          )
        : [...current.disabledContributions, contributionSelection(declaration)]
      const updated = [...packages]
      updated[index] = Object.freeze({
        ...current,
        disabledContributions: Object.freeze(disabledContributions),
        updatedAt: new Date(this.#clock()).toISOString(),
      })
      changed = true
      return updated
    })
    return changed
  }

  public async repairStore(): Promise<PluginStoreRepairResult> {
    return await this.#store.repair()
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
    hash.update(
      JSON.stringify({
        manifest: record.manifest,
        source: record.source,
        trust: record.trust,
        enabled: record.enabled,
        disabledContributions: record.disabledContributions,
      })
    )
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 24)
}

function retainDeclaredContributions(
  disabled: readonly PluginContributionSelection[],
  declared: readonly PluginContributionDeclaration[]
): readonly PluginContributionSelection[] {
  const current = new Set(
    declared.map((item) => `${item.point}\0${item.id}\0${item.version}`)
  )
  return Object.freeze(
    disabled.filter((item) =>
      current.has(`${item.point}\0${item.id}\0${item.version}`)
    )
  )
}

function resolveContributionDependencies(
  packages: readonly InstalledPluginRecord[],
  diagnostics: PluginDiagnostic[],
  allPackages: readonly InstalledPluginRecord[]
): readonly InstalledPluginRecord[] {
  const nodes = new Map<
    string,
    {
      readonly packageId: string
      readonly declaration: PluginContributionDeclaration
    }
  >()
  const allPackageIds = new Set(allPackages.map(({ manifest }) => manifest.id))
  const activePackageIds = new Set(packages.map(({ manifest }) => manifest.id))
  const disabled = new Set<string>()
  for (const record of packages) {
    for (const declaration of record.manifest.contributions) {
      nodes.set(contributionKey(record.manifest.id, declaration), {
        packageId: record.manifest.id,
        declaration,
      })
    }
    for (const selection of record.disabledContributions) {
      disabled.add(contributionKey(record.manifest.id, selection))
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const markCycles = (key: string): void => {
    const current = state.get(key)
    if (current === 'visited') return
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(key)
      const cycle = stack.slice(cycleStart < 0 ? 0 : cycleStart)
      for (const cycleKey of cycle) {
        const node = nodes.get(cycleKey)
        if (node === undefined) continue
        disabled.add(cycleKey)
        pushPluginDiagnostic(diagnostics, {
          packageId: node.packageId,
          code: 'contribution-dependency-cycle',
          message: `Contribution dependency cycle includes ${formatContributionKey(cycleKey)}.`,
        })
      }
      return
    }
    const node = nodes.get(key)
    if (node === undefined) return
    state.set(key, 'visiting')
    stack.push(key)
    for (const dependency of node.declaration.dependencies) {
      const dependencyKey = contributionKey(dependency.packageId, dependency)
      if (nodes.has(dependencyKey)) markCycles(dependencyKey)
    }
    stack.pop()
    state.set(key, 'visited')
  }
  for (const key of nodes.keys()) markCycles(key)

  let changed = true
  while (changed) {
    changed = false
    for (const [key, node] of nodes) {
      if (disabled.has(key)) continue
      for (const dependency of node.declaration.dependencies) {
        const dependencyKey = contributionKey(dependency.packageId, dependency)
        if (!nodes.has(dependencyKey)) {
          disabled.add(key)
          changed = true
          const dependencyUnavailable =
            allPackageIds.has(dependency.packageId) &&
            !activePackageIds.has(dependency.packageId)
          pushPluginDiagnostic(diagnostics, {
            packageId: node.packageId,
            code: dependencyUnavailable
              ? 'disabled-contribution-dependency'
              : 'missing-contribution-dependency',
            message: dependencyUnavailable
              ? `${formatContributionKey(key)} requires disabled ${formatContributionKey(dependencyKey)}.`
              : `${formatContributionKey(key)} requires missing ${formatContributionKey(dependencyKey)}.`,
          })
          break
        }
        if (disabled.has(dependencyKey)) {
          disabled.add(key)
          changed = true
          pushPluginDiagnostic(diagnostics, {
            packageId: node.packageId,
            code: 'disabled-contribution-dependency',
            message: `${formatContributionKey(key)} requires disabled ${formatContributionKey(dependencyKey)}.`,
          })
          break
        }
      }
    }
  }

  return Object.freeze(
    packages.map((record) => {
      const disabledContributions = record.manifest.contributions
        .filter((declaration) =>
          disabled.has(contributionKey(record.manifest.id, declaration))
        )
        .map(contributionSelection)
      return Object.freeze({
        ...record,
        disabledContributions: Object.freeze(disabledContributions),
      })
    })
  )
}

function contributionSelection(
  declaration: PluginContributionDeclaration
): PluginContributionSelection {
  return Object.freeze({
    point: declaration.point,
    id: declaration.id,
    version: declaration.version,
  })
}

function contributionKey(
  packageId: string,
  contribution: {
    readonly point: string
    readonly id: string
    readonly version: number
  }
): string {
  return `${packageId}\0${contribution.point}\0${contribution.id}\0${contribution.version}`
}

function formatContributionKey(key: string): string {
  const [packageId, point, id, version] = key.split('\0')
  return `${packageId}:${point}:${id}@${version}`
}

function pushPluginDiagnostic(
  diagnostics: PluginDiagnostic[],
  diagnostic: PluginDiagnostic
): void {
  if (
    diagnostics.some(
      (current) =>
        current.packageId === diagnostic.packageId &&
        current.code === diagnostic.code &&
        current.message === diagnostic.message
    )
  ) {
    return
  }
  diagnostics.push(diagnostic)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
