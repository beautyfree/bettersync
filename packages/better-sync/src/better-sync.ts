/**
 * betterSync() — single-call facade inspired by better-auth's betterAuth().
 *
 * Consolidates defineSchema + createSyncServer into one config object.
 * The user writes ONE file, passes models + database + hooks, gets back
 * a server instance ready to mount.
 *
 * Usage:
 *   import { betterSync } from 'better-sync'
 *   import { memoryAdapter } from 'better-sync/adapters/memory'
 *
 *   export const sync = betterSync({
 *     database: memoryAdapter(),
 *     models: {
 *       todo: {
 *         fields: {
 *           id: { type: 'string', primaryKey: true },
 *           userId: { type: 'string' },
 *           title: { type: 'string' },
 *           changed: { type: 'string' },
 *         },
 *         scope: (ctx) => ({ userId: ctx.userId }),
 *       },
 *     },
 *   })
 */

import {
  type SyncAdapter,
  type SyncSchema,
  type ModelDef,
  type HLClockOptions,
  defineSchema,
} from '@better-sync/core'
import {
  createSyncServer,
  type SyncServer,
  type SyncServerHooks,
} from '@better-sync/server'

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx
export interface BetterSyncOptions<Ctx = any> {
  /** Database adapter instance. */
  database: SyncAdapter
  /** Model definitions — becomes the sync schema. */
  models: Record<string, ModelDef<Ctx>>
  /** Server-side hooks (afterWriteInTransaction, afterCommit, beforeRead). */
  hooks?: SyncServerHooks<Ctx>
  /** HLC field name on rows. Default: 'changed'. */
  hlcField?: string
  /** Time budget for afterWriteInTransaction hooks (ms). Default: 100. */
  afterWriteInTransactionBudgetMs?: number
  /** HLC clock options. */
  clock?: HLClockOptions
}

/**
 * Create a sync server from a single config object.
 * Equivalent to `defineSchema(models)` + `createSyncServer({ database, schema, ... })`.
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx
export function betterSync<Ctx = any>(options: BetterSyncOptions<Ctx>): SyncServer<Ctx> {
  const schema = defineSchema<Ctx>(options.models as SyncSchema<Ctx>)

  return createSyncServer<Ctx>({
    database: options.database,
    schema,
    hooks: options.hooks,
    hlcField: options.hlcField,
    afterWriteInTransactionBudgetMs: options.afterWriteInTransactionBudgetMs,
    clock: options.clock,
  })
}
