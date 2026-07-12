import { describe, expect, it, vi } from 'vitest'
import {
  encodeHlc,
  HLC_ZERO,
  isSyncError,
  PROTOCOL_VERSION,
  type SyncRequest,
  type SyncSchema,
} from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
import { createInMemoryRealtimeBus, createSyncServer } from '../src/index'

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
      createdAt: { type: 'date', input: false },
      internalNote: { type: 'string', required: false, output: false },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
    tombstoneScope: ['userId'],
  },
}

const hlcAt = (wall: number, logical = 0) =>
  encodeHlc({ wall, logical, node: 0xdeadbeef })

function upsertOp(row: Record<string, unknown>) {
  return { opId: `op-${String(row.id)}-${String(row.changed)}`, row }
}

function deleteOp(tombstone: { model: string; id: string; hlc: string; scope: Record<string, unknown> }) {
  return { opId: `delete-${tombstone.model}-${tombstone.id}-${tombstone.hlc}`, tombstone }
}

function freshServer() {
  const db = memoryAdapter()
  const server = createSyncServer<Ctx>({
    database: db,
    schema,
    clock: { nodeId: 0xbabecafe, now: () => 10_000 },
  })
  return { db, server }
}

async function initServer() {
  const { db, server } = freshServer()
  await db.ensureSyncTables(schema)
  return { db, server }
}

function baseRequest(overrides: Partial<SyncRequest> = {}): SyncRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientTime: hlcAt(1000),
    since: HLC_ZERO,
    ...overrides,
  }
}

describe('createSyncServer → handleSync: basic flow', () => {
  it('returns empty response for empty request on empty store', async () => {
    const { server } = await initServer()
    const res = await server.handleSync(baseRequest(), { userId: 'alice' })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(res.changes).toEqual({ project: [] })
    expect(res.tombstones).toEqual([])
    expect(res.hasMore).toBe(false)
  })

  it('persists client changes and returns them on next sync', async () => {
    const { db, server } = await initServer()
    await server.handleSync(
      baseRequest({
        changes: {
          project: [
            upsertOp({
              id: 'p1',
              userId: 'alice',
              title: 'Hello',
              changed: hlcAt(500),
            }),
          ],
        },
      }),
      { userId: 'alice' },
    )
    const stored = await db.findOne({ model: 'project', where: { id: 'p1' } })
    expect(stored?.title).toBe('Hello')
  })

  it('returns server-side rows that changed after since', async () => {
    const { db, server } = await initServer()
    await db.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'alice', title: 'Old', changed: hlcAt(100) },
    })
    await db.upsertIfNewer({
      model: 'project',
      row: { id: 'p2', userId: 'alice', title: 'New', changed: hlcAt(500) },
    })
    const res = await server.handleSync(
      baseRequest({ since: hlcAt(200) }),
      { userId: 'alice' },
    )
    expect(res.changes.project?.length).toBe(1)
    expect(res.changes.project?.[0]?.id).toBe('p2')
  })
})

describe('scope enforcement (P0 security)', () => {
  it('isolates tenants — alice cannot see bob rows', async () => {
    const { db, server } = await initServer()
    await db.upsertIfNewer({
      model: 'project',
      row: { id: 'pA', userId: 'alice', title: 'alice', changed: hlcAt(100) },
    })
    await db.upsertIfNewer({
      model: 'project',
      row: { id: 'pB', userId: 'bob', title: 'bob', changed: hlcAt(100) },
    })
    const aliceRes = await server.handleSync(baseRequest(), { userId: 'alice' })
    expect(aliceRes.changes.project?.length).toBe(1)
    expect(aliceRes.changes.project?.[0]?.id).toBe('pA')

    const bobRes = await server.handleSync(baseRequest(), { userId: 'bob' })
    expect(bobRes.changes.project?.length).toBe(1)
    expect(bobRes.changes.project?.[0]?.id).toBe('pB')
  })

  it('throws SCOPE_VIOLATION on cross-tenant write attempt', async () => {
    const { server } = await initServer()
    let caught: unknown = null
    try {
      await server.handleSync(
        baseRequest({
          changes: {
            project: [
              upsertOp({
                id: 'evil',
                userId: 'bob', // authenticated as alice
                title: 'hack',
                changed: hlcAt(500),
              }),
            ],
          },
        }),
        { userId: 'alice' },
      )
    } catch (err) {
      caught = err
    }
    expect(isSyncError(caught)).toBe(true)
    expect((caught as { code: string }).code).toBe('SCOPE_VIOLATION')
  })

  it('throws SCOPE_VIOLATION on cross-tenant tombstone', async () => {
    const { server } = await initServer()
    let caught: unknown = null
    try {
      await server.handleSync(
        baseRequest({
          tombstones: [
            deleteOp({
              model: 'project',
              id: 'pB',
              hlc: hlcAt(500),
              scope: { userId: 'bob' }, // alice trying to delete bob's row
            }),
          ],
        }),
        { userId: 'alice' },
      )
    } catch (err) {
      caught = err
    }
    expect(isSyncError(caught)).toBe(true)
    expect((caught as { code: string }).code).toBe('SCOPE_VIOLATION')
  })
})

describe('immutable client operations', () => {
  it('accepts legacy v1 writes and deletes during a rolling upgrade', async () => {
    const { db, server } = await initServer()
    await server.handleSync(baseRequest({
      changes: {
        project: [{ id: 'legacy', userId: 'alice', title: 'kept', changed: hlcAt(500) }],
      },
    }), { userId: 'alice' })
    expect((await db.findOne({ model: 'project', where: { id: 'legacy' } }))?.title).toBe('kept')

    await server.handleSync(baseRequest({
      tombstones: [{ model: 'project', id: 'legacy', hlc: hlcAt(600), scope: { userId: 'alice' } }],
    }), { userId: 'alice' })
    expect(await db.findOne({ model: 'project', where: { id: 'legacy' } })).toBeNull()
  })

  it('keeps only declared scope fields from a legacy tombstone', async () => {
    const { db, server } = await initServer()
    await server.handleSync(baseRequest({
      tombstones: [{
        model: 'project',
        id: 'legacy-private-scope',
        hlc: hlcAt(600),
        // 0.x clients put most scalar row fields here. They must not become
        // tombstone payload once the server has the explicit scope contract.
        scope: { userId: 'alice', title: 'private title', content: 'private body' },
      }],
    }), { userId: 'alice' })

    const stored = await db.findTombstonesSince({
      model: 'project',
      sinceHlc: HLC_ZERO,
      limit: 10,
      scope: { userId: 'alice' },
    })
    expect(stored.tombstones).toHaveLength(1)
    expect(stored.tombstones[0]?.scope).toEqual({ userId: 'alice' })
  })

  it('does not re-stamp a replayed operation after its HTTP response was lost', async () => {
    const { db, server } = await initServer()
    const first = upsertOp({
      id: 'p1', userId: 'alice', title: 'first', changed: hlcAt(500),
    })
    await server.handleSync(baseRequest({ changes: { project: [first] } }), { userId: 'alice' })

    await server.handleSync(
      baseRequest({
        clientTime: hlcAt(2_000),
        changes: {
          project: [upsertOp({ id: 'p1', userId: 'alice', title: 'newer', changed: hlcAt(1_500) })],
        },
      }),
      { userId: 'alice' },
    )

    // Same opId simulates the client retrying after a dropped response.
    await server.handleSync(baseRequest({ changes: { project: [first] } }), { userId: 'alice' })
    expect((await db.findOne({ model: 'project', where: { id: 'p1' } }))?.title).toBe('newer')
  })
})

describe('request limits', () => {
  it('rejects an oversized client operation batch before opening a transaction', async () => {
    const db = memoryAdapter()
    await db.ensureSyncTables(schema)
    const server = createSyncServer<Ctx>({ database: db, schema, maxBatchSize: 1 })
    await expect(server.handleSync(baseRequest({
      changes: {
        project: [
          upsertOp({ id: 'p1', userId: 'alice', title: 'one', changed: hlcAt(100) }),
          upsertOp({ id: 'p2', userId: 'alice', title: 'two', changed: hlcAt(101) }),
        ],
      },
    }), { userId: 'alice' })).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' })
  })
})

describe('input: false enforcement', () => {
  it('strips input-false fields from client writes', async () => {
    const { db, server } = await initServer()
    const clientProvidedDate = new Date('2020-01-01').toISOString()
    await server.handleSync(
      baseRequest({
        changes: {
          project: [
            upsertOp({
              id: 'p1',
              userId: 'alice',
              title: 'Hello',
              createdAt: clientProvidedDate, // should be stripped
              changed: hlcAt(500),
            }),
          ],
        },
      }),
      { userId: 'alice' },
    )
    const stored = await db.findOne({ model: 'project', where: { id: 'p1' } })
    expect(stored?.createdAt).toBeUndefined()
    expect(stored?.title).toBe('Hello')
  })
})

describe('output allowlist', () => {
  it('does not return explicitly private schema fields', async () => {
    const { db, server } = await initServer()
    await db.upsertIfNewer({
      model: 'project',
      row: {
        id: 'p1', userId: 'alice', title: 'visible', internalNote: 'server-only', changed: hlcAt(500),
      },
    })
    const response = await server.handleSync(baseRequest(), { userId: 'alice' })
    expect(response.changes.project?.[0]).toMatchObject({ id: 'p1', title: 'visible' })
    expect(response.changes.project?.[0]).not.toHaveProperty('internalNote')
  })
})

describe('afterCommit hook fire-and-forget', () => {
  it('calls afterCommit with applied changes after successful sync', async () => {
    const db = memoryAdapter()
    await db.ensureSyncTables(schema)
    const afterCommit = vi.fn().mockResolvedValue(undefined)
    const server = createSyncServer<Ctx>({
      database: db,
      schema,
      clock: { nodeId: 1, now: () => 10_000 },
      hooks: { afterCommit },
    })
    await server.handleSync(
      baseRequest({
        changes: {
          project: [
            upsertOp({ id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) }),
          ],
        },
      }),
      { userId: 'alice' },
    )
    // fire-and-forget: wait a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(afterCommit).toHaveBeenCalledTimes(1)
    const call = afterCommit.mock.calls[0]?.[0]
    expect(call?.changes.length).toBe(1)
    expect(call?.changes[0]?.action).toBe('insert')
  })
})

describe('realtime invalidation', () => {
  it('publishes model-only wake-up events after successful sync commit', async () => {
    const db = memoryAdapter()
    await db.ensureSyncTables(schema)
    const events: unknown[] = []
    const realtime = createInMemoryRealtimeBus<Ctx>({
      topic: (ctx) => ctx.userId,
      debounceMs: 0,
    })
    realtime.subscribe({ userId: 'alice' }, (event) => events.push(event))
    const server = createSyncServer<Ctx>({
      database: db,
      schema,
      clock: { nodeId: 1, now: () => 10_000 },
      realtime,
    })

    await server.handleSync(
      baseRequest({
        changes: {
          project: [
            upsertOp({ id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) }),
          ],
        },
      }),
      { userId: 'alice' },
    )

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'changes',
      models: ['project'],
    })
  })

  it('keeps realtime bus scoped by topic', async () => {
    const realtime = createInMemoryRealtimeBus<Ctx>({
      topic: (ctx) => ctx.userId,
      debounceMs: 0,
    })
    const aliceEvents: unknown[] = []
    const bobEvents: unknown[] = []
    realtime.subscribe({ userId: 'alice' }, (event) => aliceEvents.push(event))
    realtime.subscribe({ userId: 'bob' }, (event) => bobEvents.push(event))

    realtime.publish({
      ctx: { userId: 'alice' },
      changes: [{ model: 'project', action: 'insert', row: { id: 'p1' } }],
      event: { type: 'changes', models: ['project'], at: new Date().toISOString() },
    })

    expect(aliceEvents).toHaveLength(1)
    expect(bobEvents).toHaveLength(0)
  })

  it('streams events from a destructured SSE handler', async () => {
    const realtime = createInMemoryRealtimeBus<Ctx>({
      topic: (ctx) => ctx.userId,
      debounceMs: 0,
    })
    const handlerFactory = realtime.handler
    const handler = handlerFactory(async () => ({ userId: 'alice' }))
    const abort = new AbortController()

    const res = await handler(new Request('http://localhost/events', { signal: abort.signal }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    const decoder = new TextDecoder()

    const connected = await reader!.read()
    expect(decoder.decode(connected.value)).toContain(': connected')

    realtime.publish({
      ctx: { userId: 'alice' },
      changes: [{ model: 'project', action: 'insert', row: { id: 'p1' } }],
      event: { type: 'changes', models: ['project'], at: new Date().toISOString() },
    })

    const message = await reader!.read()
    expect(decoder.decode(message.value)).toContain('"models":["project"]')

    await reader!.cancel()
    abort.abort()
  })

  it('coalesces bursts per topic to avoid wake-up storms', async () => {
    const realtime = createInMemoryRealtimeBus<Ctx>({
      topic: (ctx) => ctx.userId,
      debounceMs: 10,
    })
    const events: unknown[] = []
    realtime.subscribe({ userId: 'alice' }, (event) => events.push(event))

    realtime.publish({
      ctx: { userId: 'alice' },
      changes: [{ model: 'project', action: 'insert', row: { id: 'p1' } }],
      event: { type: 'changes', models: ['project'], at: new Date().toISOString() },
    })
    realtime.publish({
      ctx: { userId: 'alice' },
      changes: [{ model: 'task', action: 'insert', row: { id: 't1' } }],
      event: { type: 'changes', models: ['task'], at: new Date().toISOString() },
    })

    expect(events).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'changes',
      models: ['project', 'task'],
    })
  })

  it('can cap in-memory subscribers', () => {
    const realtime = createInMemoryRealtimeBus<Ctx>({
      topic: (ctx) => ctx.userId,
      maxSubscribers: 1,
    })

    const unsubscribe = realtime.subscribe({ userId: 'alice' }, () => {})
    expect(() => realtime.subscribe({ userId: 'bob' }, () => {})).toThrow(/subscriber limit/)
    unsubscribe()
    expect(() => realtime.subscribe({ userId: 'bob' }, () => {})).not.toThrow()
  })
})

describe('afterWriteInTransaction hook timing', () => {
  it('runs hook inside transaction and rolls back on throw', async () => {
    const db = memoryAdapter()
    await db.ensureSyncTables(schema)
    const server = createSyncServer<Ctx>({
      database: db,
      schema,
      clock: { nodeId: 1, now: () => 10_000 },
      hooks: {
        afterWriteInTransaction: async () => {
          throw new Error('fail')
        },
      },
    })
    await expect(
      server.handleSync(
        baseRequest({
          changes: {
            project: [
              upsertOp({ id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) }),
            ],
          },
        }),
        { userId: 'alice' },
      ),
    ).rejects.toThrow(/fail/)
    const stored = await db.findOne({ model: 'project', where: { id: 'p1' } })
    expect(stored).toBeNull()
  })

  it('enforces 100ms time budget on afterWriteInTransaction', async () => {
    const db = memoryAdapter()
    await db.ensureSyncTables(schema)
    const server = createSyncServer<Ctx>({
      database: db,
      schema,
      clock: { nodeId: 1, now: () => 10_000 },
      afterWriteInTransactionBudgetMs: 20, // tight for test
      hooks: {
        afterWriteInTransaction: async () => {
          await new Promise((r) => setTimeout(r, 200))
        },
      },
    })
    await expect(
      server.handleSync(
        baseRequest({
          changes: {
            project: [
              upsertOp({ id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) }),
            ],
          },
        }),
        { userId: 'alice' },
      ),
    ).rejects.toThrow(/timeout|exceeded/i)
  })
})

describe('protocol version check', () => {
  it('rejects incompatible major version', async () => {
    const { server } = await initServer()
    await expect(
      server.handleSync(
        baseRequest({ protocolVersion: '2.0.0' }),
        { userId: 'alice' },
      ),
    ).rejects.toThrow(/version/i)
  })

  it('accepts minor version mismatch', async () => {
    const { server } = await initServer()
    const res = await server.handleSync(
      baseRequest({ protocolVersion: '1.5.0' }),
      { userId: 'alice' },
    )
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
  })
})

describe('pagination', () => {
  it('returns cursor when result exceeds limit', async () => {
    const { db, server } = await initServer()
    for (let i = 0; i < 25; i++) {
      await db.upsertIfNewer({
        model: 'project',
        row: {
          id: `p${String(i).padStart(3, '0')}`,
          userId: 'alice',
          title: `t${i}`,
          changed: hlcAt(100 + i),
        },
      })
    }
    const res = await server.handleSync(
      baseRequest({ limit: 10 }),
      { userId: 'alice' },
    )
    expect(res.hasMore).toBe(true)
    expect(res.cursor).not.toBeNull()
    expect(res.changes.project?.length).toBe(10)
  })

  it('paginates tombstones instead of dropping deletes past the page limit', async () => {
    const { db, server } = await initServer()
    await db.upsertTombstoneIfNewer({
      model: 'project',
      id: 'p1',
      hlc: hlcAt(100),
      scope: { userId: 'alice' },
    })
    await db.upsertTombstoneIfNewer({
      model: 'project',
      id: 'p2',
      hlc: hlcAt(101),
      scope: { userId: 'alice' },
    })

    const first = await server.handleSync(baseRequest({ limit: 1 }), { userId: 'alice' })
    expect(first.tombstones.map((tombstone) => tombstone.id)).toEqual(['p1'])
    expect(first.hasMore).toBe(true)
    expect(first.cursor).toEqual({
      model: '__bettersync_tombstones__:project',
      hlc: hlcAt(100),
      id: 'p1',
    })

    const second = await server.handleSync(
      baseRequest({ limit: 1, cursor: first.cursor }),
      { userId: 'alice' },
    )
    expect(second.tombstones.map((tombstone) => tombstone.id)).toEqual(['p2'])
    expect(second.hasMore).toBe(false)
    expect(second.cursor).toBeNull()
  })
})
