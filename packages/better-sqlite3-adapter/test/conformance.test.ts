import { describe, it } from 'vitest'
import Database from 'better-sqlite3'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { betterSqlite3Adapter } from '../src/index'

describe('better-sqlite3-adapter conformance', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      // In-memory SQLite per test — no cleanup needed
      const db = new Database(':memory:')
      const ctx: ConformanceContext = {
        factory: () => betterSqlite3Adapter(db),
      }
      await test.run(ctx)
      db.close()
    })
  }
})
