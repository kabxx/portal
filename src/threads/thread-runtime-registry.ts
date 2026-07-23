import type { ProviderId } from '../providers/provider-id.ts'
import {
  type PreparedThread,
  type ThreadSnapshot,
  type ThreadState,
} from './thread-types.ts'

export interface ThreadRuntimeEntry<TRuntime = unknown> {
  readonly snapshot: ThreadSnapshot
  readonly provider: ProviderId
  readonly runtime: TRuntime
}

export class ConversationUrlError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ConversationUrlError'
  }
}

export class InvalidConversationUrlError extends ConversationUrlError {
  public constructor(url: string) {
    super(`Invalid conversation URL: ${url}`)
    this.name = 'InvalidConversationUrlError'
  }
}

export class ConversationAlreadyClaimedError extends ConversationUrlError {
  public constructor(
    public readonly url: string,
    public readonly threadId: string
  ) {
    super(`Conversation URL is already open in thread ${threadId}: ${url}`)
    this.name = 'ConversationAlreadyClaimedError'
  }
}

export class ConversationReservationError extends ConversationUrlError {
  public constructor(
    public readonly url: string,
    public readonly ownerId: string
  ) {
    super(`Conversation URL is reserved by operation ${ownerId}: ${url}`)
    this.name = 'ConversationReservationError'
  }
}

export class ThreadAlreadyRegisteredError extends Error {
  public constructor(public readonly threadId: string) {
    super(`Thread ${threadId} is already registered.`)
    this.name = 'ThreadAlreadyRegisteredError'
  }
}

export class ThreadStateTransitionError extends Error {
  public constructor(
    public readonly threadId: string,
    public readonly from: ThreadState,
    public readonly to: ThreadState
  ) {
    super(`Thread ${threadId} cannot transition from ${from} to ${to}.`)
    this.name = 'ThreadStateTransitionError'
  }
}

export class ThreadRemovalStateError extends Error {
  public constructor(
    public readonly threadId: string,
    public readonly state: ThreadState
  ) {
    super(`Thread ${threadId} cannot be removed while it is ${state}.`)
    this.name = 'ThreadRemovalStateError'
  }
}

export class ThreadRuntimeRegistry<TRuntime = unknown> {
  private readonly entries = new Map<string, ThreadRuntimeEntry<TRuntime>>()
  private readonly reservations = new Map<string, string>()
  private readonly claimedUrls = new Map<string, string>()
  private nextThreadNumber = 1

  public createThreadId(): string {
    let id: string
    do {
      id = `t-${this.nextThreadNumber}`
      this.nextThreadNumber += 1
    } while (this.entries.has(id))
    return id
  }

  /**
   * Reserve a known remote conversation before opening its provider page.
   * Reservations are process-local and are released by release/commit/remove.
   */
  public reserveConversationUrl(ownerId: string, url: string): string {
    const canonical = requireCanonicalUrl(url)
    const claimedBy = this.claimedUrls.get(canonical)
    if (claimedBy !== undefined && claimedBy !== ownerId) {
      throw new ConversationAlreadyClaimedError(canonical, claimedBy)
    }
    const reservedBy = this.reservations.get(canonical)
    if (reservedBy !== undefined && reservedBy !== ownerId) {
      throw new ConversationReservationError(canonical, reservedBy)
    }
    this.reservations.set(canonical, ownerId)
    return canonical
  }

  public releaseConversationUrl(ownerId: string, url: string): boolean {
    const canonical = requireCanonicalUrl(url)
    if (this.reservations.get(canonical) !== ownerId) {
      return false
    }
    this.reservations.delete(canonical)
    return true
  }

  /** Claim is intentionally synchronous so commit can be the linearization point. */
  public claimConversationUrl(
    ownerId: string,
    url: string,
    threadId = ownerId
  ): string {
    const canonical = requireCanonicalUrl(url)
    const claimedBy = this.claimedUrls.get(canonical)
    if (claimedBy !== undefined && claimedBy !== threadId) {
      throw new ConversationAlreadyClaimedError(canonical, claimedBy)
    }
    const reservedBy = this.reservations.get(canonical)
    if (reservedBy !== undefined && reservedBy !== ownerId) {
      throw new ConversationReservationError(canonical, reservedBy)
    }
    this.claimedUrls.set(canonical, threadId)
    this.reservations.delete(canonical)
    return canonical
  }

  /**
   * Atomically claims the conversation identity and admits the prepared runtime.
   * There is no await in this method; callers own compensation on thrown errors.
   */
  public commitPrepared(input: PreparedThread<TRuntime>): ThreadSnapshot {
    if (this.entries.has(input.id)) {
      throw new ThreadAlreadyRegisteredError(input.id)
    }

    const reservationOwnerId = input.reservationOwnerId ?? input.id
    const canonicalUrl =
      input.conversationUrl === undefined || input.conversationUrl === null
        ? null
        : this.claimConversationUrl(
            reservationOwnerId,
            input.conversationUrl,
            input.id
          )
    const createdAt = input.createdAt ?? Date.now()
    const snapshot: ThreadSnapshot = {
      id: input.id,
      provider: input.provider,
      origin: input.origin,
      source: input.source,
      state: 'idle',
      title: input.title ?? null,
      conversationId: input.conversationId ?? null,
      conversationUrl: canonicalUrl,
      history: input.history ?? { status: 'not_loaded' },
      createdAt,
      updatedAt: createdAt,
    }
    this.entries.set(input.id, {
      snapshot,
      provider: input.provider,
      runtime: input.runtime,
    })
    this.releaseReservationsByOwner(reservationOwnerId)
    return cloneSnapshot(snapshot)
  }

  public get(threadId: string): ThreadRuntimeEntry<TRuntime> | null {
    const entry = this.entries.get(threadId)
    return entry === undefined ? null : cloneEntry(entry)
  }

  public getSnapshot(threadId: string): ThreadSnapshot | null {
    return this.get(threadId)?.snapshot ?? null
  }

  public getThreadIdByConversationUrl(url: string): string | null {
    const canonical = canonicalizeConversationUrl(url)
    return canonical === null ? null : (this.claimedUrls.get(canonical) ?? null)
  }

  public list(): readonly ThreadRuntimeEntry<TRuntime>[] {
    return [...this.entries.values()]
      .sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt)
      .map(cloneEntry)
  }

  public setState(threadId: string, state: ThreadState): ThreadSnapshot | null {
    const entry = this.entries.get(threadId)
    if (entry === undefined) {
      return null
    }
    const current = entry.snapshot.state
    if (current === state) {
      return cloneSnapshot(entry.snapshot)
    }
    if (!STATE_TRANSITIONS[current].has(state)) {
      throw new ThreadStateTransitionError(threadId, current, state)
    }
    entry.snapshot.state = state
    entry.snapshot.updatedAt = Date.now()
    return cloneSnapshot(entry.snapshot)
  }

  public updateConversationIdentity(
    threadId: string,
    identity: {
      conversationId?: string | null
      conversationUrl?: string | null
    }
  ): ThreadSnapshot | null {
    const entry = this.entries.get(threadId)
    if (entry === undefined) {
      return null
    }
    if (identity.conversationUrl !== undefined) {
      const current = entry.snapshot.conversationUrl
      const canonical =
        identity.conversationUrl === null
          ? null
          : this.claimConversationUrl(threadId, identity.conversationUrl)
      if (current !== null && current !== canonical) {
        this.claimedUrls.delete(current)
      }
      entry.snapshot.conversationUrl = canonical
    }
    if (identity.conversationId !== undefined) {
      entry.snapshot.conversationId = identity.conversationId
    }
    entry.snapshot.updatedAt = Date.now()
    return cloneSnapshot(entry.snapshot)
  }

  public remove(threadId: string): ThreadRuntimeEntry<TRuntime> | null {
    const entry = this.entries.get(threadId)
    if (entry === undefined) {
      return null
    }
    if (entry.snapshot.state !== 'closing') {
      throw new ThreadRemovalStateError(threadId, entry.snapshot.state)
    }
    this.entries.delete(threadId)
    const url = entry.snapshot.conversationUrl
    if (url !== null && this.claimedUrls.get(url) === threadId) {
      this.claimedUrls.delete(url)
    }
    this.releaseReservationsByOwner(threadId)
    entry.snapshot.state = 'closed'
    entry.snapshot.updatedAt = Date.now()
    return cloneEntry(entry)
  }

  public has(threadId: string): boolean {
    return this.entries.has(threadId)
  }

  private releaseReservationsByOwner(ownerId: string): void {
    for (const [reservedUrl, reservedBy] of this.reservations) {
      if (reservedBy === ownerId) {
        this.reservations.delete(reservedUrl)
      }
    }
  }
}

const STATE_TRANSITIONS: Record<ThreadState, ReadonlySet<ThreadState>> = {
  idle: new Set(['running', 'closing']),
  running: new Set(['idle', 'cancelling', 'closing']),
  cancelling: new Set(['idle', 'closing']),
  closing: new Set(['closed']),
  closed: new Set(),
}

export function canonicalizeConversationUrl(
  value: string | URL
): string | null {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    url.hash = ''
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '')
    }
    return url.toString()
  } catch {
    return null
  }
}

function requireCanonicalUrl(value: string): string {
  const canonical = canonicalizeConversationUrl(value)
  if (canonical === null) {
    throw new InvalidConversationUrlError(value)
  }
  return canonical
}

function cloneSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    ...snapshot,
    history: { ...snapshot.history },
  }
}

function cloneEntry<TRuntime>(
  entry: ThreadRuntimeEntry<TRuntime>
): ThreadRuntimeEntry<TRuntime> {
  return {
    snapshot: cloneSnapshot(entry.snapshot),
    provider: entry.provider,
    runtime: entry.runtime,
  }
}
