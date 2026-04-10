/**
 * Run the shared conformance suite against a real Postgres via testcontainers.
 *
 * Requires Docker. Skip with SKIP_DOCKER=true if Docker is unavailable.
 */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@better-sync/test-utils'
import { drizzleAdapter } from '../src/index'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { CONFORMANCE_TEST_SCHEMA } from '@better-sync/test-utils'

const SKIP = process.env.SKIP_DOCKER === 'true'

describe.skipIf(SKIP)('drizzle-adapter conformance (Postgres)', () => {
  let container: StartedPostgreSqlContainer
  let pool: pg.Pool
  let db: NodePgDatabase<Record<string, never>>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    pool = new pg.Pool({ connectionString: container.getConnectionUri() })
    db = drizzle(pool)
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  // Clean slate before each test: truncate all sync tables + tombstones
  beforeEach(async () => {
    try {
      await pool.query('TRUNCATE sync_tombstones')
      for (const modelKey of Object.keys(CONFORMANCE_TEST_SCHEMA)) {
        const tableName = CONFORMANCE_TEST_SCHEMA[modelKey]?.modelName ?? modelKey
        await pool.query(`TRUNCATE "${tableName}"`)
      }
    } catch {
      // Tables may not exist on first run — ensureSyncTables creates them
    }
  })

  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      const ctx: ConformanceContext = {
        factory: () => drizzleAdapter(db),
      }
      await test.run(ctx)
    })
  }
})
