/**
 * @better-sync/pglite-adapter
 *
 * PGlite (Postgres WASM) adapter for better-sync.
 * Same Postgres SQL dialect as the server-side Drizzle adapter.
 * Runs in browser (IndexedDB), Node (filesystem), or in-memory.
 * No Docker required for tests.
 */
export { pgliteAdapter } from './pglite'
export type { PGliteAdapterOptions } from './pglite'
