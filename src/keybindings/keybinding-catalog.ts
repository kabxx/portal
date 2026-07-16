import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

import {
  readPortalKeybindings,
  resetPortalKeybindings,
} from '../config/portal-config.ts'
import {
  createDefaultKeybindings,
  createKeybindingSnapshot,
  resolveKeybindingAction,
  type KeybindingAction,
  type KeybindingConfig,
  type KeybindingInputEvent,
  type KeybindingSnapshot,
} from './keybinding-config.ts'

export type KeybindingCatalogIssue = (
  level: 'error' | 'warning',
  message: string
) => void

export class KeybindingCatalog {
  private current: KeybindingSnapshot
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private tail: Promise<void> = Promise.resolve()
  private lastIssue: string | null = null
  private stopped = false

  public constructor(
    private readonly configPath: string,
    initial: KeybindingConfig,
    private readonly onIssue: KeybindingCatalogIssue,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly debounceMs = 150
  ) {
    this.current = createKeybindingSnapshot(initial)
  }

  public snapshot(): KeybindingSnapshot {
    return this.current
  }

  public resolve(
    input: string,
    key: KeybindingInputEvent
  ): KeybindingAction | null {
    return resolveKeybindingAction(this.current, input, key)
  }

  public start(): void {
    if (this.stopped || this.watcher !== null) {
      return
    }
    try {
      this.watcher = watch(
        path.dirname(this.configPath),
        (_event, filename) => {
          if (!shouldReloadKeybindings(filename, this.configPath)) {
            return
          }
          this.scheduleReload()
        }
      )
      this.watcher.on('error', (error) => {
        this.stopWatching()
        this.report('warning', `Keybinding watcher stopped: ${error.message}`)
      })
    } catch (error) {
      this.stopWatching()
      this.report(
        'warning',
        `Keybinding watcher stopped: ${getErrorMessage(error)}`
      )
    }
  }

  public async reload(): Promise<KeybindingSnapshot> {
    return await this.enqueue(async () => {
      const bindings = await readPortalKeybindings(this.configPath)
      const next = createKeybindingSnapshot(bindings)
      if (!this.stopped) {
        this.current = next
        this.lastIssue = null
      }
      return next
    })
  }

  public async reset(): Promise<KeybindingSnapshot> {
    return await this.enqueue(async () => {
      const bindings = await resetPortalKeybindings(
        this.configPath,
        createDefaultKeybindings(this.platform)
      )
      const next = createKeybindingSnapshot(bindings)
      if (!this.stopped) {
        this.current = next
        this.lastIssue = null
      }
      return next
    })
  }

  public stop(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.stopWatching()
  }

  private scheduleReload(): void {
    if (this.stopped) {
      return
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.reload().catch((error) => {
        if (!this.stopped) {
          this.report('error', getErrorMessage(error))
        }
      })
    }, this.debounceMs)
  }

  private stopWatching(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private report(level: 'error' | 'warning', message: string): void {
    if (this.stopped || message === this.lastIssue) {
      return
    }
    this.lastIssue = message
    this.onIssue(level, message)
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      throw new Error('Keybinding catalog is stopped')
    }
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }
}

export function shouldReloadKeybindings(
  filename: string | Buffer | null,
  configPath: string
): boolean {
  return (
    filename === null ||
    path.basename(filename.toString()) === path.basename(configPath)
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
