import path from 'node:path'

import {
  createDefaultPortalConfig,
  readPortalConfig,
  updatePortalConfig,
} from '../config/portal-config.ts'
import { createHookSnapshot } from './hook-config.ts'
import type { HookSnapshot } from './hook-types.ts'

export class HookCatalog {
  private current: HookSnapshot

  public constructor(
    private readonly configPath: string,
    initial: HookSnapshot
  ) {
    this.current = initial
  }

  public static async create(configPath: string): Promise<HookCatalog> {
    const config = await readPortalConfig(configPath)
    if (config === null)
      throw new Error(`Portal config does not exist: ${configPath}`)
    return new HookCatalog(configPath, createHookSnapshot(config.hooks))
  }

  public snapshot(): HookSnapshot {
    return this.current
  }

  public status(): {
    enabled: boolean
    revision: string
    loadedAt: number
    handlers: number
    activeHandlers: number
  } {
    return {
      enabled: this.current.enabled,
      revision: this.current.revision,
      loadedAt: this.current.loadedAt,
      handlers: this.current.handlers.length,
      activeHandlers: this.current.handlers.filter((handler) => handler.enabled)
        .length,
    }
  }

  public async reload(): Promise<HookSnapshot> {
    const config = await readPortalConfig(this.configPath)
    if (config === null)
      throw new Error(`Portal config does not exist: ${this.configPath}`)
    const next = createHookSnapshot(config.hooks)
    this.current = next
    return next
  }

  public async setEnabled(enabled: boolean): Promise<HookSnapshot> {
    await updatePortalConfig(
      this.configPath,
      (config) => {
        config.hooks.enabled = enabled
      },
      createDefaultPortalConfig(path.dirname(this.configPath))
    )
    return await this.reload()
  }
}
