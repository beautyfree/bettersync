/**
 * Conformance test suite. Each test is a pure async function that takes
 * a factory returning a fresh adapter and throws on failure.
 *
 * Tests are organized by tag so consumers can filter
 * (e.g. skip transaction tests for non-transactional adapters).
 */

import {
  type Row,
  type SyncAdapter,
  type SyncSchema,
  encodeHlc,
} from '@bettersync/core'

/** A factory that produces a fresh adapter for each test. */
export type AdapterFactory = () => SyncAdapter | Promise<SyncAdapter>

export interface ConformanceContext {
  factory: AdapterFactory
}

export interface ConformanceTest {
  /** Human-readable test name. */
  name: string
  /**
   * Tags for categorization and filtering:
   * - `core`: required for every adapter
   * - `upsert`: HLC-conditional upsert semantics
   * - `cursor`: findChangedSince pagination correctness
   * - `scope`: multi-tenant isolation (P0 security)
   * - `tombstone`: tombstone create/find/gc/resurrection
   * - `transaction`: atomic rollback (capability: supportsTransaction)
   * - `batch`: batch upsert (capability: supportsBatchInsert)
   */
  tags: string[]
  run: (ctx: ConformanceContext) => Promise<void>
}

/**
 * Canonical test schema used by the conformance suite. Adapters MUST
 * successfully call `ensureSyncTables(CONFORMANCE_TEST_SCHEMA)`.
 */
export const CONFORMANCE_TEST_SCHEMA: SyncSchema = {
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string', required: false },
      changed: { type: 'string' },
    },
    scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
  },
  tag: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      name: { type: 'string' },
      changed: { type: 'string' },
    },
    scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
  },
}

/** Build an HLC at the given wall/logical with a fixed test node ID. */
export function hlcAt(wall: number, logical = 0): string {
  return encodeHlc({ wall, logical, node: 0xdeadbeef })
}

// ─── Assertion helpers (no vitest dep) ──────────────────────────────

function fail(msg: string): never {
  throw new Error(msg)
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    fail(`${msg ?? 'assertEquals failed'}\n  actual:   ${a}\n  expected: ${e}`)
  }
}

function assertTrue(condition: boolean, msg: string): void {
  if (!condition) fail(msg)
}

function assertNotNull<T>(value: T | null | undefined, msg: string): T {
  if (value === null || value === undefined) fail(msg)
  return value
}

// ─── Test factories ─────────────────────────────────────────────────

async function setup(factory: AdapterFactory): Promise<SyncAdapter> {
  const adapter = await factory()
  await adapter.ensureSyncTables(CONFORMANCE_TEST_SCHEMA)
  return adapter
}

function makeProject(id: string, userId: string, title: string, hlc: string): Row {
  return { id, userId, title, content: null, changed: hlc }
}

// ─── The conformance suite ──────────────────────────────────────────

export const CONFORMANCE_TESTS: ConformanceTest[] = [
  {
    name: 'ensureSyncTables is idempotent',
    tags: ['core'],
    run: async ({ factory }) => {
      const a = await factory()
      await a.ensureSyncTables(CONFORMANCE_TEST_SCHEMA)
      await a.ensureSyncTables(CONFORMANCE_TEST_SCHEMA)
      await a.ensureSyncTables(CONFORMANCE_TEST_SCHEMA)
    },
  },

  {
    name: 'create + findOne roundtrip',
    tags: ['core'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.create({ model: 'project', data: makeProject('p1', 'u1', 'Hello', hlcAt(100)) })
      const row = assertNotNull(
        await a.findOne({ model: 'project', where: { id: 'p1' } }),
        'row not found after create',
      )
      assertEquals(row.title, 'Hello')
      assertEquals(row.userId, 'u1')
    },
  },

  {
    name: 'count matches findMany length',
    tags: ['core'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      for (let i = 0; i < 5; i++) {
        await a.create({
          model: 'project',
          data: makeProject(`p${i}`, 'u1', `t${i}`, hlcAt(100 + i)),
        })
      }
      const count = await a.count({ model: 'project', where: { userId: 'u1' } })
      assertEquals(count, 5)
    },
  },

  {
    name: 'upsertIfNewer inserts when no existing row',
    tags: ['core', 'upsert'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      const result = await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'Hello', hlcAt(100)),
      })
      assertEquals(result, 'inserted')
      const row = assertNotNull(
        await a.findOne({ model: 'project', where: { id: 'p1' } }),
        'row not found after upsert-insert',
      )
      assertEquals(row.title, 'Hello')
    },
  },

  {
    name: 'upsertIfNewer updates when incoming HLC is newer',
    tags: ['core', 'upsert'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'Old', hlcAt(100)),
      })
      const result = await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'New', hlcAt(200)),
      })
      assertEquals(result, 'updated')
      const row = assertNotNull(
        await a.findOne({ model: 'project', where: { id: 'p1' } }),
        'row missing',
      )
      assertEquals(row.title, 'New')
    },
  },

  {
    name: 'upsertIfNewer skips when incoming HLC is older',
    tags: ['core', 'upsert'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'New', hlcAt(200)),
      })
      const result = await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'Old', hlcAt(100)),
      })
      assertEquals(result, 'skipped')
      const row = assertNotNull(
        await a.findOne({ model: 'project', where: { id: 'p1' } }),
        'row missing',
      )
      assertEquals(row.title, 'New')
    },
  },

  {
    name: 'upsertIfNewer is idempotent on replay (same HLC)',
    tags: ['core', 'upsert'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      const row = makeProject('p1', 'u1', 'Hello', hlcAt(100))
      assertEquals(await a.upsertIfNewer({ model: 'project', row }), 'inserted')
      assertEquals(await a.upsertIfNewer({ model: 'project', row }), 'skipped')
      assertEquals(await a.upsertIfNewer({ model: 'project', row }), 'skipped')
    },
  },

  {
    name: 'findChangedSince returns empty for unchanged data',
    tags: ['core', 'cursor'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'Hello', hlcAt(100)),
      })
      const result = await a.findChangedSince({
        model: 'project',
        sinceHlc: hlcAt(200),
        limit: 100,
      })
      assertEquals(result.rows.length, 0)
      assertEquals(result.nextCursor, undefined)
    },
  },

  {
    name: 'findChangedSince returns rows after sinceHlc sorted by (changed, id)',
    tags: ['core', 'cursor'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('pB', 'u1', 'B', hlcAt(200)),
      })
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('pA', 'u1', 'A', hlcAt(100)),
      })
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('pC', 'u1', 'C', hlcAt(300)),
      })
      const result = await a.findChangedSince({
        model: 'project',
        sinceHlc: hlcAt(0),
        limit: 100,
      })
      assertEquals(result.rows.length, 3)
      assertEquals(
        result.rows.map((r) => r.id),
        ['pA', 'pB', 'pC'],
      )
    },
  },

  {
    name: 'findChangedSince pagination with compound (hlc, id) cursor — no skip/dup (P0)',
    tags: ['core', 'cursor'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      // Insert 50 rows, first 25 with hlcAt(100), next 25 with hlcAt(200)
      // This forces the cursor tiebreak to matter (many rows share the same HLC).
      for (let i = 0; i < 25; i++) {
        await a.upsertIfNewer({
          model: 'project',
          row: makeProject(`p${String(i).padStart(3, '0')}`, 'u1', `t${i}`, hlcAt(100)),
        })
      }
      for (let i = 25; i < 50; i++) {
        await a.upsertIfNewer({
          model: 'project',
          row: makeProject(`p${String(i).padStart(3, '0')}`, 'u1', `t${i}`, hlcAt(200)),
        })
      }

      const collected: string[] = []
      let cursor: { hlc: string; id: string } | undefined
      // Hard cap to avoid infinite loops in buggy adapters.
      for (let page = 0; page < 100; page++) {
        const result = await a.findChangedSince({
          model: 'project',
          sinceHlc: hlcAt(0),
          limit: 10,
          ...(cursor ? { cursor } : {}),
        })
        for (const row of result.rows) collected.push(String(row.id))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }

      assertEquals(collected.length, 50, 'expected exactly 50 rows across pages')
      const unique = new Set(collected)
      assertEquals(unique.size, 50, 'duplicates across pages')
      // And must be in sorted order
      const sorted = [...collected].sort()
      assertEquals(collected, sorted, 'rows must be sorted across pagination')
    },
  },

  {
    name: 'findChangedSince respects scope filter (cross-tenant isolation)',
    tags: ['core', 'scope'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'alice', 'Alice secret', hlcAt(100)),
      })
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p2', 'bob', 'Bob secret', hlcAt(100)),
      })
      const aliceResult = await a.findChangedSince({
        model: 'project',
        sinceHlc: hlcAt(0),
        limit: 100,
        scope: { userId: 'alice' },
      })
      assertEquals(aliceResult.rows.length, 1)
      assertEquals(aliceResult.rows[0]?.id, 'p1')
      const bobResult = await a.findChangedSince({
        model: 'project',
        sinceHlc: hlcAt(0),
        limit: 100,
        scope: { userId: 'bob' },
      })
      assertEquals(bobResult.rows.length, 1)
      assertEquals(bobResult.rows[0]?.id, 'p2')
    },
  },

  {
    name: 'upsertTombstoneIfNewer creates and returns true',
    tags: ['core', 'tombstone'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      const created = await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p1',
        hlc: hlcAt(100),
        scope: { userId: 'u1' },
      })
      assertEquals(created, true)
    },
  },

  {
    name: 'upsertTombstoneIfNewer skips older HLC',
    tags: ['core', 'tombstone'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p1',
        hlc: hlcAt(200),
        scope: { userId: 'u1' },
      })
      const second = await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p1',
        hlc: hlcAt(100),
        scope: { userId: 'u1' },
      })
      assertEquals(second, false)
    },
  },

  {
    name: 'findTombstonesSince respects scope (P0 cross-tenant leak prevention)',
    tags: ['core', 'tombstone', 'scope'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p-alice',
        hlc: hlcAt(100),
        scope: { userId: 'alice' },
      })
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p-bob',
        hlc: hlcAt(100),
        scope: { userId: 'bob' },
      })
      const aliceTombs = await a.findTombstonesSince({
        sinceHlc: hlcAt(0),
        limit: 100,
        scope: { userId: 'alice' },
      })
      assertEquals(aliceTombs.length, 1)
      assertEquals(aliceTombs[0]?.id, 'p-alice')
      const bobTombs = await a.findTombstonesSince({
        sinceHlc: hlcAt(0),
        limit: 100,
        scope: { userId: 'bob' },
      })
      assertEquals(bobTombs.length, 1)
      assertEquals(bobTombs[0]?.id, 'p-bob')
    },
  },

  {
    name: 'gcTombstones removes tombstones older than threshold',
    tags: ['core', 'tombstone'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'old',
        hlc: hlcAt(50),
        scope: { userId: 'u1' },
      })
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'new',
        hlc: hlcAt(500),
        scope: { userId: 'u1' },
      })
      const removed = await a.gcTombstones({ olderThanHlc: hlcAt(100) })
      assertEquals(removed, 1)
      const all = await a.findTombstonesSince({
        sinceHlc: hlcAt(0),
        limit: 100,
        scope: { userId: 'u1' },
      })
      assertEquals(all.length, 1)
      assertEquals(all[0]?.id, 'new')
    },
  },

  {
    name: 'tombstone prevents resurrection on stale upsert',
    tags: ['core', 'tombstone', 'upsert'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      // Delete (via tombstone) at HLC 200
      await a.upsertTombstoneIfNewer({
        model: 'project',
        id: 'p1',
        hlc: hlcAt(200),
        scope: { userId: 'u1' },
      })
      // Stale client tries to resurrect with HLC 100 — must be skipped
      const result = await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'ghost', hlcAt(100)),
      })
      assertEquals(result, 'skipped')
      const found = await a.findOne({ model: 'project', where: { id: 'p1' } })
      assertEquals(found, null)
    },
  },

  {
    name: 'transaction rolls back on thrown error',
    tags: ['transaction'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      if (!a.capabilities.supportsTransaction) return // skip if not supported
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('p1', 'u1', 'kept', hlcAt(100)),
      })

      let caught: unknown = null
      try {
        await a.transaction(async (tx) => {
          await tx.upsertIfNewer({
            model: 'project',
            row: makeProject('p2', 'u1', 'will be rolled back', hlcAt(200)),
          })
          throw new Error('forced rollback')
        })
      } catch (err) {
        caught = err
      }
      assertTrue(caught !== null, 'transaction did not throw')

      // p1 still there, p2 must not exist
      const p1 = await a.findOne({ model: 'project', where: { id: 'p1' } })
      assertTrue(p1 !== null, 'p1 was lost on rollback')
      const p2 = await a.findOne({ model: 'project', where: { id: 'p2' } })
      assertEquals(p2, null, 'p2 should have been rolled back')
    },
  },

  {
    name: 'transaction commits on success',
    tags: ['transaction'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      if (!a.capabilities.supportsTransaction) return
      await a.transaction(async (tx) => {
        await tx.upsertIfNewer({
          model: 'project',
          row: makeProject('p1', 'u1', 'committed', hlcAt(100)),
        })
      })
      const row = await a.findOne({ model: 'project', where: { id: 'p1' } })
      assertTrue(row !== null, 'row was not committed')
      assertEquals(row?.title, 'committed')
    },
  },

  {
    name: 'batchUpsertIfNewer returns correct counts',
    tags: ['batch'],
    run: async ({ factory }) => {
      const a = await setup(factory)
      if (!a.capabilities.supportsBatchInsert || !a.batchUpsertIfNewer) return
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('existing-new', 'u1', 'new', hlcAt(200)),
      })
      await a.upsertIfNewer({
        model: 'project',
        row: makeProject('existing-old', 'u1', 'old', hlcAt(100)),
      })
      const result = await a.batchUpsertIfNewer({
        model: 'project',
        rows: [
          makeProject('fresh', 'u1', 'fresh insert', hlcAt(100)),
          makeProject('existing-old', 'u1', 'updated!', hlcAt(500)), // update
          makeProject('existing-new', 'u1', 'will be skipped', hlcAt(50)), // skip
        ],
      })
      assertEquals(result.inserted, 1)
      assertEquals(result.updated, 1)
      assertEquals(result.skipped, 1)
    },
  },
]

/**
 * Filter tests by tag. Pass `['core']` to run only the required set.
 */
export function getConformanceTestsByTag(tags: string[]): ConformanceTest[] {
  if (tags.length === 0) return CONFORMANCE_TESTS
  const tagSet = new Set(tags)
  return CONFORMANCE_TESTS.filter((t) => t.tags.some((tag) => tagSet.has(tag)))
}
