/**
 * Local unit tests for memory-adapter — things that aren't captured by the
 * shared conformance suite (memory-specific behaviours like snapshot isolation).
 */
import { describe, expect, it } from 'vitest'
import { memoryAdapter } from '../src/index'
import { encodeHlc, type SyncSchema } from '@bettersync/core'

const schema: SyncSchema = {
  project: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      title: { type: 'string' },
      changed: { type: 'string' },
    },
  },
}

const hlc = (wall: number, logical = 0) =>
  encodeHlc({ wall, logical, node: 0xdeadbeef })

describe('memoryAdapter isolation', () => {
  it('two memoryAdapter() calls produce independent instances', async () => {
    const a = memoryAdapter()
    const b = memoryAdapter()
    await a.ensureSyncTables(schema)
    await b.ensureSyncTables(schema)

    await a.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', title: 'in A', changed: hlc(100) },
    })

    const foundInB = await b.findOne({ model: 'project', where: { id: 'p1' } })
    expect(foundInB).toBeNull()
  })
})

describe('memoryAdapter throws before ensureSyncTables', () => {
  it('requires schema initialization before upsertIfNewer', async () => {
    const a = memoryAdapter()
    await expect(
      a.upsertIfNewer({
        model: 'project',
        row: { id: 'p1', userId: 'u1', title: 'x', changed: hlc(100) },
      }),
    ).rejects.toThrow(/ensureSyncTables/)
  })
})

describe('memoryAdapter transaction deep clone', () => {
  it('rollback restores a nested object edit', async () => {
    const a = memoryAdapter()
    await a.ensureSyncTables(schema)
    await a.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', title: 'original', changed: hlc(100) },
    })

    let caught: unknown = null
    try {
      await a.transaction(async (tx) => {
        await tx.update({
          model: 'project',
          where: { id: 'p1' },
          update: { title: 'mutated' },
        })
        throw new Error('boom')
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const after = await a.findOne({ model: 'project', where: { id: 'p1' } })
    expect(after?.title).toBe('original')
  })
})

describe('memoryAdapter delete behaviour', () => {
  it('delete removes the row but does not auto-create a tombstone', async () => {
    const a = memoryAdapter()
    await a.ensureSyncTables(schema)
    await a.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', title: 'x', changed: hlc(100) },
    })
    await a.delete({ model: 'project', where: { id: 'p1' } })
    const after = await a.findOne({ model: 'project', where: { id: 'p1' } })
    expect(after).toBeNull()
    const tombs = await a.findTombstonesSince({ sinceHlc: hlc(0), limit: 100 })
    expect(tombs.length).toBe(0)
  })

  it('upsertTombstoneIfNewer clears the row even if the HLC is equal', async () => {
    const a = memoryAdapter()
    await a.ensureSyncTables(schema)
    await a.upsertIfNewer({
      model: 'project',
      row: { id: 'p1', userId: 'u1', title: 'x', changed: hlc(100) },
    })
    const created = await a.upsertTombstoneIfNewer({
      model: 'project',
      id: 'p1',
      hlc: hlc(200),
      scope: { userId: 'u1' },
    })
    expect(created).toBe(true)
    const after = await a.findOne({ model: 'project', where: { id: 'p1' } })
    expect(after).toBeNull()
  })
})
