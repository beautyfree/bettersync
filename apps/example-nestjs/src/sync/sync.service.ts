import { Injectable } from '@nestjs/common'
import { betterSync } from 'bettersync'
import { memoryAdapter } from 'bettersync/adapters/memory'

/**
 * SyncService — singleton that holds the sync server instance.
 *
 * In production, replace memoryAdapter with drizzleAdapter:
 *
 *   import { drizzleAdapter } from 'bettersync/adapters/drizzle'
 *   import { projects } from '../db/schema'
 *
 *   database: drizzleAdapter(db, { schema: { project: projects } }),
 */
@Injectable()
export class SyncService {
  public readonly sync = betterSync({
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

    auth: async (req: Request) => {
      // TODO: Replace with your NestJS auth (Passport, JWT guard, etc.)
      // const token = req.headers.get('authorization')?.replace('Bearer ', '')
      // const user = await this.authService.verify(token)
      // return { userId: user.id }
      return { userId: 'demo-user' }
    },
  })
}
