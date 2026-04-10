/**
 * Run the shared @bettersync/test-utils conformance suite against the
 * in-memory adapter. Every test in CONFORMANCE_TESTS must pass.
 */
import { describe, it } from 'vitest'
import { CONFORMANCE_TESTS, type ConformanceContext } from '@bettersync/test-utils'
import { memoryAdapter } from '../src/index'

describe('memory-adapter conformance', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, async () => {
      const ctx: ConformanceContext = {
        factory: () => memoryAdapter(),
      }
      await test.run(ctx)
    })
  }
})
