import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase, migrate } from '../src/providers/database.js'
import { SQLiteMemoryStore } from '../src/providers/memory/sqlite.js'
import { DefaultMemoryOperationExecutor } from '../src/providers/memory/executor.js'

let db: Database.Database
let store: SQLiteMemoryStore
let executor: DefaultMemoryOperationExecutor

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  store = new SQLiteMemoryStore(db)
  executor = new DefaultMemoryOperationExecutor(store)
})

describe('MemoryStore', () => {
  it('set and get', async () => {
    await store.set({ key: 'test:key', value: 'hello', summary: 'A greeting', type: 'fact' })
    const entry = await store.get('test:key')
    expect(entry).not.toBeNull()
    expect(entry!.key).toBe('test:key')
    expect(entry!.value).toBe('hello')
    expect(entry!.summary).toBe('A greeting')
    expect(entry!.type).toBe('fact')
    expect(entry!.version).toBe(1)
  })

  it('versioning on update', async () => {
    await store.set({ key: 'counter', value: '1', summary: 'Counter', type: 'state' })
    await store.set({ key: 'counter', value: '2', summary: 'Counter v2', type: 'state' })
    await store.set({ key: 'counter', value: '3', summary: 'Counter v3', type: 'state' })

    const current = await store.get('counter')
    expect(current!.value).toBe('3')
    expect(current!.version).toBe(3)
  })

  it('history returns all versions', async () => {
    await store.set({ key: 'x', value: 'a', summary: 's', type: 'fact' })
    await store.set({ key: 'x', value: 'b', summary: 's', type: 'fact' })
    await store.set({ key: 'x', value: 'c', summary: 's', type: 'fact' })

    const history = await store.history('x')
    expect(history).toHaveLength(3)
    expect(history[0]!.version).toBe(3) // newest first
    expect(history[2]!.version).toBe(1)
  })

  it('rollback restores old version', async () => {
    await store.set({ key: 'x', value: 'original', summary: 's', type: 'fact' })
    await store.set({ key: 'x', value: 'changed', summary: 's', type: 'fact' })
    await store.rollback('x', 1)

    const current = await store.get('x')
    expect(current!.value).toBe('original')
    expect(current!.version).toBe(3) // rollback creates a new version
  })

  it('delete and get returns null', async () => {
    await store.set({ key: 'x', value: 'v', summary: 's', type: 'fact' })
    await store.delete('x')
    const entry = await store.get('x')
    expect(entry).toBeNull()
  })

  it('append adds to existing value', async () => {
    await store.set({ key: 'log', value: 'line 1', summary: 'Log', type: 'log' })
    await store.append('log', 'line 2')
    const entry = await store.get('log')
    expect(entry!.value).toBe('line 1\nline 2')
  })

  it('list by prefix', async () => {
    await store.set({ key: 'project:a:status', value: 'ok', summary: 's', type: 'state' })
    await store.set({ key: 'project:a:arch', value: 'mono', summary: 's', type: 'fact' })
    await store.set({ key: 'project:b:status', value: 'ok', summary: 's', type: 'state' })
    await store.set({ key: 'user:george', value: 'hi', summary: 's', type: 'fact' })

    const projectA = await store.list('project:a')
    expect(projectA).toHaveLength(2)

    const allProjects = await store.list('project:')
    expect(allProjects).toHaveLength(3)
  })

  it('pin and unpin', async () => {
    await store.set({ key: 'x', value: 'v', summary: 's', type: 'fact' })
    await store.pin('x')

    const pinned = await store.getPinned()
    expect(pinned).toHaveLength(1)
    expect(pinned[0]!.key).toBe('x')

    await store.unpin('x')
    const unpinned = await store.getPinned()
    expect(unpinned).toHaveLength(0)
  })

  it('getIndex returns all current keys with summaries', async () => {
    await store.set({ key: 'a', value: 'v1', summary: 'Alpha', type: 'fact' })
    await store.set({ key: 'b', value: 'v2', summary: 'Beta', type: 'state', pinned: true })

    const index = await store.getIndex()
    expect(index).toHaveLength(2)
    expect(index.find(e => e.key === 'a')!.summary).toBe('Alpha')
    expect(index.find(e => e.key === 'b')!.pinned).toBe(true)
  })

  it('deleted keys excluded from index', async () => {
    await store.set({ key: 'a', value: 'v', summary: 's', type: 'fact' })
    await store.set({ key: 'b', value: 'v', summary: 's', type: 'fact' })
    await store.delete('a')

    const index = await store.getIndex()
    expect(index).toHaveLength(1)
    expect(index[0]!.key).toBe('b')
  })

  it('search via FTS', async () => {
    await store.set({ key: 'a', value: 'database migration', summary: 'DB work', type: 'fact' })
    await store.set({ key: 'b', value: 'frontend styling', summary: 'CSS work', type: 'fact' })

    const results = await store.search('database', 10)
    expect(results).toHaveLength(1)
    expect(results[0]!.key).toBe('a')
  })

  it('TTL expiration via gc', async () => {
    await store.set({ key: 'temp', value: 'v', summary: 's', type: 'state', ttl: '1s' })
    // Wait just over 1s
    await new Promise(r => setTimeout(r, 1100))
    await store.gc()

    const entry = await store.get('temp')
    expect(entry).toBeNull()
  })
})

describe('MemoryOperationExecutor', () => {
  it('executes batch of ops and returns results', async () => {
    const results = await executor.execute([
      { op: 'set', key: 'x', value: 'hello', summary: 'test', type: 'fact' },
      { op: 'get', key: 'x' },
    ])

    expect(results).toHaveLength(2)
    expect(results[0]!.success).toBe(true)
    expect(results[1]!.success).toBe(true)
    expect(results[1]!.data).toBeDefined()
    expect((results[1]!.data as any).value).toBe('hello')
  })

  it('handles errors gracefully', async () => {
    const results = await executor.execute([
      { op: 'append', key: 'nonexistent', value: 'data' },
    ])
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toBeDefined()
  })
})
