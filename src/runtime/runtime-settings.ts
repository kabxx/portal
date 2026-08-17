export interface PortalRuntimeSettings {
  spawnDepthLimit: number
}

export function createPortalRuntimeSettings(): PortalRuntimeSettings {
  return { spawnDepthLimit: 3 }
}
