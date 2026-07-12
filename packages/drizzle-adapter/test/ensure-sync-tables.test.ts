import { describe, expect, it } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTable } from 'drizzle-orm/pg-core'
import { drizzleAdapter } from '../src/index'

describe('drizzleAdapter.ensureSyncTables', () => {
  it('creates only BetterSync internal tables and indexes at boot', async () => {
    const statements: unknown[] = []
    const db = {
      execute: async (statement: unknown) => {
        statements.push(statement)
        return { rows: [] }
      },
    } as unknown as NodePgDatabase<Record<string, never>>

    const adapter = drizzleAdapter(db, {
      schema: { project: {} as PgTable },
    })

    await adapter.ensureSyncTables({})

    // tombstone table + its index + immutable operation table. In particular,
    // no DDL is emitted for the application `project` table.
    expect(statements).toHaveLength(3)
  })
})
