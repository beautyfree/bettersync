import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type SyncRequest,
  type SyncResponse,
  type SyncSchema,
} from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
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
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
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

describe('createSyncClient local-first API', () => {
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
      sinceHlc: '000000000000000000000000',
      limit: 10,
      scope: { userId: 'alice' },
    })
    expect(tombs.length).toBe(1)
    expect(tombs[0]?.id).toBe('p1')
  })
})

describe('syncNow round-trip', () => {
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
})

describe('client errors', () => {
  it('throws when used before start()', async () => {
    const { transport } = mockTransport(() =>
      emptyResponse('000001000000000000000000'),
    )
    const client = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 1, now: () => 1000 },
    })
    expect(() => client.model('project')).toThrow(/start/)
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
