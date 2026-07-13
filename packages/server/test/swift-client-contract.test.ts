import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseSyncRequest,
  type SyncRequest,
  type SyncSchema,
} from '@bettersync/core'
import { memoryAdapter } from '@bettersync/memory-adapter'
import { createSyncServer } from '../src/index'

type Ctx = { familyId: string }

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
    tombstoneScope: ['familyId'],
  },
}

describe.skipIf(process.platform !== 'darwin')('Swift BetterSync protocol contract', () => {
  it('creates a request accepted by the TypeScript BetterSync server', async () => {
    const stdout = execFileSync(
      'swift',
      ['run', '--skip-build', '--package-path', 'packages/swift-client', 'BetterSyncFixtureCLI'],
      { cwd: resolve(process.cwd(), '../..'), encoding: 'utf8' },
    )
    const request = parseSyncRequest(JSON.parse(stdout)) as SyncRequest
    const database = memoryAdapter()
    await database.ensureSyncTables(schema)
    const server = createSyncServer({
      database,
      schema,
      clock: { nodeId: 0xbabecafe, now: () => 1_710_000_000_100 },
    })

    await server.handleSync(request, { familyId: 'family-1' })

    expect(await database.findOne({ model: 'feeding', where: { id: 'swift-fixture-row' } })).toMatchObject({
      childId: 'child-1',
      type: 'breast_left',
      timestamp: 1_710_000_000_000,
    })
  })
})
