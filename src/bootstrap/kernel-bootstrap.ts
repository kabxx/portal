import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  ExtensionDescriptor,
  ExtensionRegistrationApi,
  ExtensionModule,
} from '../extensions/extension-contracts.ts'
import { pluginDescriptor } from '../extensions/plugin-contracts.ts'
import type {
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

  public constructor(options: {
    readonly manager: PluginManager
    readonly importModule?: (specifier: string) => Promise<unknown>
  }) {
    this.#manager = options.manager
    this.#importModule = options.importModule ?? importDirectModule
  }

  public async prepare(): Promise<KernelPluginPlan> {
    const snapshot = await this.#manager.resolveEnabled()
    if (snapshot.diagnostics.length > 0) {
      throw new PluginBootstrapError(
        `Plugin graph validation failed with ${snapshot.diagnostics.length} diagnostic(s).`,
        snapshot.diagnostics
      )
    }

    const extensions: CatalogExtensionRegistration[] = []
    for (const record of snapshot.packages) {
      extensions.push(await this.#load(record))
    }
    return Object.freeze({
      generation: snapshot.generation,
      snapshot,
      extensions: Object.freeze(extensions),
    })
  }

  async #load(
    record: InstalledPluginRecord
  ): Promise<CatalogExtensionRegistration> {
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
      descriptor: plugin.descriptor,
      module: plugin.extension,
    })
  }
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
