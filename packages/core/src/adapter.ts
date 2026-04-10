/**
 * SyncAdapter interface — the contract every database adapter must implement.
 *
 * The interface is intentionally small (better-auth style 8-method CRUD) plus
 * sync-specific operations that need atomic semantics or efficient queries
 * (`upsertIfNewer`, `findChangedSince`, tombstone helpers).
 *
 * Adapter authors implement this interface; the factory in `createSyncAdapter`
 * wraps the raw adapter with type transforms, debug logging, and schema
 * generation hooks.
 */

import type { Tombstone } from './protocol'
import type { SyncSchema } from './schema'
import type { Row, Scope, SortBy, Where } from './types'

/**
 * Capability flags declared by an adapter. The factory uses these to
 * decide how to transform values (e.g. booleans → integers in SQLite).
 */
export interface AdapterCapabilities {
  /** Stable identifier, e.g. "drizzle-pg" or "better-sqlite3". */
  adapterId: string
  /** Human-readable name. */
  adapterName: string
  /** Native JSON column support (Postgres JSONB, MongoDB). */
  supportsJSON?: boolean
  /** Native date/timestamp column support. */
  supportsDates?: boolean
  /** Native boolean column support (Postgres). */
  supportsBooleans?: boolean
  /** Numeric primary keys allowed. */
  supportsNumericIds?: boolean
  /** Adapter wraps operations in a transaction. */
  supportsTransaction?: boolean
  /** Adapter has efficient batch upsert (`INSERT ... VALUES (...), (...)`). */
  supportsBatchInsert?: boolean
  /**
   * Adapter supports compound row comparison: `(col1, col2) > (val1, val2)`.
   * Postgres yes, MySQL >= 8.0 yes, recent SQLite yes.
   * If false, the adapter must implement equivalent boolean expansion.
   */
  supportsCompoundComparison?: boolean
}

/**
 * Compound cursor used by `findChangedSince` for stable pagination under
 * concurrent writes.
 */
export interface AdapterCursor {
  hlc: string
  id: string
}

export interface FindChangedSinceParams {
  model: string
  /** Return rows where `changed > sinceHlc`. */
  sinceHlc: string
  /** Maximum rows to return. */
  limit: number
  /** Continuation cursor from a previous page. */
  cursor?: AdapterCursor
  /** Scope predicate, e.g. `{ userId: 'u1' }`. */
  scope?: Scope
}

export interface FindChangedSinceResult {
  rows: Row[]
  /** Present if more pages exist. Pass to the next call. */
  nextCursor?: AdapterCursor
}

/**
 * Outcome of an HLC-conditional upsert.
 */
export type UpsertResult = 'inserted' | 'updated' | 'skipped'

export interface BatchUpsertResult {
  inserted: number
  updated: number
  skipped: number
}

/**
 * The minimal contract every adapter must implement.
 */
export interface SyncAdapter {
  readonly capabilities: AdapterCapabilities

  // ─── Schema bootstrap ─────────────────────────────────────────────

  /**
   * Create or migrate the sync metadata tables (`sync_tombstones`, etc).
   * Idempotent — safe to call on every boot.
   */
  ensureSyncTables(schema: SyncSchema): Promise<void>

  // ─── CRUD (better-auth style) ─────────────────────────────────────

  create(p: { model: string; data: Row }): Promise<Row>
  update(p: { model: string; where: Where; update: Partial<Row> }): Promise<Row | null>
  delete(p: { model: string; where: Where }): Promise<void>
  findOne(p: { model: string; where: Where }): Promise<Row | null>
  findMany(p: {
    model: string
    where?: Where
    limit?: number
    offset?: number
    sortBy?: SortBy
  }): Promise<Row[]>
  count(p: { model: string; where?: Where }): Promise<number>

  // ─── Sync-specific operations ─────────────────────────────────────

  /**
   * Find rows in `model` whose `changed` HLC is greater than `sinceHlc`,
   * ordered by `(changed, id)` ascending, paginated by compound cursor.
   *
   * MUST sort by `(changed, id)` and accept compound cursor — see design
   * doc "Cursor Pagination — Compound (hlc, id) Tiebreak (P0 Correctness)".
   */
  findChangedSince(p: FindChangedSinceParams): Promise<FindChangedSinceResult>

  /**
   * Conditional upsert: insert if absent, update only if `row.changed` is
   * strictly greater than the existing row's `changed`. Atomic single-query
   * implementation strongly preferred (e.g. Postgres `INSERT ... ON CONFLICT
   * DO UPDATE WHERE excluded.changed > target.changed`).
   *
   * Returns the outcome: 'inserted', 'updated', or 'skipped' (existing row
   * had a newer or equal HLC).
   */
  upsertIfNewer(p: { model: string; row: Row }): Promise<UpsertResult>

  /**
   * Optional fast path for batch upserts. Adapters that don't implement this
   * fall back to a loop over `upsertIfNewer`.
   */
  batchUpsertIfNewer?(p: { model: string; rows: Row[] }): Promise<BatchUpsertResult>

  // ─── Tombstone operations ─────────────────────────────────────────

  /**
   * Find tombstones with `hlc > sinceHlc`, filtered by scope, paginated
   * by `(hlc, id)`. Tombstones MUST carry their scope (denormalized at
   * delete time) so that cross-tenant filtering works without joining
   * the original (deleted) rows.
   */
  findTombstonesSince(p: {
    sinceHlc: string
    limit: number
    scope?: Scope
  }): Promise<Tombstone[]>

  /**
   * Insert or update a tombstone if newer. Idempotent.
   * Returns true if the tombstone was written, false if skipped.
   */
  upsertTombstoneIfNewer(t: Tombstone): Promise<boolean>

  /**
   * Garbage-collect tombstones older than the given HLC.
   * Returns the number of tombstones deleted.
   */
  gcTombstones(p: { olderThanHlc: string }): Promise<number>

  // ─── Transactions ─────────────────────────────────────────────────

  /**
   * Run `fn` inside a database transaction. The provided `tx` adapter
   * MUST behave identically to the parent adapter, but all writes are
   * atomic with respect to the outer transaction.
   *
   * Used by the sync engine to apply a batch of changes atomically and
   * by `afterWriteInTransaction` hooks.
   */
  transaction<T>(fn: (tx: SyncAdapter) => Promise<T>): Promise<T>
}
