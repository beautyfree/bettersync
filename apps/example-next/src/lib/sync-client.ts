/**
 * Client-side sync config — 5 lines.
 *
 * Uses syncUrl shorthand (auto HTTP transport).
 * PGlite for browser-side Postgres.
 */
import { createSyncClient } from 'bettersync/client'
import { pgliteAdapter } from 'bettersync/adapters/pglite'
import { PGlite } from '@electric-sql/pglite'
import { syncSchema } from './sync'

const pg = new PGlite('idb://bettersync-demo')

export const syncClient = createSyncClient({
  database: pgliteAdapter(pg),
  schema: syncSchema,
  syncUrl: '/api/sync',
  pollInterval: 5_000,
})
