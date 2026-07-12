/**
 * Wire protocol types for sync requests and responses.
 *
 * The protocol is a single POST endpoint that accepts a `SyncRequest` and
 * returns a `SyncResponse`. Both directions transport the same shape: a
 * map of model name → array of rows ("changes"), plus tombstones, plus
 * pagination metadata.
 *
 * @see SyncRequest, SyncResponse, Tombstone
 */

import { SchemaViolationError } from './errors'
import type { ChangeSet, Row, Scope } from './types'

/** Current wire protocol version. Major bump = breaking change. */
export const PROTOCOL_VERSION = '1.0.0'

/**
 * Compound pagination cursor with (hlc, id) tiebreak.
 *
 * The id field is REQUIRED for correctness — without it, two rows with the
 * same `changed` HLC could be skipped or duplicated under concurrent writes.
 */
export interface PaginationCursor {
  /** Model being paginated. */
  model: string
  /** Last HLC returned in the previous page. */
  hlc: string
  /** Last id returned in the previous page (compound tiebreak). */
  id: string
}

/**
 * Tombstone for a deleted row, with denormalized scope.
 *
 * The `scope` field is REQUIRED for security: without it, the server cannot
 * filter tombstones by tenant after the original row is gone, leading to
 * cross-tenant ID leak.
 */
export interface Tombstone {
  model: string
  id: string
  hlc: string
  /** Snapshot of scope columns at delete time, e.g. `{ userId: 'u1' }`. */
  scope: Scope
}

/**
 * A change submitted by a client (insert/update/delete intent).
 * Deletions are represented as a tombstone, not as a Row in this list.
 */
export type ChangeRow = Row

/** Immutable local write. Server uses opId to make retries idempotent. */
export interface UpsertOperation {
  opId: string
  row: Row
}

/** Immutable local delete. Server uses opId to make retries idempotent. */
export interface DeleteOperation {
  opId: string
  tombstone: Tombstone
}

/** Client write batch. Server responses continue to use plain ChangeSet rows. */
export type ClientChangeSet = Record<string, Array<UpsertOperation | ChangeRow>>

/**
 * Request body sent from client to server.
 */
export interface SyncRequest {
  /** Wire protocol version. Must match server major version. */
  protocolVersion: string

  /** Client's current HLC at the time of request (for clock correction). */
  clientTime: string

  /** Last HLC the client has fully synced to. Use HLC_ZERO for first sync. */
  since: string

  /** Pagination cursor for continuation requests. */
  cursor?: PaginationCursor | null

  /** Maximum number of rows per model in the response. */
  limit?: number

  /** Models to fully refetch (ignore `since` for these). */
  forceFetch?: string[]

  /** Client → server changes, grouped by model. */
  changes?: ClientChangeSet

  /** Client → server tombstones. */
  tombstones?: Array<DeleteOperation | Tombstone>
}

/**
 * Response body returned from server to client.
 */
export interface SyncResponse {
  /** Wire protocol version. Should match client's request. */
  protocolVersion: string

  /** Server's current HLC at the time of response. */
  serverTime: string

  /** Server → client changes, grouped by model. */
  changes: ChangeSet

  /** Server → client tombstones (with scope, filtered by request scope). */
  tombstones: Tombstone[]

  /** True if more pages exist for this `since`. Client should send another request with `cursor`. */
  hasMore: boolean

  /** Continuation cursor if `hasMore` is true. */
  cursor?: PaginationCursor | null

  /**
   * True if the client's `since` is older than the server's tombstone retention.
   * Client must call `sync.recover()` to push pending writes and refetch.
   */
  staleClient?: boolean
}

/**
 * Realtime wake-up event. Carries no row data by design.
 *
 * Servers may send this over SSE/WebSocket/push after a sync commit.
 * Clients should treat it as invalidation only and call `syncNow()` to
 * fetch scoped data through the normal sync endpoint.
 */
export interface SyncRealtimeEvent {
  type: 'changes'
  /** Unique model names changed by the commit. */
  models: string[]
  /** Server-side timestamp for debugging/ordering only. */
  at: string
}

/**
 * Force-push request: send all pending local writes regardless of `since`.
 * Used during stale-client recovery to preserve offline writes before refetch.
 */
export interface ForcePushRequest {
  protocolVersion: string
  clientTime: string
  changes: ChangeSet
  tombstones?: Tombstone[]
}

/**
 * Force-push response: per-row apply outcome.
 */
export interface ForcePushResponse {
  protocolVersion: string
  serverTime: string
  applied: Array<{ model: string; id: string }>
  rejected: Array<{ model: string; id: string; reason: string; serverHlc?: string }>
}

// ─── Validation helpers ─────────────────────────────────────────────

const HLC_REGEX = /^[0-9a-f]{24}$/

function isHlcLike(v: unknown): v is string {
  return typeof v === 'string' && HLC_REGEX.test(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse and validate a SyncRequest from an unknown JSON value.
 *
 * @throws SchemaViolationError on any structural violation.
 */
export function parseSyncRequest(input: unknown): SyncRequest {
  if (!isObject(input)) {
    throw new SchemaViolationError('SyncRequest must be a JSON object')
  }

  const { protocolVersion, clientTime, since, cursor, limit, forceFetch, changes, tombstones } =
    input

  if (typeof protocolVersion !== 'string') {
    throw new SchemaViolationError('SyncRequest.protocolVersion must be a string', undefined, 'protocolVersion')
  }
  if (!isHlcLike(clientTime)) {
    throw new SchemaViolationError('SyncRequest.clientTime must be a 24-hex HLC string', undefined, 'clientTime')
  }
  if (!isHlcLike(since)) {
    throw new SchemaViolationError('SyncRequest.since must be a 24-hex HLC string', undefined, 'since')
  }
  if (cursor !== undefined && cursor !== null) {
    if (!isObject(cursor)) {
      throw new SchemaViolationError('SyncRequest.cursor must be an object or null', undefined, 'cursor')
    }
    if (typeof cursor.model !== 'string' || !isHlcLike(cursor.hlc) || typeof cursor.id !== 'string') {
      throw new SchemaViolationError(
        'SyncRequest.cursor must have { model: string, hlc: HLC, id: string }',
        undefined,
        'cursor',
      )
    }
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
    throw new SchemaViolationError('SyncRequest.limit must be a positive integer', undefined, 'limit')
  }
  if (forceFetch !== undefined && !Array.isArray(forceFetch)) {
    throw new SchemaViolationError('SyncRequest.forceFetch must be an array of strings', undefined, 'forceFetch')
  }
  if (changes !== undefined && !isObject(changes)) {
    throw new SchemaViolationError('SyncRequest.changes must be an object', undefined, 'changes')
  }
  if (changes) {
    for (const [model, operations] of Object.entries(changes)) {
      if (!Array.isArray(operations)) {
        throw new SchemaViolationError(`SyncRequest.changes.${model} must be an array`, undefined, `changes.${model}`)
      }
      for (let i = 0; i < operations.length; i++) {
        const operation = operations[i]
        if (!isObject(operation)) {
          throw new SchemaViolationError(
            `SyncRequest.changes.${model}[${i}] must be a row or { opId, row }`,
            undefined,
            `changes.${model}[${i}]`,
          )
        }
        const hasOperationEnvelope = 'opId' in operation || 'row' in operation
        if (hasOperationEnvelope &&
          (typeof operation.opId !== 'string' || operation.opId.length === 0 || !isObject(operation.row))) {
          throw new SchemaViolationError(
            `SyncRequest.changes.${model}[${i}] must have { opId, row }`,
            undefined,
            `changes.${model}[${i}]`,
          )
        }
      }
    }
  }
  if (tombstones !== undefined) {
    if (!Array.isArray(tombstones)) {
      throw new SchemaViolationError('SyncRequest.tombstones must be an array', undefined, 'tombstones')
    }
    for (let i = 0; i < tombstones.length; i++) {
      const operation = tombstones[i]
      if (!isObject(operation)) {
        throw new SchemaViolationError(`tombstones[${i}] must be a tombstone or { opId, tombstone }`, undefined, `tombstones[${i}]`)
      }
      const hasOperationEnvelope = 'opId' in operation || 'tombstone' in operation
      if (hasOperationEnvelope) {
        if (typeof operation.opId !== 'string' || operation.opId.length === 0) {
          throw new SchemaViolationError(`tombstones[${i}] must have a non-empty opId`, undefined, `tombstones[${i}]`)
        }
        validateTombstone(operation.tombstone, `tombstones[${i}].tombstone`)
      } else {
        validateTombstone(operation, `tombstones[${i}]`)
      }
    }
  }

  return input as unknown as SyncRequest
}

/** Validate an untrusted server response before client writes it locally. */
export function parseSyncResponse(input: unknown): SyncResponse {
  if (!isObject(input)) {
    throw new SchemaViolationError('SyncResponse must be a JSON object')
  }
  const { protocolVersion, serverTime, changes, tombstones, hasMore, cursor, staleClient } = input
  if (typeof protocolVersion !== 'string') {
    throw new SchemaViolationError('SyncResponse.protocolVersion must be a string', undefined, 'protocolVersion')
  }
  if (!isHlcLike(serverTime)) {
    throw new SchemaViolationError('SyncResponse.serverTime must be a 24-hex HLC string', undefined, 'serverTime')
  }
  if (!isObject(changes)) {
    throw new SchemaViolationError('SyncResponse.changes must be an object', undefined, 'changes')
  }
  for (const [model, rows] of Object.entries(changes)) {
    if (!Array.isArray(rows) || rows.some((row) => !isObject(row))) {
      throw new SchemaViolationError(`SyncResponse.changes.${model} must be an array of rows`, undefined, `changes.${model}`)
    }
  }
  if (!Array.isArray(tombstones)) {
    throw new SchemaViolationError('SyncResponse.tombstones must be an array', undefined, 'tombstones')
  }
  for (let index = 0; index < tombstones.length; index++) {
    validateTombstone(tombstones[index], `tombstones[${index}]`)
  }
  if (typeof hasMore !== 'boolean') {
    throw new SchemaViolationError('SyncResponse.hasMore must be a boolean', undefined, 'hasMore')
  }
  if (cursor !== null && cursor !== undefined) {
    if (!isObject(cursor) || typeof cursor.model !== 'string' || !isHlcLike(cursor.hlc) || typeof cursor.id !== 'string') {
      throw new SchemaViolationError('SyncResponse.cursor must have { model, hlc, id } or null', undefined, 'cursor')
    }
  }
  if (staleClient !== undefined && typeof staleClient !== 'boolean') {
    throw new SchemaViolationError('SyncResponse.staleClient must be a boolean', undefined, 'staleClient')
  }
  return input as unknown as SyncResponse
}

function validateTombstone(t: unknown, path: string): asserts t is Tombstone {
  if (!isObject(t)) {
    throw new SchemaViolationError(`${path} must be an object`, undefined, path)
  }
  if (typeof t.model !== 'string') {
    throw new SchemaViolationError(`${path}.model must be a string`, undefined, `${path}.model`)
  }
  if (typeof t.id !== 'string') {
    throw new SchemaViolationError(`${path}.id must be a string`, undefined, `${path}.id`)
  }
  if (!isHlcLike(t.hlc)) {
    throw new SchemaViolationError(`${path}.hlc must be a 24-hex HLC string`, undefined, `${path}.hlc`)
  }
  if (!isObject(t.scope)) {
    throw new SchemaViolationError(
      `${path}.scope must be an object (denormalized scope columns at delete time)`,
      'Tombstones must include scope columns to prevent cross-tenant ID leak.',
      `${path}.scope`,
    )
  }
}

/**
 * Serialize a SyncResponse to a JSON string.
 */
export function serializeSyncResponse(r: SyncResponse): string {
  return JSON.stringify(r)
}

/**
 * Build an empty SyncResponse with the given server time.
 */
export function emptySyncResponse(serverTime: string): SyncResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverTime,
    changes: {},
    tombstones: [],
    hasMore: false,
    cursor: null,
  }
}
