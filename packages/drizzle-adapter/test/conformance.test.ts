/**
 * Conformance suite against real Postgres via testcontainers.
 *
 * Now uses Drizzle table objects (better-auth style) instead of raw SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { CONFORMANCE_TESTS, CONFORMANCE_TEST_SCHEMA, type ConformanceContext } from '@bettersync/test-utils'
import { drizzleAdapter } from '../src/index'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, text, boolean } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

const SKIP = process.env.SKIP_DOCKER === 'true'

// Define Drizzle tables matching the conformance test schema
const projectTable = pgTable('project', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  changed: text('changed').notNull(),
})

const tagTable = pgTable('tag', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  changed: text('changed').notNull(),
})

describe.skipIf(SKIP)('drizzle-adapter conformance (Postgres, Drizzle tables)', () => {
  let container: StartedPostgreSqlContainer
  let pool: pg.Pool
  let db: NodePgDatabase<Record<string, never>>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    pool = new pg.Pool({ connectionString: container.getConnectionUri() })
    db = drizzle(pool)

    // Create tables (normally done by Drizzle migrations)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        changed TEXT NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tag (
        id TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        name TEXT NOT NULL,
        changed TEXT NOT NULL
      )
    `)
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  beforeEach(async () => {
    try {
      await pool.query('TRUNCATE sync_tombstones')
      await pool.query('TRUNCATE project')
      await pool.query('TRUNCATE tag')
    } catch {
      // Tables may not exist on first run
    }
  })

  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      const ctx: ConformanceContext = {
        factory: () =>
          drizzleAdapter(db, {
            schema: { project: projectTable, tag: tagTable },
          }),
      }
      await test.run(ctx)
    })
  }
})
