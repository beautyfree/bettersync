/**
 * Multi-call pagination across model boundaries.
 *
 * Reproduces the production bug fixed in client@0.0.4 + server@0.0.4:
 *   - server hard-caps per-page rows at `limit` and returns
 *     { hasMore: true, cursor: { model, hlc, id } }
 *   - client previously discarded the cursor, advanced last_sync_hlc to
 *     response.serverTime, and lost every row past the first page
 *   - server previously sliced modelOrder to [cursor.model] only, so even
 *     when the cursor was sent, models AFTER the cursored one never got
 *     served on the resume request
 *
 * The test forces a single feeding-like model + a second model so a full
 * drain requires (a) cursor roundtrip and (b) modelOrder suffix.
 */

import { describe, expect, it } from 'vitest'
import type { SyncRequest, SyncSchema } from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
import { createSyncServer } from '@bettersync/server'
import { createSyncClient, type Transport } from '../src/index'

interface Ctx {
  userId: string
}

const schema: SyncSchema<Ctx> = {
  feeding: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      label: { type: 'string' },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
  // Declared AFTER feeding so a slice([cursor.model:]) skip would
  // strand every weight row.
  weight: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      kg: { type: 'string' },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
}

async function buildSetup(serverLimit: number) {
  const serverDb = memoryAdapter()
  await serverDb.ensureSyncTables(schema)

  let serverClockTime = 10_000
  const server = createSyncServer<Ctx>({
    database: serverDb,
    schema,
    clock: { nodeId: 0xaaaaaaaa, now: () => serverClockTime++ },
  })

  const transport: Transport = async (req: SyncRequest) => {
    // Force a tiny server-side limit so pagination kicks in even with
    // a handful of rows. We piggyback on the request limit — server
    // caps to min(request.limit, internal cap), and the internal cap is
    // 1000, so any value <=1000 passes through.
    return server.handleSync({ ...req, limit: serverLimit }, { userId: 'alice' })
  }

  // Seed the server with rows BEFORE the client connects, so client's
  // initial syncNow drains a populated server.
  let clockTime = 100_000
  for (let i = 0; i < 7; i++) {
    await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: String(clockTime + i).padStart(24, '0'),
        since: '000000000000000000000000',
        changes: {
          feeding: [
            {
              id: `f${i}`,
              userId: 'alice',
              label: `feeding-${i}`,
              changed: String(clockTime + i).padStart(24, '0'),
            },
          ],
        },
      },
      { userId: 'alice' },
    )
  }
  for (let i = 0; i < 4; i++) {
    await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: String(clockTime + 1000 + i).padStart(24, '0'),
        since: '000000000000000000000000',
        changes: {
          weight: [
            {
              id: `w${i}`,
              userId: 'alice',
              kg: String(3 + i * 0.5),
              changed: String(clockTime + 1000 + i).padStart(24, '0'),
            },
          ],
        },
      },
      { userId: 'alice' },
    )
  }

  let clientClockTime = 1_000
  const client = createSyncClient<Ctx>({
    database: memoryAdapter(),
    schema,
    transport,
    clock: { nodeId: 0xbbbbbbbb, now: () => clientClockTime++ },
  })

  await client.start()
  return { server, client }
}

describe('cross-call pagination drain', () => {
  it('client follows nextCursor across multiple syncNow calls and pulls every row past the per-page limit', async () => {
    // Per-page limit of 3 → 7 feedings + 4 weights = 11 rows total → at
    // least 3 round trips required. Without the cursor roundtrip the
    // client would stop after the first page (3 feedings).
    const { client } = await buildSetup(3)

    let total = 0
    let rounds = 0
    for (let i = 0; i < 50; i++) {
      const res = await client.syncNow()
      rounds += 1
      total += res.pulled
      if (!res.hasMore) break
    }

    expect(rounds).toBeGreaterThan(1)
    const feedings = await client.model('feeding').findMany()
    const weights = await client.model('weight').findMany()
    expect(feedings.length).toBe(7)
    expect(weights.length).toBe(4)
    expect(total).toBe(11)
  })

  it('once drained, subsequent syncNow returns hasMore=false and pulled=0', async () => {
    const { client } = await buildSetup(3)

    // Drain
    for (let i = 0; i < 50; i++) {
      const res = await client.syncNow()
      if (!res.hasMore) break
    }

    const idle = await client.syncNow()
    expect(idle.hasMore).toBe(false)
    expect(idle.pulled).toBe(0)
  })

  it('server returns models AFTER cursor.model in the schema order on resume', async () => {
    // Lower-level probe: hit handleSync directly and inspect the response
    // shape on the second round trip. We expect both `feeding` (remaining)
    // and `weight` (untouched on first page) to show up.
    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let now = 10_000
    const server = createSyncServer<Ctx>({
      database: serverDb,
      schema,
      clock: { nodeId: 0xaaaaaaaa, now: () => now++ },
    })

    // Seed
    let clockTime = 100_000
    for (let i = 0; i < 5; i++) {
      await server.handleSync(
        {
          protocolVersion: '1.0.0',
          clientTime: String(clockTime + i).padStart(24, '0'),
          since: '000000000000000000000000',
          changes: {
            feeding: [
              {
                id: `f${i}`,
                userId: 'alice',
                label: `f-${i}`,
                changed: String(clockTime + i).padStart(24, '0'),
              },
            ],
          },
        },
        { userId: 'alice' },
      )
    }
    await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: String(clockTime + 500).padStart(24, '0'),
        since: '000000000000000000000000',
        changes: {
          weight: [
            {
              id: 'w0',
              userId: 'alice',
              kg: '3.5',
              changed: String(clockTime + 500).padStart(24, '0'),
            },
          ],
        },
      },
      { userId: 'alice' },
    )

    // Page 1 — feeding hits per-page limit of 3, server pauses there.
    const page1 = await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: '000000000000000000000000',
        since: '000000000000000000000000',
        limit: 3,
      },
      { userId: 'alice' },
    )
    expect(page1.hasMore).toBe(true)
    expect(page1.cursor?.model).toBe('feeding')
    expect((page1.changes.feeding ?? []).length).toBe(3)
    expect(page1.changes.weight).toBeUndefined()

    // Page 2 — resume with cursor. Must include remaining feedings AND
    // weight (declared after feeding in schema order).
    const page2 = await server.handleSync(
      {
        protocolVersion: '1.0.0',
        clientTime: '000000000000000000000000',
        since: '000000000000000000000000',
        limit: 3,
        cursor: page1.cursor!,
      },
      { userId: 'alice' },
    )
    const feedingsP2 = page2.changes.feeding ?? []
    const weightsP2 = page2.changes.weight ?? []
    expect(feedingsP2.length).toBe(2)
    expect(weightsP2.length).toBe(1)
    expect(page2.hasMore).toBe(false)
  })
})
