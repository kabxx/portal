import type { ThreadCreationMode } from '../threads/thread-creation-mode.ts'

export interface PortalMcpJobSummary {
  readonly id: string
  readonly pid: number | null
  readonly state: string
  readonly startedAt: number
  readonly shell: string
  readonly cwd: string
  readonly command: string
}

export type PortalMcpThreadSummary = {
  id: string
  provider: string
  title: string | null
  conversationUrl: string
  busy: boolean
  turnCount: number
  createdAt: number
  updatedAt: number
}

export type PortalMcpMessageStatus =
  'running' | 'completed' | 'failed' | 'cancelled'

export type PortalMcpMessageOperation = {
  operationId: string
  threadId: string
  status: PortalMcpMessageStatus
  assistant?: string
  error?: string
}

export interface PortalMcpHandlers {
  listProviders(): Promise<{ providers: string[] }> | { providers: string[] }
  listJobs?():
    Promise<{ jobs: PortalMcpJobSummary[] }> | { jobs: PortalMcpJobSummary[] }
  stopJob?(
    jobId: string,
    signal: AbortSignal
  ): Promise<{ stopped: true; jobId: string }>
  listThreads():
    | Promise<{ threads: PortalMcpThreadSummary[] }>
    | { threads: PortalMcpThreadSummary[] }
  getThread(threadId: string): Promise<PortalMcpThreadSummary>
  createThread(
    input: {
      provider: string
      model: string | null
      option: string | null
      mode: ThreadCreationMode
    },
    signal: AbortSignal
  ): Promise<PortalMcpThreadSummary>
  resumeThread(
    conversationUrl: string,
    signal: AbortSignal
  ): Promise<PortalMcpThreadSummary>
  closeThread(threadId: string): Promise<{ closed: true; threadId: string }>
  sendMessage(
    threadId: string,
    input: string
  ): Promise<PortalMcpMessageOperation>
  waitMessage(
    operationId: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<PortalMcpMessageOperation>
  cancelMessage(operationId: string): Promise<PortalMcpMessageOperation>
}
