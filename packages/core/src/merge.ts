/**
 * Merge engine — pure functions for HLC-based last-write-wins decisions.
 *
 * The actual atomic upsert lives in each adapter (`SyncAdapter.upsertIfNewer`)
 * because correctness requires a single SQL statement (e.g. Postgres
 * `INSERT ... ON CONFLICT DO UPDATE WHERE`). This module exposes the pure
 * decision logic that adapters and the in-memory test adapter share.
 */

import { compare as compareHLC } from './hlc'
import type { UpsertResult } from './adapter'
import type { Row } from './types'

/**
 * Default field name where the HLC is stored on a row.
 * Configurable per sync server via `hlc.field` option.
 */
export const DEFAULT_HLC_FIELD = 'changed'

export interface DecideMergeResult {
  action: UpsertResult
  result: Row
}

/**
 * Pure LWW decision: given an existing row (or null) and an incoming row,
 * return the action to take and the row that should end up in storage.
 *
 * - `existing == null`             → insert
 * - `incoming.changed > existing.changed` → update (incoming wins)
 * - `incoming.changed <= existing.changed` → skip (existing wins or equal)
 *
 * Used by adapters that don't have a single-query atomic upsert (e.g.
 * memory adapter, simple SQLite adapter). Adapters with native upsert
 * should encode this rule in SQL for correctness under concurrency.
 */
export function decideMerge(
  existing: Row | null,
  incoming: Row,
  hlcField: string = DEFAULT_HLC_FIELD,
): DecideMergeResult {
  if (!existing) {
    return { action: 'inserted', result: incoming }
  }
  const existingHlc = String(existing[hlcField] ?? '')
  const incomingHlc = String(incoming[hlcField] ?? '')
  if (compareHLC(incomingHlc, existingHlc) > 0) {
    return { action: 'updated', result: incoming }
  }
  return { action: 'skipped', result: existing }
}

/**
 * Pure decision for tombstone application:
 *
 * - if no existing tombstone → write new tombstone
 * - if incoming.hlc > existing.hlc → write new tombstone
 * - if incoming.hlc <= existing.hlc → skip
 *
 * Returns true if the tombstone should be written.
 */
export function shouldApplyTombstone(
  existingHlc: string | null,
  incomingHlc: string,
): boolean {
  if (existingHlc == null) return true
  return compareHLC(incomingHlc, existingHlc) > 0
}

/**
 * Decide whether an incoming write should also drop the local row.
 *
 * Specifically: if a write arrives for a row that has been deleted
 * (a tombstone exists with hlc >= incoming.changed), the write must be
 * dropped — otherwise stale clients could resurrect deleted data.
 *
 * @param tombstoneHlc HLC of the existing tombstone for this row, or null
 * @param incomingHlc HLC on the incoming row
 * @returns true if the row should be dropped (do not insert/update)
 */
export function shouldDropAsResurrection(
  tombstoneHlc: string | null,
  incomingHlc: string,
): boolean {
  if (tombstoneHlc == null) return false
  return compareHLC(incomingHlc, tombstoneHlc) <= 0
}
