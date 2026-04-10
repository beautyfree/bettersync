/**
 * Client-side sync config — 5 lines.
 *
 * Uses syncUrl shorthand (auto HTTP transport).
 * PGlite for browser-side Postgres.
 */
import { createSyncClient } from 'better-sync/client'
import { pgliteAdapter } from 'better-sync/adapters/pglite'
import { PGlite } from '@electric-sql/pglite'
import { syncSchema } from './sync'

const pg = new PGlite('idb://better-sync-demo')

export const syncClient = createSyncClient({
  database: pgliteAdapter(pg),
  schema: syncSchema,
  syncUrl: '/api/sync',
  pollInterval: 5_000,
})
