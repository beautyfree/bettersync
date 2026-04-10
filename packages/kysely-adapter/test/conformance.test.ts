import { describe, it, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { kyselyAdapter } from '../src/index'

describe('kysely-adapter conformance', () => {
  let container: StartedPostgreSqlContainer
  let pool: pg.Pool
  // biome-ignore lint/suspicious/noExplicitAny: test DB types unknown
  let db: Kysely<any>

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start()
    pool = new pg.Pool({ connectionString: container.getConnectionUri() })
    db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  }, 60_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      // Clean slate per test
      const client = await pool.connect()
      try {
        await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
      } finally {
        client.release()
      }
      const ctx: ConformanceContext = {
        factory: () => kyselyAdapter(db),
      }
      await test.run(ctx)
    })
  }
})
