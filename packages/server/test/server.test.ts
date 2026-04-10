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
import { createSyncServer } from '../src/index'

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
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
}

const hlcAt = (wall: number, logical = 0) =>
  encodeHlc({ wall, logical, node: 0xdeadbeef })

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
            {
              id: 'p1',
              userId: 'alice',
              title: 'Hello',
              changed: hlcAt(500),
            },
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
              {
                id: 'evil',
                userId: 'bob', // authenticated as alice
                title: 'hack',
                changed: hlcAt(500),
              },
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
            {
              model: 'project',
              id: 'pB',
              hlc: hlcAt(500),
              scope: { userId: 'bob' }, // alice trying to delete bob's row
            },
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

describe('input: false enforcement', () => {
  it('strips input-false fields from client writes', async () => {
    const { db, server } = await initServer()
    const clientProvidedDate = new Date('2020-01-01').toISOString()
    await server.handleSync(
      baseRequest({
        changes: {
          project: [
            {
              id: 'p1',
              userId: 'alice',
              title: 'Hello',
              createdAt: clientProvidedDate, // should be stripped
              changed: hlcAt(500),
            },
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
            { id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) },
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
              { id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) },
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
              { id: 'p1', userId: 'alice', title: 'Hello', changed: hlcAt(500) },
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
})
