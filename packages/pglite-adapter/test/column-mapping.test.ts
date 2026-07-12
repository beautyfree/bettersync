import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type { SyncSchema } from '@bettersync/core'
import { pgliteAdapter } from '../src/index'

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
  it('maps logical rows and scope predicates to physical Postgres columns', async () => {
    const pg = new PGlite()
    const adapter = pgliteAdapter(pg)
    await adapter.ensureSyncTables(schema)
    await adapter.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', displayName: 'First', changed: '000000000001000000000001' },
    })

    expect((await pg.query('SELECT user_id, display_name FROM project WHERE id = $1', ['p1'])).rows)
      .toEqual([{ user_id: 'u1', display_name: 'First' }])
    const page = await adapter.findChangedSince({
      model: 'project', sinceHlc: '000000000000000000000000', limit: 10, scope: { userId: 'u1' },
    })
    expect(page.rows).toEqual([
      { id: 'p1', userId: 'u1', displayName: 'First', changed: '000000000001000000000001' },
    ])
    await pg.close()
  })
})
