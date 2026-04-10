/**
 * @bettersync/test-utils
 *
 * Framework-agnostic adapter conformance suite. Exports pure async
 * functions that verify a SyncAdapter implementation against the contract
 * defined by @bettersync/core.
 *
 * Consumers (adapter packages) wire these into their own test framework:
 *
 * ```ts
 * import { describe, it } from 'vitest'
 * import { CONFORMANCE_TESTS } from '@bettersync/test-utils'
 * import { memoryAdapter } from '../src'
 *
 * describe('memory-adapter conformance', () => {
 *   for (const test of CONFORMANCE_TESTS) {
 *     it(test.name, () => test.run({ factory: () => memoryAdapter() }))
 *   }
 * })
 * ```
 */

export {
  CONFORMANCE_TESTS,
  CONFORMANCE_TEST_SCHEMA,
  getConformanceTestsByTag,
  hlcAt,
} from './conformance'
export type {
  AdapterFactory,
  ConformanceContext,
  ConformanceTest,
} from './conformance'
