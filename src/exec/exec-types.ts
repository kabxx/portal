export type ExecProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'tool'; name: string }

export interface PortalExecSessionOptions {
  cwd: string
  dataDirectory?: string
  browserExecutablePath?: string
  provider: string
  model: string | null
  option?: string | null
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
