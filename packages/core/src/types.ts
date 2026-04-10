/**
 * Shared primitive types for @better-sync/core.
 *
 * No external imports — this is the bottom of the dependency graph.
 */

/**
 * A sync row. Always has an `id` (string) and a `changed` (HLC string).
 * Other fields depend on the model schema.
 */
export type Row = Record<string, unknown>

/**
 * A map of model name → array of rows. Used in wire protocol changes/forceFetch.
 */
export type ChangeSet = Record<string, Row[]>

/**
 * A `where` clause for adapter queries. Map of column → value (or query op).
 * Adapters interpret keys as column names. Nested objects (e.g. `{ gt: 5 }`) for ops.
 */
export type Where = Record<string, unknown>

/**
 * A sort directive. `{ changed: 'asc', id: 'asc' }` for compound sort.
 */
export type SortBy = Record<string, 'asc' | 'desc'>

/**
 * A scope predicate — flat key/value pairs that ALL must match.
 * E.g. `{ userId: 'u1' }` filters rows belonging to user u1.
 */
export type Scope = Record<string, unknown>

/**
 * Generic context passed through the request pipeline.
 * User code defines what's in here (auth, request metadata, etc).
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined shape
export type AnyCtx = Record<string, any>
