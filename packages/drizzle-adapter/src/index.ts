/**
 * @bettersync/drizzle-adapter
 *
 * better-auth style: pass Drizzle table objects, get column mapping free.
 *
 *   import { projects, tasks } from './db/schema'
 *   drizzleAdapter(db, { schema: { project: projects, task: tasks } })
 */

export { drizzleAdapter } from './drizzle'
export type { DrizzleAdapterConfig } from './drizzle'
