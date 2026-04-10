/**
 * End-to-end test: real server + two real clients, in-process.
 *
 * No HTTP, no network. The transport is a direct function call into
 * `server.handleSync(request, ctx)`. This proves the full pipeline works:
 * local write → client pending queue → syncNow → server transaction →
 * scope enforcement → tombstone denormalization → server → client merge →
 * other client sees the change.
 */

import { describe, expect, it } from 'vitest'
import type { SyncRequest, SyncSchema } from '@better-sync/core'
import { memoryAdapter } from '@better-sync/memory-adapter'
import { createSyncServer } from '@better-sync/server'
import { createSyncClient, type Transport } from '../src/index'

interface Ctx {
  userId: string
}

const schema: SyncSchema<Ctx> = {
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string', required: false },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
}

interface Setup {
  server: ReturnType<typeof createSyncServer<Ctx>>
  serverDb: ReturnType<typeof memoryAdapter>
  clientA: ReturnType<typeof createSyncClient<Ctx>>
  clientB: ReturnType<typeof createSyncClient<Ctx>>
  transportFor(userId: string): Transport
}

async function setup(): Promise<Setup> {
  const serverDb = memoryAdapter()
  await serverDb.ensureSyncTables(schema)

  let serverClockTime = 10_000
  const server = createSyncServer<Ctx>({
    database: serverDb,
    schema,
    clock: {
      nodeId: 0xaaaaaaaa,
      now: () => serverClockTime++,
    },
  })

  const transportFor = (userId: string): Transport => {
    return async (req: SyncRequest) => {
      return server.handleSync(req, { userId })
    }
  }

  let clientAClockTime = 1000
  const clientA = createSyncClient<Ctx>({
    database: memoryAdapter(),
    schema,
    transport: transportFor('alice'),
    clock: { nodeId: 0xbbbbbbbb, now: () => clientAClockTime++ },
  })

  let clientBClockTime = 2000
  const clientB = createSyncClient<Ctx>({
    database: memoryAdapter(),
    schema,
    transport: transportFor('alice'), // same user, two devices
    clock: { nodeId: 0xcccccccc, now: () => clientBClockTime++ },
  })

  await clientA.start()
  await clientB.start()

  return { server, serverDb, clientA, clientB, transportFor }
}

describe('two-client convergence (same user, two devices)', () => {
  it('A writes → A syncs → B syncs → B sees the row', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'From A',
    })
    const aPush = await clientA.syncNow()
    expect(aPush.pushed).toBe(1)

    const bPull = await clientB.syncNow()
    expect(bPull.pulled).toBe(1)

    const seen = await clientB.model('project').findOne({ id: 'p1' })
    expect(seen?.title).toBe('From A')
  })

  it('bidirectional: A and B both write, both see each other after two rounds', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('project').insert({
      id: 'from-a',
      userId: 'alice',
      title: 'A wrote this',
    })
    await clientB.model('project').insert({
      id: 'from-b',
      userId: 'alice',
      title: 'B wrote this',
    })

    // Round 1: both push
    await clientA.syncNow()
    await clientB.syncNow()
    // Round 2: both pull to see each other
    await clientA.syncNow()
    await clientB.syncNow()

    const aSees = await clientA.model('project').findMany()
    const bSees = await clientB.model('project').findMany()
    expect(aSees.length).toBe(2)
    expect(bSees.length).toBe(2)
    expect(aSees.some((r) => r.id === 'from-b')).toBe(true)
    expect(bSees.some((r) => r.id === 'from-a')).toBe(true)
  })

  it('update from A propagates to B', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'v1',
    })
    await clientA.syncNow()
    await clientB.syncNow()

    await clientA.model('project').update('p1', { title: 'v2' })
    await clientA.syncNow()
    await clientB.syncNow()

    const seen = await clientB.model('project').findOne({ id: 'p1' })
    expect(seen?.title).toBe('v2')
  })

  it('delete from A propagates to B', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'will be deleted',
    })
    await clientA.syncNow()
    await clientB.syncNow()

    const bBefore = await clientB.model('project').findOne({ id: 'p1' })
    expect(bBefore?.title).toBe('will be deleted')

    await clientA.model('project').delete('p1')
    await clientA.syncNow()
    await clientB.syncNow()

    const bAfter = await clientB.model('project').findOne({ id: 'p1' })
    expect(bAfter).toBeNull()
  })

  it('LWW — later HLC wins when both clients modify the same row', async () => {
    const { clientA, clientB } = await setup()

    await clientA.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'original',
    })
    await clientA.syncNow()
    await clientB.syncNow()

    // Both clients modify the row while "offline"
    await clientA.model('project').update('p1', { title: 'A wins' })
    await clientB.model('project').update('p1', { title: 'B wins' })
    // A's HLC wall starts at 1000, B's at 2000 → B's HLCs are larger.
    // Therefore B's write should win after both sync.

    await clientA.syncNow()
    await clientB.syncNow()
    await clientA.syncNow() // pull B's write

    const final = await clientA.model('project').findOne({ id: 'p1' })
    expect(final?.title).toBe('B wins')
  })
})

describe('cross-tenant isolation via direct transport', () => {
  it('bob cannot see alice data even through the same server', async () => {
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let tick = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 1, now: () => tick++ },
    })

    const transportAs = (userId: string): Transport => async (req: SyncRequest) =>
      server.handleSync(req, { userId })

    let clientTick = 500
    const aliceClient = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      transport: transportAs('alice'),
      clock: { nodeId: 2, now: () => clientTick++ },
    })
    const bobClient = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      transport: transportAs('bob'),
      clock: { nodeId: 3, now: () => clientTick++ },
    })
    await aliceClient.start()
    await bobClient.start()

    await aliceClient.model('project').insert({
      id: 'secret',
      userId: 'alice',
      title: 'alice secret',
    })
    await aliceClient.syncNow()

    await bobClient.syncNow()
    const bobSees = await bobClient.model('project').findMany()
    expect(bobSees.length).toBe(0)

    // Alice can still see her own data
    await aliceClient.syncNow()
    const aliceSees = await aliceClient.model('project').findOne({ id: 'secret' })
    expect(aliceSees?.title).toBe('alice secret')
  })

  it('rejects cross-tenant write attempt at server boundary', async () => {
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let tick = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 1, now: () => tick++ },
    })

    // Alice-authenticated client with a tampered local row that says userId=bob
    const tamperedTransport: Transport = async (req) =>
      server.handleSync(req, { userId: 'alice' })

    let clientTick = 500
    const client = createSyncClient<Ctx>({
      database: memoryAdapter(),
      schema,
      transport: tamperedTransport,
      clock: { nodeId: 2, now: () => clientTick++ },
    })
    await client.start()

    await client.model('project').insert({
      id: 'tamper',
      userId: 'bob', // tamper: alice writing as bob
      title: 'evil',
    })
    let caught: unknown = null
    try {
      await client.syncNow()
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    expect((caught as { code?: string }).code).toBe('SCOPE_VIOLATION')
  })
})
