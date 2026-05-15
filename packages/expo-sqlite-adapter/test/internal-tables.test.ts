/**
 * Internal-table integration: ensureSyncTables must create the
 * bettersync-internal `_sync_meta` and `_sync_pending` tables WITHOUT
 * injecting the user schema's hlcField (default 'changed'). The bug
 * that motivated this test:
 *
 *   CREATE TABLE _sync_meta (key, value, changed NOT NULL)
 *
 * Then every setMeta(...) call failed with
 *
 *   Error code 19: NOT NULL constraint failed: _sync_meta.changed
 *
 * during normal sync, leaving the local store empty.
 *
 * We pair the user schema (which carries a `changed` field) with the
 * internal tables that don't, ensure setMeta/getMeta roundtrips work,
 * and that getMeta on a missing key returns null without throwing.
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { SyncSchema } from '@bettersync/core'
import { expoSqliteAdapter, type ExpoSqliteDbLike } from '../src/index'

function expoSqliteShim(db: Database.Database): ExpoSqliteDbLike {
  const shim: ExpoSqliteDbLike = {
    async execAsync(source: string) {
      db.exec(source)
    },
    async runAsync(source: string, ...params: unknown[]) {
      const result = db.prepare(source).run(...(params as never[]))
      return {
        lastInsertRowId: Number(result.lastInsertRowid ?? 0),
        changes: result.changes,
      }
    },
    async getFirstAsync<T>(source: string, ...params: unknown[]) {
      const row = db.prepare(source).get(...(params as never[]))
      return (row as T) ?? null
    },
    async getAllAsync<T>(source: string, ...params: unknown[]) {
      return db.prepare(source).all(...(params as never[])) as T[]
    },
    async withExclusiveTransactionAsync(task) {
      db.exec('BEGIN IMMEDIATE')
      try {
        await task(shim)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
  return shim
}

const userSchema: SyncSchema = {
  // Realistic user model with the hlc field — adapter SHOULD add NOT
  // NULL to `changed` on this table.
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      title: { type: 'string' },
      changed: { type: 'string' },
    },
  },
}

// What the client builds at runtime — extended schema with internal
// tables that lack hlcField.
const extendedSchema: SyncSchema = {
  ...userSchema,
  _sync_pending: {
    fields: {
      id: { type: 'string', primaryKey: true },
      model: { type: 'string' },
      action: { type: 'string' },
      payload: { type: 'string' },
      hlc: { type: 'string' },
      createdAt: { type: 'string' },
    },
  },
  _sync_meta: {
    fields: {
      key: { type: 'string', primaryKey: true },
      value: { type: 'string' },
    },
  },
}

describe('expo-sqlite-adapter — internal tables', () => {
  it('ensureSyncTables creates _sync_meta WITHOUT a hlcField column', async () => {
    const db = new Database(':memory:')
    const adapter = expoSqliteAdapter(expoSqliteShim(db))
    await adapter.ensureSyncTables(extendedSchema)

    const cols = db
      .prepare(`PRAGMA table_info("_sync_meta")`)
      .all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('key')
    expect(names).toContain('value')
    expect(names).not.toContain('changed')
    db.close()
  })

  it('setMeta / getMeta roundtrip on _sync_meta (no NOT NULL crash)', async () => {
    const db = new Database(':memory:')
    const adapter = expoSqliteAdapter(expoSqliteShim(db))
    await adapter.ensureSyncTables(extendedSchema)

    // Simulate what client.setMeta does: create row with key+value
    // only — no `changed` field provided. Used to throw NOT NULL.
    await adapter.create({
      model: '_sync_meta',
      data: { key: 'last_sync_hlc', value: '019e2300f289000000000000' },
    })
    const row = await adapter.findOne({ model: '_sync_meta', where: { key: 'last_sync_hlc' } })
    expect(row?.value).toBe('019e2300f289000000000000')

    // getMeta on missing key returns null.
    const missing = await adapter.findOne({ model: '_sync_meta', where: { key: 'pending_cursor' } })
    expect(missing).toBeNull()

    // Update path
    await adapter.update({
      model: '_sync_meta',
      where: { key: 'last_sync_hlc' },
      update: { value: '019e2300f290000000000000' },
    })
    const updated = await adapter.findOne({ model: '_sync_meta', where: { key: 'last_sync_hlc' } })
    expect(updated?.value).toBe('019e2300f290000000000000')

    db.close()
  })

  it('user model still keeps NOT NULL on hlcField when extended schema is passed', async () => {
    const db = new Database(':memory:')
    const adapter = expoSqliteAdapter(expoSqliteShim(db))
    await adapter.ensureSyncTables(extendedSchema)

    const cols = db
      .prepare(`PRAGMA table_info("project")`)
      .all() as Array<{ name: string; notnull: number }>
    const changedCol = cols.find((c) => c.name === 'changed')
    expect(changedCol).toBeDefined()
    expect(changedCol!.notnull).toBe(1)
    db.close()
  })
})
