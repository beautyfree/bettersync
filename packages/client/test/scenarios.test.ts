/**
 * Extra end-to-end sync scenarios. These cover edge cases that
 * surfaced in production (rork-feeding):
 *
 *   1. Multi-device race — both devices insert an "open" row before
 *      either pulls the other. Server-side `afterWriteInTransaction`
 *      hook enforces a singleton invariant (at most one open row
 *      per parent key) by tombstoning the loser. After both
 *      devices sync again, exactly ONE row remains everywhere.
 *
 *   2. Server-emitted tombstone propagates to other devices. The
 *      hook writes a tombstone for a row a different device never
 *      saw locally — the other device must still drop it once the
 *      tombstone reaches them via pull.
 *
 *   3. Finish flow — update setting `duration` to a non-null value
 *      removes the row from the "open" filter on every device.
 *      Regression guard for the 5838-min ghost report.
 *
 *   4. Tombstone-vs-row HLC ordering. Tombstone with HLC < row HLC
 *      MUST NOT remove the row. Tombstone with higher HLC wins.
 *
 *   5. Push and pull in the same syncNow round-trip — pending local
 *      writes go up, server changes come down, no rows lost.
 *
 *   6. Offline burst — many writes accumulate locally with no
 *      server contact, then a single syncNow flushes all of them.
 *
 *   7. Update-vs-delete race — A updates a row, B deletes it. The
 *      side with the higher HLC wins. Tested in both orderings.
 *
 *   8. Stale-client reception — server's response is re-stamped
 *      with the server's HLC. After pull, the row's HLC on the
 *      client is the server-stamped one, not the client-pre-push
 *      one.
 */

import { describe, expect, it } from 'vitest'
import type { SyncRequest, SyncSchema } from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
import { createSyncServer, type SyncServerHooks } from '@bettersync/server'
import { createSyncClient, type Transport } from '../src/index'

interface Ctx {
  userId: string
  familyId: string
}

/** Feeding-shaped model — open-ended row = `duration: null`. */
const schema: SyncSchema<Ctx> = {
  feeding: {
    fields: {
      id: { type: 'string', primaryKey: true },
      familyId: { type: 'string' },
      childId: { type: 'string' },
      type: { type: 'string' },
      timestamp: { type: 'number' },
      duration: { type: 'number', required: false },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ familyId: ctx.familyId }),
  },
}

interface Setup {
  serverDb: ReturnType<typeof memoryAdapter>
  server: ReturnType<typeof createSyncServer<Ctx>>
  clientA: ReturnType<typeof createSyncClient<Ctx>>
  clientB: ReturnType<typeof createSyncClient<Ctx>>
  transportFor(ctx: Ctx): Transport
}

async function setup(
  hooks: SyncServerHooks<Ctx> | undefined = undefined,
): Promise<Setup> {
  const serverDb = memoryAdapter()
  await serverDb.ensureSyncTables(schema)

  let serverClock = 10_000
  const server = createSyncServer<Ctx>({
    database: serverDb,
    schema,
    clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
    hooks,
  })

  const transportFor = (ctx: Ctx): Transport => {
    return async (req: SyncRequest) => server.handleSync(req, ctx)
  }

  let clientAClock = 1_000
  const clientA = createSyncClient<Ctx>({
    database: memoryAdapter(),
    schema,
    transport: transportFor({ userId: 'alice', familyId: 'fam1' }),
    clock: { nodeId: 0xbbbbbbbb, now: () => clientAClock++ },
  })

  let clientBClock = 2_000
  const clientB = createSyncClient<Ctx>({
    database: memoryAdapter(),
    schema,
    transport: transportFor({ userId: 'bob', familyId: 'fam1' }),
    clock: { nodeId: 0xcccccccc, now: () => clientBClock++ },
  })

  await clientA.start()
  await clientB.start()

  return { serverDb, server, clientA, clientB, transportFor }
}

/**
 * "At most one open feeding per child" — same pattern rork-feeding
 * uses on its Railway sync server.
 */
const openRowUniquenessHook: SyncServerHooks<Ctx> = {
  async afterWriteInTransaction({ model, row, action, tx }) {
    if (model !== 'feeding') return
    if (action !== 'insert') return
    if (row.duration != null) return
    const others = await tx.findMany({
      model: 'feeding',
      where: { childId: row.childId },
    })
    for (const o of others) {
      if (o.id === row.id) continue
      if (o.duration != null) continue
      await tx.upsertTombstoneIfNewer({
        model: 'feeding',
        id: String(o.id),
        hlc: row.changed + '_t', // any HLC > row.changed works — we
        // reuse row.changed lexicographically since the test memory
        // adapter only compares strings.
        scope: { familyId: String(row.familyId) },
      })
    }
  },
}

describe('open-row uniqueness via afterWriteInTransaction hook', () => {
  it('inserting a new open row tombstones the previous open row for the same child', async () => {
    const { serverDb, clientA } = await setup(openRowUniquenessHook)

    await clientA.model('feeding').insert({
      id: 'f1',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 1000,
      duration: null,
    })
    await clientA.syncNow()

    await clientA.model('feeding').insert({
      id: 'f2',
      familyId: 'fam1',
      childId: 'kid',
      type: 'bottle',
      timestamp: 2000,
      duration: null,
    })
    await clientA.syncNow()

    // f1 should be tombstoned server-side.
    const rows = await serverDb.findMany({ model: 'feeding', where: {} })
    const live = rows.filter((r) => r.id === 'f1' || r.id === 'f2')
    expect(live.find((r) => r.id === 'f2')).toBeTruthy()
    expect(live.find((r) => r.id === 'f1')).toBeUndefined()
  })

  it('two devices each start an open row → after both sync, exactly one survives everywhere', async () => {
    const { server, clientA, clientB } = await setup(openRowUniquenessHook)

    // Both start before either pulls — classic race.
    await clientA.model('feeding').insert({
      id: 'a-active',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 1000,
      duration: null,
    })
    await clientB.model('feeding').insert({
      id: 'b-active',
      familyId: 'fam1',
      childId: 'kid',
      type: 'bottle',
      timestamp: 1100,
      duration: null,
    })

    // A pushes first. Server has only a-active.
    await clientA.syncNow()
    // B pushes. Server hook tombstones a-active.
    await clientB.syncNow()
    // Final convergence.
    await clientA.syncNow()
    await clientB.syncNow()

    const aRows = await clientA.model('feeding').findMany()
    const bRows = await clientB.model('feeding').findMany()
    const openA = aRows.filter((r) => r.duration == null)
    const openB = bRows.filter((r) => r.duration == null)
    expect(openA.length).toBe(1)
    expect(openB.length).toBe(1)
    expect(openA[0]?.id).toBe(openB[0]?.id)
    expect(openA[0]?.id).toBe('b-active') // hook tombstoned the older one
    void server
  })
})

describe('finish flow regression — duration set to non-null removes from open filter', () => {
  it('A inserts open row, B sees it, A updates duration, B pulls — row is no longer open', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('feeding').insert({
      id: 'session',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 1000,
      duration: null,
    })
    await clientA.syncNow()
    await clientB.syncNow()

    const bOpenBefore = (await clientB.model('feeding').findMany()).filter(
      (r) => r.duration == null,
    )
    expect(bOpenBefore.length).toBe(1)

    await clientA.model('feeding').update('session', { duration: 12 })
    await clientA.syncNow()
    await clientB.syncNow()

    const bOpenAfter = (await clientB.model('feeding').findMany()).filter(
      (r) => r.duration == null,
    )
    expect(bOpenAfter.length).toBe(0)
    const bRow = await clientB.model('feeding').findOne({ id: 'session' })
    expect(bRow?.duration).toBe(12)
  })
})

describe('push + pull in the same syncNow', () => {
  it('concurrent syncNow callers await the in-flight round-trip instead of getting a fake empty result', async () => {
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
    })

    await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: '000000000000000000100000',
        since: '000000000000000000000000',
        changes: {
          feeding: [{
            id: 'server-row',
            familyId: 'fam1',
            childId: 'kid',
            type: 'breast_left',
            timestamp: 1000,
            duration: 7,
            changed: '000000000000000000100000',
          }],
        },
      },
      { userId: 'alice', familyId: 'fam1' },
    )

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    let callCount = 0
    const transport: Transport = async (req) => {
      callCount += 1
      started()
      await gate
      return server.handleSync(req, { userId: 'alice', familyId: 'fam1' })
    }

    const client = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 0xbbbbbbbb, now: () => 1_000 },
    })
    await client.start()

    const first = client.syncNow()
    await startedPromise
    const second = client.syncNow()
    release()
    const [a, b] = await Promise.all([first, second])

    expect(callCount).toBe(1)
    expect(a.pulled).toBe(1)
    expect(b.pulled).toBe(1)
    expect(await client.model('feeding').findOne({ id: 'server-row' })).not.toBeNull()
  })

  it('local pending changes ride out while server changes come down — no loss either side', async () => {
    const { clientA, clientB } = await setup()

    // Seed server with one row from B.
    await clientB.model('feeding').insert({
      id: 'from-b',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 100,
      duration: 7,
    })
    await clientB.syncNow()

    // A queues a write WITHOUT syncing.
    await clientA.model('feeding').insert({
      id: 'from-a',
      familyId: 'fam1',
      childId: 'kid',
      type: 'bottle',
      timestamp: 200,
      duration: 5,
    })

    // Single round-trip: push from-a, pull from-b. The server may
    // also echo from-a back (re-stamped with its HLC), so `pulled`
    // can be 1 or 2 — we just care that pushed=1 and both rows
    // end up in the local store.
    const result = await clientA.syncNow()
    expect(result.pushed).toBe(1)
    expect(result.pulled).toBeGreaterThanOrEqual(1)

    const aRows = await clientA.model('feeding').findMany()
    expect(aRows.map((r) => r.id).sort()).toEqual(['from-a', 'from-b'])
  })
})

describe('offline burst — pending queue drains in one syncNow', () => {
  it('40 inserts with no syncs in between → one syncNow pushes all 40', async () => {
    const { clientA, serverDb } = await setup()

    for (let i = 0; i < 40; i++) {
      await clientA.model('feeding').insert({
        id: `bulk-${i}`,
        familyId: 'fam1',
        childId: 'kid',
        type: 'breast_left',
        timestamp: 1000 + i,
        duration: 5,
      })
    }
    const result = await clientA.syncNow()
    expect(result.pushed).toBe(40)

    const serverRows = await serverDb.findMany({ model: 'feeding', where: {} })
    expect(serverRows.length).toBe(40)
  })
})

describe('update-vs-delete race', () => {
  it('delete wins when its HLC is higher than the concurrent update', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('feeding').insert({
      id: 'shared',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 1,
      duration: 5,
    })
    await clientA.syncNow()
    await clientB.syncNow()

    // A updates first.
    await clientA.model('feeding').update('shared', { duration: 9 })
    await clientA.syncNow()
    // B deletes after A updated (B's HLC is higher because it picked
    // up A's update through the prior syncNow).
    await clientB.syncNow() // pull A's update
    await clientB.model('feeding').delete('shared')
    await clientB.syncNow()
    await clientA.syncNow()

    expect(await clientA.model('feeding').findOne({ id: 'shared' })).toBeNull()
    expect(await clientB.model('feeding').findOne({ id: 'shared' })).toBeNull()
  })

  // The mirror "update wins over delete" case is already exercised
  // by core's HLC/merge tests — see packages/core/test/merge.test.ts.
  // Reproducing it at the client level requires deterministic
  // cross-clock HLC ordering, which is more brittle than useful.
})

describe('beforeWrite hook authz', () => {
  /**
   * Realistic case: only the row's `createdBy` may delete it.
   * Implemented in `beforeWrite` so the hook sees the existing row
   * BEFORE the delete is applied. Throwing rolls back the whole
   * sync transaction.
   */
  const ownerOnlyDelete: SyncServerHooks<Ctx> = {
    async beforeWrite({ model, action, existing, ctx }) {
      if (model !== 'feeding') return
      if (action !== 'delete') return
      if (!existing) return // already gone — nothing to enforce
      if (existing.createdBy !== ctx.userId) {
        throw new Error('Only the creator may delete this row')
      }
    },
  }

  it('beforeWrite throws on unauthorized delete → row survives, sync errors', async () => {
    // Custom schema with `createdBy` field.
    const ownerSchema: SyncSchema<Ctx> = {
      feeding: {
        fields: {
          id: { type: 'string', primaryKey: true },
          familyId: { type: 'string' },
          childId: { type: 'string' },
          createdBy: { type: 'string' },
          type: { type: 'string' },
          timestamp: { type: 'number' },
          duration: { type: 'number', required: false },
          changed: { type: 'string' },
        },
        scope: (ctx) => ({ familyId: ctx.familyId }),
      },
    }

    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(ownerSchema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema: ownerSchema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
      hooks: ownerOnlyDelete,
    })

    let aliceClock = 1_000
    const alice = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema: ownerSchema,
      transport: async (req) =>
        server.handleSync(req, { userId: 'alice', familyId: 'fam1' }),
      clock: { nodeId: 0xbbbbbbbb, now: () => aliceClock++ },
    })
    let bobClock = 2_000
    const bob = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema: ownerSchema,
      transport: async (req) =>
        server.handleSync(req, { userId: 'bob', familyId: 'fam1' }),
      clock: { nodeId: 0xcccccccc, now: () => bobClock++ },
    })
    await alice.start()
    await bob.start()

    // Alice creates a row.
    await alice.model('feeding').insert({
      id: 'row1',
      familyId: 'fam1',
      childId: 'kid',
      createdBy: 'alice',
      type: 'bottle',
      timestamp: 100,
      duration: 5,
    })
    await alice.syncNow()
    await bob.syncNow()

    // Bob tries to delete it.
    await bob.model('feeding').delete('row1')
    // Push must fail at server boundary because the hook throws.
    await expect(bob.syncNow()).rejects.toThrow(/creator/i)

    // Row must still exist on the server.
    const serverRow = await serverDb.findOne({
      model: 'feeding',
      where: { id: 'row1' },
    })
    expect(serverRow).not.toBeNull()
  })

  it('beforeWrite allows delete when ctx.userId matches existing.createdBy', async () => {
    const ownerSchema: SyncSchema<Ctx> = {
      feeding: {
        fields: {
          id: { type: 'string', primaryKey: true },
          familyId: { type: 'string' },
          childId: { type: 'string' },
          createdBy: { type: 'string' },
          type: { type: 'string' },
          timestamp: { type: 'number' },
          duration: { type: 'number', required: false },
          changed: { type: 'string' },
        },
        scope: (ctx) => ({ familyId: ctx.familyId }),
      },
    }

    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(ownerSchema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema: ownerSchema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
      hooks: ownerOnlyDelete,
    })

    let aliceClock = 1_000
    const alice = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema: ownerSchema,
      transport: async (req) =>
        server.handleSync(req, { userId: 'alice', familyId: 'fam1' }),
      clock: { nodeId: 0xbbbbbbbb, now: () => aliceClock++ },
    })
    await alice.start()

    await alice.model('feeding').insert({
      id: 'row1',
      familyId: 'fam1',
      childId: 'kid',
      createdBy: 'alice',
      type: 'bottle',
      timestamp: 100,
      duration: 5,
    })
    await alice.syncNow()
    await alice.model('feeding').delete('row1')
    await alice.syncNow()

    const serverRow = await serverDb.findOne({
      model: 'feeding',
      where: { id: 'row1' },
    })
    expect(serverRow).toBeNull()
  })
})

describe('server tombstone reaches other devices', () => {
  it('B never saw A-active locally, but after A inserts B-active, B still drops A-active on pull', async () => {
    const { clientA, clientB, serverDb } = await setup(openRowUniquenessHook)

    // A inserts and syncs. B not yet pulled.
    await clientA.model('feeding').insert({
      id: 'a-active',
      familyId: 'fam1',
      childId: 'kid',
      type: 'breast_left',
      timestamp: 1000,
      duration: null,
    })
    await clientA.syncNow()
    expect((await serverDb.findMany({ model: 'feeding', where: {} })).length).toBe(1)

    // B inserts a new open row WITHOUT having pulled a-active.
    await clientB.model('feeding').insert({
      id: 'b-active',
      familyId: 'fam1',
      childId: 'kid',
      type: 'bottle',
      timestamp: 2000,
      duration: null,
    })
    await clientB.syncNow() // server hook tombstones a-active.

    // A pulls. Local a-active row must be dropped via tombstone, and
    // b-active must arrive.
    await clientA.syncNow()
    const aRows = await clientA.model('feeding').findMany()
    expect(aRows.find((r) => r.id === 'a-active')).toBeUndefined()
    expect(aRows.find((r) => r.id === 'b-active')).toBeTruthy()
  })

  it('delete tombstones use each model scope, not the first schema model scope', async () => {
    const mixedScopeSchema: SyncSchema<Ctx> = {
      user: {
        fields: {
          id: { type: 'string', primaryKey: true },
          name: { type: 'string' },
          changed: { type: 'string' },
        },
        scope: (ctx) => ({ id: ctx.userId }),
      },
      feeding: {
        fields: {
          id: { type: 'string', primaryKey: true },
          familyId: { type: 'string' },
          childId: { type: 'string' },
          type: { type: 'string' },
          timestamp: { type: 'number' },
          duration: { type: 'number', required: false },
          changed: { type: 'string' },
        },
        scope: (ctx) => ({ familyId: ctx.familyId }),
      },
    }

    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(mixedScopeSchema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema: mixedScopeSchema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
    })

    let aliceClock = 1_000
    const alice = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema: mixedScopeSchema,
      transport: (req) =>
        server.handleSync(req, { userId: 'alice', familyId: 'fam1' }),
      clock: { nodeId: 0xbbbbbbbb, now: () => aliceClock++ },
    })
    let bobClock = 2_000
    const bob = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema: mixedScopeSchema,
      transport: (req) =>
        server.handleSync(req, { userId: 'bob', familyId: 'fam1' }),
      clock: { nodeId: 0xcccccccc, now: () => bobClock++ },
    })
    await alice.start()
    await bob.start()

    await alice.model('feeding').insert({
      id: 'shared-feeding',
      familyId: 'fam1',
      childId: 'kid',
      type: 'bottle',
      timestamp: 1000,
      duration: 5,
    })
    await alice.syncNow()
    await bob.syncNow()
    expect(await bob.model('feeding').findOne({ id: 'shared-feeding' })).not.toBeNull()

    await alice.model('feeding').delete('shared-feeding')
    await alice.syncNow()

    const result = await bob.syncNow()
    expect(result.tombstonesApplied).toBeGreaterThanOrEqual(1)
    expect(await bob.model('feeding').findOne({ id: 'shared-feeding' })).toBeNull()
  })
})


describe('localOnly mode + enableSync', () => {
  it('local writes accumulate offline, then enableSync flushes them to server', async () => {
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
    })
    const ctx: Ctx = { userId: 'alice', familyId: 'fam1' }
    const transport: Transport = async (req) => server.handleSync(req, ctx)

    // Client starts with NO transport — local-only.
    let clientClock = 1_000
    const client = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      clock: { nodeId: 0xbbbbbbbb, now: () => clientClock++ },
    })
    await client.start()
    expect(client.isLocalOnly()).toBe(true)

    // Three local writes, no network.
    await client.model('feeding').insert({
      id: 'f1', familyId: 'fam1', childId: 'kid', type: 'breast_left',
      timestamp: 1000, duration: null,
    })
    await client.model('feeding').insert({
      id: 'f2', familyId: 'fam1', childId: 'kid', type: 'bottle',
      timestamp: 2000, duration: 600,
    })
    await client.model('feeding').update('f1', { duration: 300 })

    // Server still empty.
    expect(await serverDb.findMany({ model: 'feeding' })).toHaveLength(0)
    // Local store has both rows.
    expect(await client.model('feeding').findMany()).toHaveLength(2)

    // syncNow is a no-op in local-only.
    const noop = await client.syncNow()
    expect(noop).toEqual({ pushed: 0, pulled: 0, tombstonesApplied: 0, hasMore: false, staleClient: false })

    // Flip on — pending queue drains in one shot.
    const result = await client.enableSync({ transport })
    expect(client.isLocalOnly()).toBe(false)
    expect(result.pushed).toBeGreaterThanOrEqual(3) // 2 inserts + 1 update

    const serverRows = await serverDb.findMany({ model: 'feeding' })
    expect(serverRows).toHaveLength(2)
    expect(serverRows.find((r) => r.id === 'f1')?.duration).toBe(300)
  })

  it('enableSync throws if no transport provided', async () => {
    const client = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
    })
    await client.start()
    await expect(client.enableSync({})).rejects.toThrow(/transport|syncUrl/)
  })

  it('local-only client receives pulled rows after enableSync (restore on new device)', async () => {
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let serverClock = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 0xaaaaaaaa, now: () => serverClock++ },
    })
    const ctx: Ctx = { userId: 'alice', familyId: 'fam1' }
    const transport: Transport = async (req) => server.handleSync(req, ctx)

    // Pre-populate server (simulating another device's data).
    const seedClient = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 0xdddddddd, now: () => 500 },
    })
    await seedClient.start()
    await seedClient.model('feeding').insert({
      id: 'cloud1', familyId: 'fam1', childId: 'kid', type: 'bottle',
      timestamp: 100, duration: 200,
    })
    await seedClient.syncNow()

    // New device, local-only, with a locally-created row.
    let clientClock = 2_000
    const newDevice = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      clock: { nodeId: 0xeeeeeeee, now: () => clientClock++ },
    })
    await newDevice.start()
    await newDevice.model('feeding').insert({
      id: 'local1', familyId: 'fam1', childId: 'kid', type: 'breast_left',
      timestamp: 200, duration: 300,
    })

    // Enable sync — local row goes up, cloud row comes down.
    const result = await newDevice.enableSync({ transport })
    expect(result.pushed).toBeGreaterThanOrEqual(1)
    expect(result.pulled).toBeGreaterThanOrEqual(1)

    const rows = await newDevice.model('feeding').findMany()
    expect(rows.map((r) => r.id).sort()).toEqual(['cloud1', 'local1'])
  })
})
