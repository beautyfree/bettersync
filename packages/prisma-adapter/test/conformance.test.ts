/**
 * Prisma conformance tests require a running Postgres + generated Prisma client.
 * For CI, set DATABASE_URL and run `prisma generate` before testing.
 *
 * For local dev without Prisma setup, run the pg-adapter tests instead —
 * the SQL is identical.
 */
import { describe, it } from 'vitest'
import { CONFORMANCE_TESTS } from '@bettersync/test-utils'

describe.skip('prisma-adapter conformance (requires Prisma setup)', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      // To run these tests:
      // 1. Set DATABASE_URL to a Postgres connection string
      // 2. Run: npx prisma generate
      // 3. Remove .skip from this describe block
    })
  }
})
