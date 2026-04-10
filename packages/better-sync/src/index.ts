/**
 * better-sync — main entry point.
 *
 * Re-exports core types, schema DSL, HLC, errors, and both
 * createSyncServer + createSyncClient for convenience.
 *
 * For subpath-specific imports use:
 *   better-sync/client
 *   better-sync/server
 *   better-sync/adapters/drizzle
 *   better-sync/adapters/memory
 *   better-sync/test
 */

// ─── Core (types, HLC, schema, errors, protocol, merge) ────────────
export {
  // Types
  type AnyCtx,
  type ChangeSet,
  type Row,
  type Scope,
  type SortBy,
  type Where,
  // Errors
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
  type SyncErrorJSON,
  // HLC
  compareHlc,
  decodeHlc,
  encodeHlc,
  generateNodeId,
  HLC_LENGTH,
  HLC_MAX_LOGICAL,
  HLC_MAX_WALL,
  HLC_ZERO,
  HLClock,
  type HLClockOptions,
  type HLCParts,
  // Protocol
  emptySyncResponse,
  parseSyncRequest,
  PROTOCOL_VERSION,
  serializeSyncResponse,
  type ChangeRow,
  type ForcePushRequest,
  type ForcePushResponse,
  type PaginationCursor,
  type SyncRequest,
  type SyncResponse,
  type Tombstone,
  // Schema
  defineSchema,
  getModelTableName,
  getPrimaryKey,
  RESERVED_FIELDS,
  validateSchema,
  type FieldDef,
  type FieldReference,
  type FieldType,
  type ModelDef,
  type SyncSchema,
  // Adapter
  type AdapterCapabilities,
  type AdapterCursor,
  type BatchUpsertResult,
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type SyncAdapter,
  type UpsertResult,
  // Merge
  DEFAULT_HLC_FIELD,
  decideMerge,
  shouldApplyTombstone,
  shouldDropAsResurrection,
  type DecideMergeResult,
} from '@better-sync/core'

// ─── Facade ─────────────────────────────────────────────────────────
export { betterSync } from './better-sync'
export type { BetterSyncOptions } from './better-sync'

// ─── Server ─────────────────────────────────────────────────────────
export { createSyncServer } from '@better-sync/server'
export type {
  CreateSyncServerOptions,
  SyncServer,
  SyncServerHooks,
} from '@better-sync/server'

// ─── Client ─────────────────────────────────────────────────────────
export { createSyncClient } from '@better-sync/client'
export type {
  CreateSyncClientOptions,
  ModelAccessor,
  SyncClient,
  SyncResult,
  Transport,
} from '@better-sync/client'
