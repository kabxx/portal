import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import type { ProviderId } from '../providers/provider-id.ts'

export const DEFAULT_THREAD_HISTORY_LIMIT = 5
export const MIN_THREAD_HISTORY_LIMIT = 1
export const MAX_THREAD_HISTORY_LIMIT = 100

export interface ThreadHistoryEntry {
  id: number
  provider: ProviderId
  conversationUrl: string
  title: string | null
  createdAt: string
  lastUsedAt: string
}

export interface CreateThreadHistoryEntryInput {
  provider: ProviderId
  conversationUrl: string
  title?: string | null
  createdAt?: number | Date | string
  lastUsedAt?: number | Date | string
}

interface ThreadHistoryRow {
  id: number
  provider: ProviderId
  conversation_url: string
  title: string | null
  created_at: string
  last_used_at: string
}

export class ThreadStore {
  private db: DatabaseType | null = null

  public constructor(private readonly storagePath: string) {}

  public initialize(): void {
    void this.database
  }

  public async append(input: CreateThreadHistoryEntryInput): Promise<void> {
    this.upsert(input)
  }

  public async touch(
    input: CreateThreadHistoryEntryInput
  ): Promise<ThreadHistoryEntry> {
    return this.upsert(input)
  }

  public async setTitleIfEmpty(input: {
    conversationUrl: string
    title: string
    lastUsedAt?: number | Date | string
  }): Promise<void> {
    const normalizedTitle = normalizeTitle(input.title)
    const lastUsedAt = normalizeDate(input.lastUsedAt ?? Date.now())
    this.database
      .prepare(
        [
          'UPDATE thread_history',
          'SET title = CASE WHEN title IS NULL THEN @title ELSE title END,',
          'last_used_at = @lastUsedAt',
          'WHERE conversation_url = @conversationUrl',
        ].join(' ')
      )
      .run({
        conversationUrl: input.conversationUrl,
        title: normalizedTitle,
        lastUsedAt,
      })
  }

  public async getById(id: number): Promise<ThreadHistoryEntry | null> {
    const row = this.database
      .prepare<
        [number],
        ThreadHistoryRow
      >('SELECT * FROM thread_history WHERE id = ?')
      .get(id)

    return row === undefined ? null : mapRow(row)
  }

  public async list(
    limit = DEFAULT_THREAD_HISTORY_LIMIT
  ): Promise<ThreadHistoryEntry[]> {
    const safeLimit = normalizeLimit(limit)
    const rows = this.database
      .prepare<
        [number],
        ThreadHistoryRow
      >(['SELECT * FROM thread_history', 'ORDER BY last_used_at DESC, id DESC', 'LIMIT ?'].join(' '))
      .all(safeLimit)

    return rows.map(mapRow)
  }

  public close(): void {
    this.db?.close()
    this.db = null
  }

  private upsert(input: CreateThreadHistoryEntryInput): ThreadHistoryEntry {
    const createdAt = normalizeDate(input.createdAt ?? Date.now())
    const lastUsedAt = normalizeDate(input.lastUsedAt ?? Date.now())
    const title =
      input.title === undefined || input.title === null
        ? null
        : normalizeTitle(input.title)

    const values = {
      provider: input.provider,
      conversationUrl: input.conversationUrl,
      title,
      createdAt,
      lastUsedAt,
    }

    const transaction = this.database.transaction(() => {
      const update = this.database
        .prepare(
          [
            'UPDATE thread_history',
            'SET provider = @provider,',
            'title = COALESCE(title, @title),',
            'last_used_at = @lastUsedAt',
            'WHERE conversation_url = @conversationUrl',
          ].join(' ')
        )
        .run(values)

      if (update.changes === 0) {
        this.database
          .prepare(
            [
              'INSERT INTO thread_history',
              '(provider, conversation_url, title, created_at, last_used_at)',
              'VALUES (@provider, @conversationUrl, @title, @createdAt, @lastUsedAt)',
            ].join(' ')
          )
          .run(values)
      }

      const row = this.database
        .prepare<
          [string],
          ThreadHistoryRow
        >('SELECT * FROM thread_history WHERE conversation_url = ?')
        .get(input.conversationUrl)
      if (row === undefined) {
        throw new Error('Thread history upsert did not return a row.')
      }
      return mapRow(row)
    })

    return transaction()
  }

  private get database(): DatabaseType {
    if (this.db !== null) {
      return this.db
    }

    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    const database = new Database(this.storagePath)
    try {
      database.pragma('journal_mode = WAL')
      database.exec(`
        CREATE TABLE IF NOT EXISTS thread_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          conversation_url TEXT NOT NULL UNIQUE,
          title TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_thread_history_last_used_at
          ON thread_history(last_used_at DESC);
      `)
    } catch (error) {
      database.close()
      throw error
    }
    this.db = database
    return database
  }
}

export function parseThreadHistoryLimit(raw: string | undefined): {
  limit: number | null
  error: string | null
} {
  if (raw === undefined) {
    return { limit: DEFAULT_THREAD_HISTORY_LIMIT, error: null }
  }

  if (!/^\d+$/.test(raw)) {
    return {
      limit: null,
      error: `Invalid limit: ${raw}. Usage: /thread history [limit]`,
    }
  }

  const limit = Number(raw)
  if (limit < MIN_THREAD_HISTORY_LIMIT || limit > MAX_THREAD_HISTORY_LIMIT) {
    return {
      limit: null,
      error: `Limit must be between ${MIN_THREAD_HISTORY_LIMIT} and ${MAX_THREAD_HISTORY_LIMIT}.`,
    }
  }

  return { limit, error: null }
}

export function parseThreadHistoryId(raw: string): number | null {
  if (!/^#\d+$/.test(raw)) {
    return null
  }

  const id = Number(raw.slice(1))
  if (!Number.isSafeInteger(id) || id < 1) {
    return null
  }

  return id
}

export function buildThreadHistoryTitle(input: string, maxLength = 60): string {
  return normalizePreview(input, maxLength)
}

export async function createThreadStore(
  storagePath: string
): Promise<ThreadStore> {
  const store = new ThreadStore(storagePath)
  store.initialize()
  return store
}

function normalizeLimit(limit: number): number {
  return Math.min(
    Math.max(Math.trunc(limit), MIN_THREAD_HISTORY_LIMIT),
    MAX_THREAD_HISTORY_LIMIT
  )
}

function normalizeTitle(title: string): string {
  return normalizePreview(title, 60)
}

function normalizePreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return '(empty)'
  }
  if (normalized.length <= maxLength) {
    return normalized
  }
  return normalized.slice(0, Math.max(maxLength - 3, 0)) + '...'
}

function normalizeDate(value: number | Date | string): string {
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString()
  }
  return value
}

function mapRow(row: ThreadHistoryRow): ThreadHistoryEntry {
  return {
    id: row.id,
    provider: row.provider,
    conversationUrl: row.conversation_url,
    title: row.title,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}
