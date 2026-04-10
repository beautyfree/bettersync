/**
 * Run the conformance suite against PGlite (Postgres WASM).
 * No Docker required — PGlite runs in-process.
 */
import { describe, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { pgliteAdapter } from '../src/index'

describe('pglite-adapter conformance', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      // Fresh in-memory PGlite per test — no cleanup needed
      const pg = new PGlite()
      const ctx: ConformanceContext = {
        factory: () => pgliteAdapter(pg),
      }
      await test.run(ctx)
      await pg.close()
    })
  }
})
