/**
 * Sync configuration — ONE file, like better-auth's auth.ts.
 *
 * Schema + database + hooks all in one place.
 * Import this from your API route and from the client.
 */
import { betterSync } from 'bettersync'
import { memoryAdapter } from 'bettersync/adapters/memory'

function createSync() {
  return betterSync({
    database: (() => {
      const db = memoryAdapter()
      db.ensureSyncTables({
        todo: {
          fields: {
            id: { type: 'string', primaryKey: true },
            userId: { type: 'string' },
            title: { type: 'string' },
            completed: { type: 'boolean', required: false },
            changed: { type: 'string' },
          },
          scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
        },
      })
      return db
    })(),

    models: {
      todo: {
        fields: {
          id: { type: 'string', primaryKey: true },
          userId: { type: 'string' },
          title: { type: 'string' },
          completed: { type: 'boolean', required: false },
          changed: { type: 'string' },
        },
        scope: (ctx: { userId: string }) => ({ userId: ctx.userId }),
      },
    },
  })
}

// Singleton — survives hot reload in dev
const g = globalThis as unknown as { _sync?: ReturnType<typeof createSync> }

export const sync: ReturnType<typeof createSync> = g._sync ?? createSync()

// biome-ignore lint/suspicious/noExplicitAny: dev singleton cache
if (process.env.NODE_ENV !== 'production') (g as any)._sync = sync

/** Export the schema for use by the client. */
export const syncSchema = sync.schema
