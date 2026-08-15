import type { RuntimeSetupMode } from './setup-handshake.ts'
import type { ThreadCreationMode } from '../threads/thread-creation-mode.ts'

export interface PortalRuntimeSettings {
  spawnDepthLimit: number
}

export function createPortalRuntimeSettings(): PortalRuntimeSettings {
  return { spawnDepthLimit: 3 }
}

export function runtimeSetupModeForThreadCreation(
  mode: ThreadCreationMode
): Exclude<RuntimeSetupMode, 'skip' | 'inline'> {
  return mode === 'chat' ? 'handshake' : 'full'
}
