import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import type { ProviderId } from '../providers/provider-id.ts'

export const DEFAULT_THREAD_HISTORY_LIMIT = 5
export const MIN_THREAD_HISTORY_LIMIT = 1
export const MAX_THREAD_HISTORY_LIMIT = 100
export const THREAD_STORE_SCHEMA_VERSION = 1

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
          'UPDATE threads',
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
      .prepare<[number], ThreadHistoryRow>('SELECT * FROM threads WHERE id = ?')
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
      >(['SELECT * FROM threads', 'ORDER BY last_used_at DESC, id DESC', 'LIMIT ?'].join(' '))
      .all(safeLimit)

    return rows.map(mapRow)
  }

  public close(): void {
    this.db?.close()
    this.db = null
  }

  public getSchemaVersion(): number {
    const row = this.database
      .prepare<
        [],
        { version: number }
      >('SELECT version FROM schema_version WHERE id = 1')
      .get()
    if (row === undefined) {
      throw new ThreadStoreSchemaError(
        'Thread store schema version is missing.'
      )
    }
    return row.version
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
            'UPDATE threads',
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
              'INSERT INTO threads',
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
        >('SELECT * FROM threads WHERE conversation_url = ?')
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
      initializeSchema(database)
    } catch (error) {
      database.close()
      throw error
    }
    this.db = database
    return database
  }
}

export class ThreadStoreSchemaError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ThreadStoreSchemaError'
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

interface SqliteTableRow {
  name: string
}

interface SqliteColumnRow {
  name: string
  type: string
  notnull: 0 | 1
  pk: 0 | 1
}

interface SqliteIndexRow {
  name: string
  unique: 0 | 1
}

interface SqliteIndexColumnRow {
  name: string | null
}

interface ExpectedColumn {
  name: string
  type: string
  notnull: 0 | 1
  pk: 0 | 1
}

const LEGACY_THREAD_HISTORY_COLUMNS = [
  'id',
  'provider',
  'conversation_url',
  'title',
  'created_at',
  'last_used_at',
] as const

const CURRENT_THREADS_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'provider', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'conversation_url', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'last_used_at', type: 'TEXT', notnull: 1, pk: 0 },
]

const CURRENT_SCHEMA_VERSION_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
]

function initializeSchema(database: DatabaseType): void {
  const tables = database
    .prepare<[], SqliteTableRow>(
      [
        'SELECT name FROM sqlite_master',
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        'ORDER BY name',
      ].join(' ')
    )
    .all()
    .map(({ name }) => name)

  if (tables.length === 0) {
    database.transaction(() => createSchema(database))()
    return
  }

  if (isCurrentSchema(tables)) {
    validateCurrentSchema(database)
    return
  }

  if (tables.length === 1 && tables[0] === 'thread_history') {
    validateLegacySchema(database)
    const reset = database.transaction(() => {
      database.exec('DROP TABLE thread_history;')
      createSchema(database)
    })
    reset()
    return
  }

  throw new ThreadStoreSchemaError(
    `Unsupported thread store schema: ${tables.join(', ')}`
  )
}

function isCurrentSchema(tables: readonly string[]): boolean {
  return (
    tables.length === 2 &&
    tables[0] === 'schema_version' &&
    tables[1] === 'threads'
  )
}

function validateCurrentSchema(database: DatabaseType): void {
  const versionRows = database
    .prepare<
      [],
      { id: number; version: number }
    >('SELECT id, version FROM schema_version')
    .all()
  if (
    versionRows.length !== 1 ||
    versionRows[0]?.id !== 1 ||
    versionRows[0].version !== THREAD_STORE_SCHEMA_VERSION
  ) {
    throw new ThreadStoreSchemaError(
      `Unsupported thread store schema version: ${versionRows[0]?.version ?? 'missing'}`
    )
  }

  const userVersion = database
    .prepare<[], { user_version: number }>('PRAGMA user_version')
    .get()?.user_version
  if (userVersion !== THREAD_STORE_SCHEMA_VERSION) {
    throw new ThreadStoreSchemaError(
      `Invalid SQLite user_version: ${userVersion ?? 'missing'}`
    )
  }

  if (
    !sameColumnDefinitions(
      readColumns(database, 'schema_version'),
      CURRENT_SCHEMA_VERSION_COLUMNS
    ) ||
    !sameColumnDefinitions(
      readColumns(database, 'threads'),
      CURRENT_THREADS_COLUMNS
    )
  ) {
    throw new ThreadStoreSchemaError('The threads table has an invalid schema.')
  }

  const indexes = database
    .prepare<[], SqliteIndexRow>('PRAGMA index_list(threads)')
    .all()
  const hasConversationUrlUnique = indexes.some(
    (index) =>
      index.unique === 1 &&
      sameColumns(readIndexColumns(database, index.name), ['conversation_url'])
  )
  const hasLastUsedIndex = indexes.some(
    (index) =>
      index.name === 'idx_threads_last_used_at' &&
      sameColumns(readIndexColumns(database, index.name), ['last_used_at'])
  )
  if (!hasConversationUrlUnique || !hasLastUsedIndex) {
    throw new ThreadStoreSchemaError(
      'The threads table is missing required indexes.'
    )
  }
}

function validateLegacySchema(database: DatabaseType): void {
  const columns = readColumns(database, 'thread_history').map(
    ({ name }) => name
  )
  if (!sameColumns(columns, LEGACY_THREAD_HISTORY_COLUMNS)) {
    throw new ThreadStoreSchemaError(
      'The legacy thread_history table has an invalid schema.'
    )
  }
}

function readColumns(database: DatabaseType, table: string): SqliteColumnRow[] {
  return database
    .prepare<[], SqliteColumnRow>(`PRAGMA table_info(${table})`)
    .all()
}

function readIndexColumns(database: DatabaseType, index: string): string[] {
  const identifier = `"${index.replaceAll('"', '""')}"`
  return database
    .prepare<[], SqliteIndexColumnRow>(`PRAGMA index_info(${identifier})`)
    .all()
    .flatMap(({ name }) => (name === null ? [] : [name]))
}

function sameColumns(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => column === expected[index])
  )
}

function sameColumnDefinitions(
  actual: readonly SqliteColumnRow[],
  expected: readonly ExpectedColumn[]
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const expectedColumn = expected[index]
      return (
        expectedColumn !== undefined &&
        column.name === expectedColumn.name &&
        column.type.toUpperCase() === expectedColumn.type &&
        column.notnull === expectedColumn.notnull &&
        column.pk === expectedColumn.pk
      )
    })
  )
}

function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (id, version)
      VALUES (1, ${THREAD_STORE_SCHEMA_VERSION});

    CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      conversation_url TEXT NOT NULL UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX idx_threads_last_used_at
      ON threads(last_used_at DESC);
    PRAGMA user_version = ${THREAD_STORE_SCHEMA_VERSION};
  `)
}
