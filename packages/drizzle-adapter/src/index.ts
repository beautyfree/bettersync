/**
 * @bettersync/drizzle-adapter
 *
 * SyncAdapter backed by Drizzle ORM + node-postgres.
 * Uses raw SQL via `db.execute(sql\`...\`)` since sync tables are dynamic
 * (defined by SyncSchema, not by Drizzle schema files).
 *
 * Postgres-specific in v0.1 (ON CONFLICT ... WHERE for atomic upsert).
 */

export { drizzleAdapter } from './drizzle'
export type { DrizzleAdapterOptions } from './drizzle'
