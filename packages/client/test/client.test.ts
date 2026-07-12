import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  type SyncRequest,
  type SyncRealtimeEvent,
  type SyncResponse,
  type SyncSchema,
} from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
import { createSyncClient, type RealtimeHandlers, type Transport } from '../src/index'

interface Ctx {
  userId: string
}

const schema: SyncSchema<Ctx> = {
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      title: { type: 'string' },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
    tombstoneScope: ['userId'],
  },
}

/** A transport that records requests and returns a configurable response. */
function mockTransport(
  response: (req: SyncRequest) => SyncResponse,
): {
  transport: Transport
  requests: SyncRequest[]
} {
  const requests: SyncRequest[] = []
  const transport: Transport = async (req) => {
    requests.push(req)
    return response(req)
  }
  return { transport, requests }
}

function emptyResponse(serverTime: string): SyncResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverTime,
    changes: {},
    tombstones: [],
    hasMore: false,
    cursor: null,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSyncClient local-first API', () => {
  it('rejects a non-advancing pagination drain instead of keeping callers pending', async () => {
    let requests = 0
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      clock: { nodeId: 1, now: () => 1000 },
      transport: async () => {
        requests += 1
        return {
          ...emptyResponse(`0000010000000000000000${String(requests).padStart(2, '0')}`),
          hasMore: true,
          cursor: { model: 'project', hlc: '000001000000000000000001', id: 'p1' },
        }
      },
    })

    await expect(client.syncNow({ drain: true })).rejects.toThrow(
      'Sync pagination did not complete after 50 pages',
    )
    expect(requests).toBe(50)
    expect((await client.status()).isSyncing).toBe(false)
  })

  it('insert writes to local store with HLC changed field', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    const inserted = await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'Hello',
    })
    expect(inserted.id).toBe('p1')
    expect(typeof inserted.changed).toBe('string')
    expect((inserted.changed as string).length).toBe(24)

    const found = await client.model('project').findOne({ id: 'p1' })
    expect(found?.title).toBe('Hello')
  })

  it('update merges patch and ticks HLC', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    const v1 = await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'v1',
    })
    const v2 = await client.model('project').update('p1', { title: 'v2' })
    expect(v2.title).toBe('v2')
    expect(v2.userId).toBe('alice')
    expect(String(v2.changed)).not.toBe(String(v1.changed))
    expect(String(v2.changed) > String(v1.changed)).toBe(true)
  })

  it('delete removes row and writes tombstone locally', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const db = memoryAdapter()
    const client = createSyncClient({
      database: db,
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'Hello',
    })
    await client.model('project').delete('p1')

    const found = await client.model('project').findOne({ id: 'p1' })
    expect(found).toBeNull()

    const tombs = await db.findTombstonesSince({
      model: 'project',
      sinceHlc: '000000000000000000000000',
      limit: 10,
      scope: { userId: 'alice' },
    })
    expect(tombs.tombstones).toHaveLength(1)
    expect(tombs.tombstones[0]?.id).toBe('p1')
  })

  it('rejects delete of a missing local row instead of queueing an unscoped tombstone', async () => {
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport: async () => emptyResponse('000001000000000000000000'),
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await expect(client.model('project').delete('missing')).rejects.toThrow(
      'delete on "project": row missing not found',
    )
    expect((await client.status()).pendingCount).toBe(0)
  })
})

describe('syncNow round-trip', () => {
  it('drains a bounded outbound batch without dropping queued operations', async () => {
    const { transport, requests } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWrite: false,
      maxPushBatchSize: 2,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()
    for (let index = 0; index < 5; index++) {
      await client.model('project').insert({ id: `p${index}`, userId: 'alice', title: 'queued' })
    }

    const result = await client.syncNow({ drain: true })
    expect(result.pushed).toBe(5)
    expect(requests).toHaveLength(3)
    expect(requests.map((request) =>
      Object.values(request.changes ?? {}).flat().length,
    )).toEqual([2, 2, 1])
    expect((await client.status()).pendingCount).toBe(0)
  })

  it('emits sync after isSyncing has been cleared', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })
    let statusAtSyncEvent: Awaited<ReturnType<typeof client.status>> | null = null
    client.on('sync', () => {
      void client.status().then((status) => {
        statusAtSyncEvent = status
      })
    })

    await client.syncNow({ drain: true })
    await waitFor(() => statusAtSyncEvent !== null)

    expect(statusAtSyncEvent?.isSyncing).toBe(false)
  })

  it('aborts a hung HTTP request so sync status cannot stay active forever', async () => {
    let aborted = false
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      }),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      syncUrl: 'https://sync.example.test/api/sync',
      syncRequestTimeoutMs: 10,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })

    await expect(client.syncNow()).rejects.toThrow('Sync request timed out after 10ms')
    expect(aborted).toBe(true)
    expect((await client.status()).isSyncing).toBe(false)
    expect((await client.status()).lastError?.message).toBe('Sync request timed out after 10ms')
  })

  it('settles the timeout even when fetch ignores AbortController', async () => {
    let aborted = false
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          // React Native fetch implementations may observe abort without
          // rejecting this Promise. The transport still must settle.
        })
      }),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      syncUrl: 'https://sync.example.test/api/sync',
      syncRequestTimeoutMs: 10,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })

    const outcome = await Promise.race([
      client.syncNow().then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 80)),
    ])

    expect(aborted).toBe(true)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('Sync request timed out after 10ms')
  })

  it('write { sync: remote } resolves only after pending queue reaches the server', async () => {
    const { transport, requests } = mockTransport(() =>
      emptyResponse('0000000027100001a1a2a3a4'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'remote',
    }, { sync: 'remote' })

    expect(requests.length).toBe(1)
    expect(requests[0]?.changes?.project?.[0]?.row.id).toBe('p1')

    await client.syncNow()
    expect(requests[1]?.changes).toBeUndefined()
  })

  it('auto sync-on-write attempts a background push without app glue code', async () => {
    const { transport, requests } = mockTransport(() =>
      emptyResponse('0000000027100001a1a2a3a4'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWriteDebounceMs: 1,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'auto',
    })

    await waitFor(() => requests.length > 0)
    expect(requests[0]?.changes?.project?.[0]?.row.id).toBe('p1')
  })

  it('realtime event wakes client and pulls remote changes immediately', async () => {
    let realtimeHandlers: RealtimeHandlers | null = null
    const remoteRow = {
      id: 'p2',
      userId: 'alice',
      title: 'remote',
      changed: '0000000027100001a1a2a3a4',
    }
    const { transport, requests } = mockTransport((req) => {
      if (requests.length <= 1) return emptyResponse('0000000027100001a1a2a3a4')
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverTime: '0000000027110001a1a2a3a4',
        changes: { project: [remoteRow] },
        tombstones: [],
        hasMore: false,
        cursor: null,
      }
    })
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      realtime: {
        subscribe(handlers) {
          realtimeHandlers = handlers
          return () => {
            realtimeHandlers = null
          }
        },
      },
      realtimeDebounceMs: 1,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()
    await client.syncNow()

    const event: SyncRealtimeEvent = {
      type: 'changes',
      models: ['project'],
      at: new Date().toISOString(),
    }
    realtimeHandlers?.onEvent(event)

    await waitFor(() => requests.length >= 2)
    const found = await client.model('project').findOne({ id: 'p2' })
    expect(found?.title).toBe('remote')
  })

  it('status exposes pending count, last sync timestamp, and last error', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('0000000027100001a1a2a3a4'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'pending',
    })
    const before = await client.status()
    expect(before.pendingCount).toBe(1)
    expect(before.lastSyncedAt).toBeNull()

    await client.syncNow()
    const after = await client.status()
    expect(after.pendingCount).toBe(0)
    expect(after.lastSyncedAt).toBeGreaterThan(0)
    expect(after.lastError).toBeNull()
  })

  it('sends pending changes to server and clears queue', async () => {
    const { transport, requests } = mockTransport(() =>
      emptyResponse('0000000027100001a1a2a3a4'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.model('project').insert({
      id: 'p1',
      userId: 'alice',
      title: 'one',
    })
    await client.model('project').insert({
      id: 'p2',
      userId: 'alice',
      title: 'two',
    })

    const result = await client.syncNow()
    expect(result.pushed).toBe(2)
    expect(requests.length).toBe(1)
    expect(requests[0]?.changes?.project?.length).toBe(2)

    // Pending queue was cleared — next syncNow sends nothing
    await client.syncNow()
    expect(requests[1]?.changes).toBeUndefined()
  })

  it('merges server response into local store', async () => {
    const db = memoryAdapter()
    const { transport } = mockTransport(() => ({
      protocolVersion: PROTOCOL_VERSION,
      serverTime: '0000000027100001a1a2a3a4',
      changes: {
        project: [
          {
            id: 'from-server',
            userId: 'alice',
            title: 'Server Pushed',
            changed: '000100000000000000000001',
          },
        ],
      },
      tombstones: [],
      hasMore: false,
      cursor: null,
    }))
    const client = createSyncClient({
      database: db,
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()
    const result = await client.syncNow()
    expect(result.pulled).toBe(1)
    const found = await db.findOne({ model: 'project', where: { id: 'from-server' } })
    expect(found?.title).toBe('Server Pushed')
  })

  it('advances since marker across sync calls', async () => {
    const serverTimeMarker = '0000000027100001a1a2a3a4'
    const { transport, requests } = mockTransport(() =>
      emptyResponse(serverTimeMarker),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()

    await client.syncNow()
    await client.syncNow()
    expect(requests[0]?.since).toBe('000000000000000000000000')
    expect(requests[1]?.since).toBe(serverTimeMarker)
  })

  it('recover clears stale pagination and drains the full snapshot', async () => {
    const checkpoint = '0000000027100001a1a2a3a4'
    const pageOneHlc = '0000000027110001a1a2a3a4'
    const pageTwoHlc = '0000000027120001a1a2a3a4'
    const { transport, requests } = mockTransport((request) => {
      if (requests.length === 1) return emptyResponse(checkpoint)

      // Recovery first flushes local pending writes. Model a stale cursor left
      // by that request: recovery must discard it before its full refetch.
      if (requests.length === 2) {
        return {
          ...emptyResponse(pageOneHlc),
          hasMore: true,
          cursor: { model: 'project', hlc: pageOneHlc, id: 'stale-page' },
        }
      }

      if (request.since === '000000000000000000000000' && !request.cursor) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverTime: pageOneHlc,
          changes: {
            project: [{ id: 'p1', userId: 'alice', title: 'first', changed: pageOneHlc }],
          },
          tombstones: [],
          hasMore: true,
          cursor: { model: 'project', hlc: pageOneHlc, id: 'p1' },
        }
      }

      if (request.cursor?.id === 'p1') {
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverTime: pageTwoHlc,
          changes: {
            project: [{ id: 'p2', userId: 'alice', title: 'second', changed: pageTwoHlc }],
          },
          tombstones: [],
          hasMore: false,
          cursor: null,
        }
      }

      throw new Error(`unexpected recovery request: ${JSON.stringify(request)}`)
    })
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })

    await client.syncNow()
    const result = await client.recover()

    expect(result.pulled).toBe(2)
    expect((await client.model('project').findMany()).map((row) => row.id).sort())
      .toEqual(['p1', 'p2'])
    expect(requests[2]).toMatchObject({
      since: '000000000000000000000000',
    })
    expect(requests[2]?.cursor).toBeUndefined()
  })
})

describe('client errors', () => {
  it('runs versioned local row migrations before the first sync', async () => {
    const migratingSchema: SyncSchema<Ctx> = {
      project: {
        ...schema.project,
        version: 1,
        migrations: {
          1: (row) => ({ ...row, title: `${String(row.title)} migrated` }),
        },
      },
    }
    const db = memoryAdapter()
    await db.ensureSyncTables(migratingSchema)
    await db.upsertIfNewer({
      model: 'project',
      row: {
        id: 'p1', userId: 'alice', title: 'legacy', changed: '000000000001000000000001',
      },
    })
    const { transport } = mockTransport(() => emptyResponse('000001000000000000000000'))
    const client = createSyncClient({
      database: db,
      schema: migratingSchema,
      transport,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })

    await client.start()
    expect((await client.model('project').findOne({ id: 'p1' }))?.title).toBe('legacy migrated')
  })

  it('can start again after stop without losing the initialized local store', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      syncOnWrite: false,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()
    await client.model('project').insert({ id: 'p1', userId: 'alice', title: 'kept' })
    client.stop()
    await client.start()

    expect((await client.status()).isStarted).toBe(true)
    expect((await client.model('project').findOne({ id: 'p1' }))?.title).toBe('kept')
  })

  it('lazy-inits on first use — no explicit start() needed', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    // model() is sync and just returns the accessor — no throw.
    const accessor = client.model('project')
    expect(typeof accessor.findMany).toBe('function')
    // First async call drives ensureSyncTables internally.
    const rows = await accessor.findMany()
    expect(Array.isArray(rows)).toBe(true)
  })

  it('throws when updating a missing row', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    await client.start()
    await expect(
      client.model('project').update('nonexistent', { title: 'x' }),
    ).rejects.toThrow(/not found/)
  })
})
