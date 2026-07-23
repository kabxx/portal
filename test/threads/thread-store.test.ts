import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

import {
  buildThreadHistoryTitle,
  createThreadStore,
  parseThreadHistoryId,
  parseThreadHistoryLimit,
  THREAD_STORE_SCHEMA_VERSION,
  ThreadStore,
  ThreadStoreSchemaError,
} from '../../src/threads/thread-store.ts'

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-history-'))
  return new ThreadStore(path.join(dir, 'threads.db'))
}

test('createThreadStore initializes the database and schema immediately', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'portal-history-init-')
  )
  const storagePath = path.join(directory, 'threads.db')
  const store = await createThreadStore(storagePath)

  try {
    await fs.access(storagePath)
    assert.deepEqual(await store.list(), [])
  } finally {
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('createThreadStore preserves a malformed database and fails initialization', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'portal-history-invalid-')
  )
  const storagePath = path.join(directory, 'threads.db')
  const original = 'not a sqlite database'
  await fs.writeFile(storagePath, original, 'utf8')

  try {
    await assert.rejects(createThreadStore(storagePath))
    assert.equal(await fs.readFile(storagePath, 'utf8'), original)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('createThreadStore resets the unpublished legacy schema', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'portal-history-legacy-')
  )
  const storagePath = path.join(directory, 'threads.db')
  const legacy = new Database(storagePath)
  legacy.exec(`
    CREATE TABLE thread_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      conversation_url TEXT NOT NULL UNIQUE,
      title TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    INSERT INTO thread_history
      (provider, conversation_url, title, created_at, last_used_at)
    VALUES
      ('chatgpt', 'https://chatgpt.com/c/legacy', 'legacy', '2026-01-01', '2026-01-01');
  `)
  legacy.close()

  const store = await createThreadStore(storagePath)
  try {
    assert.equal(store.getSchemaVersion(), THREAD_STORE_SCHEMA_VERSION)
    assert.deepEqual(await store.list(), [])

    const inspection = new Database(storagePath, { readonly: true })
    try {
      const tables = inspection
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
      assert.deepEqual(
        tables.map(({ name }) => name),
        ['schema_version', 'threads']
      )
    } finally {
      inspection.close()
    }
  } finally {
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('createThreadStore rejects a structurally invalid legacy schema without resetting it', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'portal-history-invalid-schema-')
  )
  const storagePath = path.join(directory, 'threads.db')
  const invalid = new Database(storagePath)
  invalid.exec('CREATE TABLE thread_history (id INTEGER PRIMARY KEY);')
  invalid.close()

  try {
    await assert.rejects(createThreadStore(storagePath), ThreadStoreSchemaError)
    const inspection = new Database(storagePath, { readonly: true })
    try {
      const table = inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_history'"
        )
        .get()
      assert.ok(table)
    } finally {
      inspection.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('createThreadStore rejects a current schema with broken constraints', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'portal-history-invalid-current-schema-')
  )
  const storagePath = path.join(directory, 'threads.db')
  const invalid = new Database(storagePath)
  invalid.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL
    );
    INSERT INTO schema_version (id, version) VALUES (1, 1);
    CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      conversation_url TEXT,
      title TEXT,
      created_at TEXT,
      last_used_at TEXT
    );
    PRAGMA user_version = 1;
  `)
  invalid.close()

  try {
    await assert.rejects(createThreadStore(storagePath), ThreadStoreSchemaError)
    const inspection = new Database(storagePath, { readonly: true })
    try {
      const version = inspection
        .prepare('SELECT version FROM schema_version WHERE id = 1')
        .get()
      assert.ok(version)
    } finally {
      inspection.close()
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('ThreadStore stores entries with stable ids and lists by last use', async () => {
  const store = await createStore()

  await store.append({
    provider: 'chatgpt',
    conversationUrl: 'https://chatgpt.com/c/one',
    title: null,
    createdAt: '2026-07-07T01:00:00.000Z',
    lastUsedAt: '2026-07-07T01:00:00.000Z',
  })
  await store.append({
    provider: 'doubao',
    conversationUrl: 'https://www.doubao.com/thread/two',
    title: 'second',
    createdAt: '2026-07-07T02:00:00.000Z',
    lastUsedAt: '2026-07-07T02:00:00.000Z',
  })

  const entries = await store.list(1)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.id, 2)
  assert.equal(entries[0]?.conversationUrl, 'https://www.doubao.com/thread/two')
  assert.equal(entries[0]?.title, 'second')
  assert.equal(entries[0]?.lastUsedAt, '2026-07-07T02:00:00.000Z')
  store.close()
})

test('ThreadStore upserts by URL without consuming ids or replacing titles', async () => {
  const store = await createStore()

  await store.append({
    provider: 'gemini',
    conversationUrl: 'https://gemini.google.com/app/abc',
    title: 'first title',
    createdAt: '2026-07-07T01:00:00.000Z',
    lastUsedAt: '2026-07-07T01:00:00.000Z',
  })
  await store.append({
    provider: 'gemini',
    conversationUrl: 'https://gemini.google.com/app/abc',
    title: null,
    createdAt: '2026-07-08T01:00:00.000Z',
    lastUsedAt: '2026-07-08T01:00:00.000Z',
  })
  await store.append({
    provider: 'gemini',
    conversationUrl: 'https://gemini.google.com/app/def',
    title: 'second title',
    createdAt: '2026-07-09T01:00:00.000Z',
    lastUsedAt: '2026-07-09T01:00:00.000Z',
  })
  await store.append({
    provider: 'gemini',
    conversationUrl: 'https://gemini.google.com/app/def',
    title: 'replacement title',
    createdAt: '2026-07-10T01:00:00.000Z',
    lastUsedAt: '2026-07-10T01:00:00.000Z',
  })

  const entries = await store.list()
  assert.equal(entries.length, 2)
  assert.equal((await store.getById(1))?.title, 'first title')
  assert.equal((await store.getById(1))?.createdAt, '2026-07-07T01:00:00.000Z')
  assert.equal((await store.getById(1))?.lastUsedAt, '2026-07-08T01:00:00.000Z')
  assert.equal(
    (await store.getById(2))?.conversationUrl,
    'https://gemini.google.com/app/def'
  )
  assert.equal((await store.getById(2))?.title, 'second title')
  assert.equal((await store.getById(2))?.lastUsedAt, '2026-07-10T01:00:00.000Z')
  store.close()
})

test('ThreadStore fills an empty title once', async () => {
  const store = await createStore()

  await store.append({
    provider: 'deepseek',
    conversationUrl: 'https://chat.deepseek.com/a/chat/s/abc',
    title: null,
    createdAt: '2026-07-07T01:00:00.000Z',
  })
  await store.setTitleIfEmpty({
    conversationUrl: 'https://chat.deepseek.com/a/chat/s/abc',
    title: 'first prompt',
    lastUsedAt: '2026-07-07T02:00:00.000Z',
  })
  await store.setTitleIfEmpty({
    conversationUrl: 'https://chat.deepseek.com/a/chat/s/abc',
    title: 'second prompt',
    lastUsedAt: '2026-07-07T03:00:00.000Z',
  })

  const entry = await store.getById(1)
  assert.equal(entry?.title, 'first prompt')
  assert.equal(entry?.lastUsedAt, '2026-07-07T03:00:00.000Z')
  store.close()
})

test('parseThreadHistoryLimit defaults and validates range', () => {
  assert.deepEqual(parseThreadHistoryLimit(undefined), {
    limit: 5,
    error: null,
  })
  assert.deepEqual(parseThreadHistoryLimit('100'), {
    limit: 100,
    error: null,
  })
  assert.deepEqual(parseThreadHistoryLimit('0'), {
    limit: null,
    error: 'Limit must be between 1 and 100.',
  })
})

test('parseThreadHistoryId requires hash-prefixed positive integer ids', () => {
  assert.equal(parseThreadHistoryId('#1'), 1)
  assert.equal(parseThreadHistoryId('1'), null)
  assert.equal(parseThreadHistoryId('#0'), null)
  assert.equal(parseThreadHistoryId('abc'), null)
})

test('buildThreadHistoryTitle normalizes whitespace and truncates long prompts', () => {
  assert.equal(buildThreadHistoryTitle('  hello\nworld  '), 'hello world')
  assert.equal(buildThreadHistoryTitle('abcdef', 5), 'ab...')
})
