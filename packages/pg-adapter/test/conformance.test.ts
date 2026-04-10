import { describe, it, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { pgAdapter } from '../src/index'

describe('pg-adapter conformance', () => {
  let container: StartedPostgreSqlContainer
  let pool: pg.Pool

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start()
    pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  }, 60_000)

  afterAll(async () => {
    await pool.end()
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
        factory: () => pgAdapter(pool),
      }
      await test.run(ctx)
    })
  }
})
