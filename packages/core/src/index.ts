/**
 * @bettersync/core
 *
 * Core types, HLC, schema DSL, error types, and adapter interface.
 *
 * This package is published separately so that plugin authors can depend on
 * `@bettersync/core` instead of the meta `better-sync` package, avoiding
 * circular dependencies and version skew via duplicate transitive deps.
 *
 * For instance checks across duplicate copies, use `isSyncError` (structural)
 * instead of `instanceof SyncError`.
 */

// ─── Types ──────────────────────────────────────────────────────────
export type { AnyCtx, ChangeSet, Row, Scope, SortBy, Where } from './types'

// ─── Errors ─────────────────────────────────────────────────────────
export {
  AdapterError,
  BatchTooLargeError,
  HLCOverflowError,
  HLCRegressionError,
  HookTimeoutError,
  isSyncError,
  ProtocolVersionMismatchError,
  ScopeViolationError,
  SchemaViolationError,
  StaleClientError,
  SyncError,
  SYNC_ERROR_BRAND,
  UnauthorizedError,
} from './errors'
export type { SyncErrorJSON } from './errors'

// ─── HLC ────────────────────────────────────────────────────────────
export {
  compare as compareHlc,
  decode as decodeHlc,
  encode as encodeHlc,
  generateNodeId,
  HLC_LENGTH,
  HLC_MAX_LOGICAL,
  HLC_MAX_WALL,
  HLC_ZERO,
  HLClock,
} from './hlc'
export type { HLClockOptions, HLCParts } from './hlc'

// ─── Protocol ───────────────────────────────────────────────────────
export {
  emptySyncResponse,
  parseSyncRequest,
  PROTOCOL_VERSION,
  serializeSyncResponse,
} from './protocol'
export type {
  ChangeRow,
  ForcePushRequest,
  ForcePushResponse,
  PaginationCursor,
  SyncRequest,
  SyncResponse,
  Tombstone,
} from './protocol'

// ─── Schema ─────────────────────────────────────────────────────────
export {
  defineSchema,
  getModelTableName,
  getPrimaryKey,
  RESERVED_FIELDS,
  validateSchema,
} from './schema'
export type {
  FieldDef,
  FieldReference,
  FieldType,
  ModelDef,
  SyncSchema,
} from './schema'

// ─── Adapter ────────────────────────────────────────────────────────
export type {
  AdapterCapabilities,
  AdapterCursor,
  BatchUpsertResult,
  FindChangedSinceParams,
  FindChangedSinceResult,
  SyncAdapter,
  UpsertResult,
} from './adapter'

// ─── Merge ──────────────────────────────────────────────────────────
export {
  DEFAULT_HLC_FIELD,
  decideMerge,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from './merge'
export type { DecideMergeResult } from './merge'
