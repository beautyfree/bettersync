/**
 * Server-side sync setup.
 *
 * Uses the memory adapter for this demo. In production, swap to:
 *   import { drizzleAdapter } from 'better-sync/adapters/drizzle'
 *   database: drizzleAdapter(db)
 */
import { createSyncServer } from 'better-sync'
import { memoryAdapter } from 'better-sync/adapters/memory'
import { syncSchema, type AuthContext } from './schema'

// Singleton server — persists across hot reloads in dev
const globalForSync = globalThis as unknown as { syncServer?: ReturnType<typeof createSyncServer<AuthContext>> }

export const syncServer =
  globalForSync.syncServer ??
  createSyncServer<AuthContext>({
    database: (() => {
      const db = memoryAdapter()
      // ensureSyncTables is called lazily on first request
      db.ensureSyncTables(syncSchema)
      return db
    })(),
    schema: syncSchema,
  })

if (process.env.NODE_ENV !== 'production') {
  globalForSync.syncServer = syncServer
}
