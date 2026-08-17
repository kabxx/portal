import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  ExtensionDescriptor,
  ExtensionRegistrationApi,
  ExtensionModule,
  ContributionRef,
  ExecutableBindingRef,
  HookRef,
  HookMode,
  ServiceRef,
  ServiceFactory,
  ContributionRegistration,
  ExecutableBindingRegistration,
  HookHandlerRegistration,
} from '../extensions/extension-contracts.ts'
import { pluginDescriptor } from '../extensions/plugin-contracts.ts'
import type {
  BuiltInPluginRecord,
  InstalledPluginRecord,
  PluginDiagnostic,
  PluginResolutionSnapshot,
} from '../extensions/plugin-contracts.ts'
import {
  digestDirectory,
  type PluginManager,
} from '../extensions/plugin-manager.ts'
import type { CatalogExtensionRegistration } from '../extensions/extension-catalog.ts'

export interface PortalPluginModule {
  readonly descriptor: ExtensionDescriptor
  readonly extension: ExtensionModule
}

export interface KernelPluginPlan {
  readonly generation: string
  readonly snapshot: PluginResolutionSnapshot
  readonly extensions: readonly CatalogExtensionRegistration[]
}

export interface BuiltInPluginDefinition {
  readonly record: BuiltInPluginRecord
  readonly load: () => Promise<CatalogExtensionRegistration>
}

export class PluginBootstrapError extends Error {
  public constructor(
    message: string,
    public readonly diagnostics: readonly PluginDiagnostic[] = Object.freeze([])
  ) {
    super(message)
    this.name = 'PluginBootstrapError'
  }
}

export class KernelBootstrap {
  readonly #manager: PluginManager
  readonly #importModule: (specifier: string) => Promise<unknown>
  readonly #builtIns: readonly BuiltInPluginDefinition[]

  public constructor(options: {
    readonly manager: PluginManager
    readonly importModule?: (specifier: string) => Promise<unknown>
    readonly builtIns?: readonly BuiltInPluginDefinition[]
  }) {
    this.#manager = options.manager
    this.#importModule = options.importModule ?? importDirectModule
    this.#builtIns = options.builtIns ?? []
  }

  public async prepare(
    options: {
      readonly excludedPackageIds?: readonly string[]
    } = {}
  ): Promise<KernelPluginPlan> {
    if (this.#builtIns.length > 0) {
      await this.#manager.synchronizeBuiltIns(
        this.#builtIns.map(({ record }) => record)
      )
    }
    const snapshot = await this.#manager.resolveEnabled()
    const blockingDiagnostics = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code !== 'disabled-dependency'
    )
    if (blockingDiagnostics.length > 0) {
      throw new PluginBootstrapError(
        `Plugin graph validation failed with ${blockingDiagnostics.length} diagnostic(s).`,
        blockingDiagnostics
      )
    }

    const builtIns = new Map(
      this.#builtIns.map((definition) => [
        definition.record.manifest.id,
        definition,
      ])
    )
    const excluded = new Set(options.excludedPackageIds ?? [])
    const extensions: CatalogExtensionRegistration[] = []
    for (const record of snapshot.packages) {
      if (excluded.has(record.manifest.id)) continue
      const builtIn = builtIns.get(record.manifest.id)
      extensions.push(
        builtIn === undefined
          ? await this.#load(record)
          : await this.#loadBuiltIn(record, builtIn)
      )
    }
    return Object.freeze({
      generation: snapshot.generation,
      snapshot,
      extensions: Object.freeze(extensions),
    })
  }

  async #loadBuiltIn(
    record: InstalledPluginRecord,
    definition: BuiltInPluginDefinition
  ): Promise<CatalogExtensionRegistration> {
    if (record.source.kind !== 'built-in') {
      throw new PluginBootstrapError(
        `Plugin ${record.manifest.id} does not match its bundled source record.`
      )
    }
    const registration = await definition.load()
    if (registration.packageId !== record.manifest.id) {
      throw new PluginBootstrapError(
        `Bundled plugin loader returned ${registration.packageId} for ${record.manifest.id}.`
      )
    }
    assertDescriptorMatches(
      registration.descriptor,
      pluginDescriptor(record.manifest)
    )
    return prepareRegistration(record, registration)
  }

  async #load(
    record: InstalledPluginRecord
  ): Promise<CatalogExtensionRegistration> {
    if (record.source.kind === 'built-in') {
      throw new PluginBootstrapError(
        `No bundled plugin loader is registered for ${record.manifest.id}.`
      )
    }
    const digest = await digestDirectory(record.source.locator)
    if (digest !== record.source.digest) {
      throw new PluginBootstrapError(
        `Plugin source changed after graph validation: ${record.manifest.id}`
      )
    }
    const entryPath = await resolvePackageEntry(
      record.source.locator,
      record.manifest.entry
    )
    let imported: unknown
    try {
      const specifier = `${pathToFileURL(entryPath).href}?portalDigest=${record.source.digest}`
      imported = await this.#importModule(specifier)
    } catch (error) {
      throw new PluginBootstrapError(
        `Unable to load plugin ${record.manifest.id}: ${getErrorMessage(error)}`
      )
    }
    const plugin = parsePortalPluginModule(imported, record.manifest.id)
    assertDescriptorMatches(
      plugin.descriptor,
      pluginDescriptor(record.manifest)
    )
    return Object.freeze({
      packageId: record.manifest.id,
      descriptor: pluginDescriptor(record.manifest, record.trust.capabilities),
      module: filterAndVerifyModule(record, plugin.extension),
    })
  }
}

function prepareRegistration(
  record: InstalledPluginRecord,
  registration: CatalogExtensionRegistration
): CatalogExtensionRegistration {
  return Object.freeze({
    packageId: registration.packageId,
    descriptor: pluginDescriptor(record.manifest, record.trust.capabilities),
    module: filterAndVerifyModule(record, registration.module),
  })
}

function filterAndVerifyModule(
  record: InstalledPluginRecord,
  module: ExtensionModule
): ExtensionModule {
  const expected = new Map(
    record.manifest.contributions.map((item) => [
      contributionKey(item.point, item.id, item.version),
      item,
    ])
  )
  const disabled = new Set(
    record.disabledContributions.map((item) =>
      contributionKey(item.point, item.id, item.version)
    )
  )
  const disabledIds = new Set(
    record.disabledContributions.map((item) => item.id)
  )
  return Object.freeze({
    register(api: ExtensionRegistrationApi): unknown {
      const actual = new Set<string>()
      const filtered: ExtensionRegistrationApi = {
        provide<Service>(
          ref: ServiceRef<Service>,
          factory: ServiceFactory<Service>
        ): void {
          api.provide(ref, factory)
        },
        contribute<Value>(
          ref: ContributionRef<Value>,
          registration: ContributionRegistration<Value>
        ): void {
          const key = contributionKey(ref.id, registration.id, ref.version)
          if (!expected.has(key)) {
            throw new PluginBootstrapError(
              `Plugin ${record.manifest.id} registered undeclared contribution ${ref.id}:${registration.id}@${ref.version}.`
            )
          }
          if (actual.has(key)) {
            throw new PluginBootstrapError(
              `Plugin ${record.manifest.id} registered contribution ${ref.id}:${registration.id} more than once.`
            )
          }
          actual.add(key)
          if (!disabled.has(key)) api.contribute(ref, registration)
        },
        bind<Binding>(
          ref: ExecutableBindingRef<Binding>,
          registration: ExecutableBindingRegistration<Binding>
        ): void {
          if (!disabledIds.has(registration.targetId))
            api.bind(ref, registration)
        },
        handle<Input, Output, Mode extends HookMode>(
          ref: HookRef<Input, Output, Mode>,
          registration: HookHandlerRegistration<Input, Output>
        ): void {
          api.handle(ref, registration)
        },
      }
      const result = module.register(filtered)
      const missing = [...expected.keys()].filter((key) => !actual.has(key))
      if (missing.length > 0) {
        throw new PluginBootstrapError(
          `Plugin ${record.manifest.id} did not register every declared contribution: ${missing.join(', ')}.`
        )
      }
      return result
    },
  })
}

function contributionKey(point: string, id: string, version: number): string {
  return `${point}\0${id}\0${version}`
}

async function resolvePackageEntry(
  packageDirectory: string,
  relativeEntry: string
): Promise<string> {
  const root = await realpath(packageDirectory)
  const candidate = path.resolve(root, relativeEntry)
  const relative = path.relative(root, candidate)
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PluginBootstrapError(
      'Plugin entry must remain inside its package directory.'
    )
  }
  const resolved = await realpath(candidate)
  const resolvedRelative = path.relative(root, resolved)
  if (
    resolvedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(resolvedRelative)
  ) {
    throw new PluginBootstrapError(
      'Plugin entry resolves outside its package directory.'
    )
  }
  const stats = await lstat(resolved)
  if (!stats.isFile()) {
    throw new PluginBootstrapError('Plugin entry must be a regular file.')
  }
  return resolved
}

function parsePortalPluginModule(
  imported: unknown,
  packageId: string
): PortalPluginModule {
  if (!isRecord(imported) || !isRecord(imported.portalPlugin)) {
    throw new PluginBootstrapError(
      `Plugin ${packageId} must export a portalPlugin object.`
    )
  }
  const plugin = imported.portalPlugin
  if (!isDescriptor(plugin.descriptor)) {
    throw new PluginBootstrapError(
      `Plugin ${packageId} exports an invalid descriptor.`
    )
  }
  const extensionValue = plugin.extension
  if (!isExtensionModule(extensionValue)) {
    throw new PluginBootstrapError(
      `Plugin ${packageId} exports an invalid extension module.`
    )
  }
  const extension: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): unknown {
      return extensionValue.register(api)
    },
  })
  return Object.freeze({
    descriptor: Object.freeze({
      id: plugin.descriptor.id,
      version: plugin.descriptor.version,
      dependencies: Object.freeze([...plugin.descriptor.dependencies]),
      capabilities: Object.freeze([...plugin.descriptor.capabilities]),
    }),
    extension,
  })
}

function assertDescriptorMatches(
  actual: ExtensionDescriptor,
  expected: ExtensionDescriptor
): void {
  if (
    actual.id !== expected.id ||
    actual.version !== expected.version ||
    !sameStrings(actual.dependencies, expected.dependencies) ||
    !sameStrings(actual.capabilities, expected.capabilities)
  ) {
    throw new PluginBootstrapError(
      `Loaded plugin descriptor does not match manifest for ${expected.id}.`
    )
  }
}

function isDescriptor(value: unknown): value is ExtensionDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    isStringArray(value.dependencies) &&
    isStringArray(value.capabilities)
  )
}

function isExtensionModule(value: unknown): value is ExtensionModule {
  return isRecord(value) && typeof value.register === 'function'
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function importDirectModule(specifier: string): Promise<unknown> {
  return await import(specifier)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
