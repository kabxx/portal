import type { ProviderId } from '../providers/provider-id.ts'

/** State of a thread after it has been admitted to the runtime registry. */
export type ThreadState =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'closing'
  | 'closed'

export type ThreadOrigin = 'new' | 'resumed'

export type ThreadSource = 'tui' | 'api' | 'mcp' | 'spawn' | 'hook' | 'system'

export interface ThreadSnapshot {
  id: string
  provider: ProviderId
  origin: ThreadOrigin
  source: ThreadSource
  state: ThreadState
  title: string | null
  conversationId: string | null
  conversationUrl: string | null
  history: HistoryQuality
  createdAt: number
  updatedAt: number
}

export type HistoryQuality =
  | { status: 'not_loaded' }
  | { status: 'complete' }
  | { status: 'incomplete'; reasonCode: string; message: string }

export interface PreparedThread<TRuntime = unknown> {
  id: string
  reservationOwnerId?: string
  provider: ProviderId
  runtime: TRuntime
  origin: ThreadOrigin
  source: ThreadSource
  title?: string | null
  conversationId?: string | null
  conversationUrl?: string | null
  history?: HistoryQuality
  createdAt?: number
}
