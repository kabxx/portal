import { createServiceRef } from './extension-contracts.ts'
import type {
  InstalledPluginRecord,
  PluginContributionDeclaration,
  PluginDiagnostic,
} from './plugin-contracts.ts'
import type {
  AddLocalPluginOptions,
  PluginManager,
  UpdateLocalPluginOptions,
} from './plugin-manager.ts'

export interface PluginManagementService {
  list(): Promise<readonly InstalledPluginRecord[]>
  inspect(id: string): Promise<InstalledPluginRecord | null>
  addLocalDirectories(
    sourceDirectories: readonly string[],
    options?: AddLocalPluginOptions
  ): Promise<readonly InstalledPluginRecord[]>
  updateLocalDirectory(
    id: string,
    options?: UpdateLocalPluginOptions
  ): Promise<InstalledPluginRecord | null>
  enable(id: string): Promise<boolean>
  disable(id: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  diagnose(): Promise<readonly PluginDiagnostic[]>
  setContributionEnabled(
    packageId: string,
    point: string,
    contributionId: string,
    enabled: boolean
  ): Promise<boolean>
}

export const pluginManagementService =
  createServiceRef<PluginManagementService>({
    id: 'portal.plugins.management',
    version: 1,
    scope: 'portal',
  })

export function createPluginManagementService(
  manager: PluginManager
): PluginManagementService {
  const service: PluginManagementService = {
    list: async () => await manager.list(),
    inspect: async (id) => await manager.inspect(id),
    addLocalDirectories: async (sourceDirectories, options) =>
      await manager.addLocalDirectories(sourceDirectories, options),
    updateLocalDirectory: async (id, options) =>
      await manager.updateLocalDirectory(id, options),
    enable: async (id) => await manager.enable(id),
    disable: async (id) => await manager.disable(id),
    remove: async (id) => await manager.remove(id),
    diagnose: async () => await manager.diagnose(),
    setContributionEnabled: async (packageId, point, contributionId, enabled) =>
      await manager.setContributionEnabled(
        packageId,
        point,
        contributionId,
        enabled
      ),
  }
  return Object.freeze(service)
}

export function contributionLabel(
  contribution: PluginContributionDeclaration
): string {
  return `${contribution.point}:${contribution.id}`
}
