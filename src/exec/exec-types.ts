import type { ResolvedProviderModel } from '../providers/provider-model-catalog.ts'
import type { ProviderId } from '../providers/provider-id.ts'

export type ExecProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'tool'; name: string }

export interface PortalExecSessionOptions {
  cwd: string
  dataDirectory?: string
  browserEngine?: string
  browserExecutablePath?: string
  browserRemoteDebuggingPort?: number
  provider: ProviderId
  model: ResolvedProviderModel | null
  signal: AbortSignal
  onProgress: (event: ExecProgressEvent) => void
}

export interface PortalExecSession {
  run(task: string, signal: AbortSignal): Promise<string>
  close(): Promise<void>
}

export type PortalExecSessionFactory = (
  options: PortalExecSessionOptions
) => Promise<PortalExecSession>
