import Database from 'better-sqlite3'
import { describe, it } from 'vitest'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { expoSqliteAdapter, type ExpoSqliteDbLike } from '../src/index'

/**
 * Conformance test for expo-sqlite-adapter.
 *
 * We can't run expo-sqlite in Node (it ships native iOS/Android binaries),
 * so we shim the expo-sqlite async API on top of synchronous better-sqlite3.
 * This validates the SQL logic the adapter emits is correct; the runtime
 * binding to expo-sqlite is a thin pass-through (runAsync/getFirstAsync/
 * getAllAsync/execAsync/withExclusiveTransactionAsync).
 */
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

describe('expo-sqlite-adapter conformance', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      const db = new Database(':memory:')
      const ctx: ConformanceContext = {
        factory: () => expoSqliteAdapter(expoSqliteShim(db)),
      }
      await test.run(ctx)
      db.close()
    })
  }
})
