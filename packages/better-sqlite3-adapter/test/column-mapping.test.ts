import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { SyncSchema } from '@bettersync/core'
import { betterSqlite3Adapter } from '../src/index'

const schema: SyncSchema = {
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string', columnName: 'user_id' },
      displayName: { type: 'string', columnName: 'display_name' },
      changed: { type: 'string' },
    },
  },
}

describe('columnName mapping', () => {
  it('uses physical columns while exposing logical fields through every CRUD and sync path', async () => {
    const db = new Database(':memory:')
    const adapter = betterSqlite3Adapter(db)
    await adapter.ensureSyncTables(schema)
    await adapter.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', displayName: 'First', changed: '000000000001000000000001' },
    })

    expect(db.prepare('SELECT user_id, display_name FROM project WHERE id = ?').get('p1'))
      .toEqual({ user_id: 'u1', display_name: 'First' })
    expect(await adapter.findOne({ model: 'project', where: { userId: 'u1' } }))
      .toMatchObject({ id: 'p1', userId: 'u1', displayName: 'First' })

    await adapter.update({ model: 'project', where: { id: 'p1' }, update: { displayName: 'Updated' } })
    const page = await adapter.findChangedSince({
      model: 'project', sinceHlc: '000000000000000000000000', limit: 10, scope: { userId: 'u1' },
    })
    expect(page.rows).toEqual([
      { id: 'p1', userId: 'u1', displayName: 'Updated', changed: '000000000001000000000001' },
    ])
    db.close()
  })

  it('rejects a remapped HLC field until raw adapter HLC configuration is explicit', async () => {
    const db = new Database(':memory:')
    const adapter = betterSqlite3Adapter(db)
    await expect(adapter.ensureSyncTables({
      project: {
        fields: {
          id: { type: 'string', primaryKey: true },
          changed: { type: 'string', columnName: 'changed_at' },
        },
      },
    })).rejects.toThrow(/physical hlcField/)
    db.close()
  })
})
