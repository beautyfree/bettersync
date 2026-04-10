/**
 * Verify that all subpath exports resolve correctly.
 * This test catches broken exports maps and missing re-exports.
 */
import { describe, expect, it } from 'vitest'

describe('better-sync subpath exports', () => {
  it('root: exports core + server + client', async () => {
    const mod = await import('../src/index')
    expect(typeof mod.createSyncServer).toBe('function')
    expect(typeof mod.createSyncClient).toBe('function')
    expect(typeof mod.defineSchema).toBe('function')
    expect(typeof mod.HLClock).toBe('function')
    expect(typeof mod.isSyncError).toBe('function')
    expect(typeof mod.parseSyncRequest).toBe('function')
    expect(typeof mod.decideMerge).toBe('function')
    expect(mod.PROTOCOL_VERSION).toBe('1.0.0')
    expect(mod.HLC_ZERO).toBe('000000000000000000000000')
  })

  it('better-sync/client exports createSyncClient', async () => {
    const mod = await import('../src/client')
    expect(typeof mod.createSyncClient).toBe('function')
  })

  it('better-sync/server exports createSyncServer + hooks', async () => {
    const mod = await import('../src/server')
    expect(typeof mod.createSyncServer).toBe('function')
    expect(typeof mod.runHookWithTimeout).toBe('function')
  })

  it('better-sync/adapters/drizzle exports drizzleAdapter', async () => {
    const mod = await import('../src/adapters/drizzle')
    expect(typeof mod.drizzleAdapter).toBe('function')
  })

  it('better-sync/adapters/memory exports memoryAdapter', async () => {
    const mod = await import('../src/adapters/memory')
    expect(typeof mod.memoryAdapter).toBe('function')
  })

  it('better-sync/test exports conformance suite', async () => {
    const mod = await import('../src/test')
    expect(Array.isArray(mod.CONFORMANCE_TESTS)).toBe(true)
    expect(mod.CONFORMANCE_TESTS.length).toBeGreaterThan(10)
    expect(typeof mod.hlcAt).toBe('function')
    expect(typeof mod.getConformanceTestsByTag).toBe('function')
  })

  it('better-sync/next-js exports toNextJsHandler', async () => {
    const mod = await import('../src/next-js')
    expect(typeof mod.toNextJsHandler).toBe('function')
  })

  it('better-sync/react exports SyncProvider, useSync, useSyncQuery, SyncDevtools', async () => {
    const mod = await import('../src/react')
    expect(typeof mod.SyncProvider).toBe('function')
    expect(typeof mod.useSync).toBe('function')
    expect(typeof mod.useSyncQuery).toBe('function')
    expect(typeof mod.SyncDevtools).toBe('function')
  })
})

describe('full E2E via better-sync root import', () => {
  it('two clients sync through root exports only', async () => {
    const {
      createSyncServer,
      createSyncClient,
      defineSchema,
    } = await import('../src/index')
    const { memoryAdapter } = await import('../src/adapters/memory')

    const schema = defineSchema({
      note: {
        fields: {
          id: { type: 'string', primaryKey: true },
          userId: { type: 'string' },
          text: { type: 'string' },
          changed: { type: 'string' },
        },
        scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
      },
    })

    const serverDb = memoryAdapter()
    await serverDb.ensureSyncTables(schema)
    let tick = 10_000
    const server = createSyncServer({
      database: serverDb,
      schema,
      clock: { nodeId: 1, now: () => tick++ },
    })

    const transport = async (req: Parameters<typeof server.handleSync>[0]) =>
      server.handleSync(req, { userId: 'alice' })

    let cTick = 500
    const clientA = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 2, now: () => cTick++ },
    })
    const clientB = createSyncClient({
      database: memoryAdapter(),
      schema,
      transport,
      clock: { nodeId: 3, now: () => cTick++ },
    })

    await clientA.start()
    await clientB.start()

    await clientA.model('note').insert({ id: 'n1', userId: 'alice', text: 'hello' })
    await clientA.syncNow()
    await clientB.syncNow()

    const found = await clientB.model('note').findOne({ id: 'n1' })
    expect(found?.text).toBe('hello')
  })
})
