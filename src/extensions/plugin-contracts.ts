import type { ExtensionDescriptor } from './extension-contracts.ts'

export type PluginUpdatePolicy =
  'pinned' | 'trust-source' | 'trust-publisher' | 'trust-all-manual-adds'

export type PluginCapabilityExpansionPolicy = 'auto-allow' | 'deny' | 'ask'

export interface PluginDependency {
  readonly id: string
  readonly versionRange: string
}

export interface PluginContributionDeclaration {
  readonly point: string
  readonly id: string
  readonly version: number
}

/** Data that may be inspected before any package code is executed. */
export interface PluginManifest {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly entry: string
  readonly dependencies: readonly PluginDependency[]
  readonly contributions: readonly PluginContributionDeclaration[]
  readonly capabilities: readonly string[]
  readonly configSchema?: string
}

export interface PluginTrustGrant {
  readonly capabilities: readonly string[]
  readonly updatePolicy: PluginUpdatePolicy
  readonly capabilityExpansion: PluginCapabilityExpansionPolicy
}

export interface PluginSourceRecord {
  readonly kind: 'local-directory' | 'package-archive'
  readonly locator: string
  readonly digest: string
}

export interface InstalledPluginRecord {
  readonly manifest: PluginManifest
  readonly source: PluginSourceRecord
  readonly trust: PluginTrustGrant
  readonly enabled: boolean
  readonly installedAt: string
  readonly updatedAt: string
}

export interface PluginStoreDocument {
  readonly schemaVersion: 1
  readonly packages: readonly InstalledPluginRecord[]
}

export interface PluginDiagnostic {
  readonly packageId: string
  readonly code:
    | 'invalid-record'
    | 'source-missing'
    | 'digest-mismatch'
    | 'missing-dependency'
    | 'disabled-dependency'
    | 'dependency-cycle'
    | 'version-mismatch'
    | 'api-version-unsupported'
  readonly message: string
}

export interface PluginResolutionSnapshot {
  readonly generation: string
  readonly packages: readonly InstalledPluginRecord[]
  readonly diagnostics: readonly PluginDiagnostic[]
}

export function pluginDescriptor(
  manifest: PluginManifest
): ExtensionDescriptor {
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    dependencies: Object.freeze(manifest.dependencies.map((item) => item.id)),
    capabilities: manifest.capabilities,
  })
}
