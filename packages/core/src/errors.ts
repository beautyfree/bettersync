/**
 * Typed errors for @better-sync/core with structural type guards.
 *
 * Why structural and not `instanceof`: when @better-sync/core is installed
 * twice (e.g. once via `better-sync`, once via a plugin's transitive dep),
 * `instanceof` fails because the two copies have different class identities.
 * Structural guards via a brand property work across instances.
 */

export const SYNC_ERROR_BRAND = '__betterSyncError'

/**
 * Wire-format error object. Stripe-style. This is what hits the network
 * and what client SDKs deserialize.
 */
export interface SyncErrorJSON {
  type: string
  code: string
  message: string
  hint?: string
  param?: string
  doc_url?: string
}

/**
 * Base error class. All sync errors extend this.
 *
 * Use {@link isSyncError} for instance checks across module copies.
 */
export class SyncError extends Error {
  /** Brand for structural identification. Survives duplicate module loads. */
  readonly [SYNC_ERROR_BRAND] = true as const

  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    public readonly docsUrl?: string,
    public readonly param?: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }

  toJSON(): SyncErrorJSON {
    const json: SyncErrorJSON = {
      type: this.code.toLowerCase(),
      code: this.code,
      message: this.message,
    }
    if (this.hint !== undefined) json.hint = this.hint
    if (this.param !== undefined) json.param = this.param
    if (this.docsUrl !== undefined) json.doc_url = this.docsUrl
    return json
  }
}

/**
 * Structural type guard. Use instead of `instanceof SyncError` because
 * duplicate copies of @better-sync/core (e.g. via plugin transitive deps)
 * break instanceof checks.
 */
export function isSyncError(err: unknown): err is SyncError {
  if (typeof err !== 'object' || err === null) return false
  const obj = err as Record<string, unknown>
  return (
    obj[SYNC_ERROR_BRAND] === true &&
    typeof obj.code === 'string' &&
    typeof obj.message === 'string'
  )
}

// ─── Concrete error subclasses ──────────────────────────────────────

export class SchemaViolationError extends SyncError {
  constructor(message: string, hint?: string, param?: string) {
    super(
      'SCHEMA_VIOLATION',
      message,
      hint,
      'https://docs.better-sync.dev/errors/schema-violation',
      param,
    )
    this.name = 'SchemaViolationError'
  }
}

export class ScopeViolationError extends SyncError {
  constructor(message: string, hint?: string) {
    super(
      'SCOPE_VIOLATION',
      message,
      hint ?? 'Check that the row matches the scope predicate for the authenticated context',
      'https://docs.better-sync.dev/errors/scope-violation',
    )
    this.name = 'ScopeViolationError'
  }
}

export class HLCRegressionError extends SyncError {
  constructor(message = 'Received HLC is older than the local HLC') {
    super(
      'HLC_REGRESSION',
      message,
      'This usually self-resolves after the next tick. Persistent regressions indicate clock skew.',
      'https://docs.better-sync.dev/errors/hlc-regression',
    )
    this.name = 'HLCRegressionError'
  }
}

export class HLCOverflowError extends SyncError {
  constructor(message = 'HLC logical counter overflow (>65535 events in 1ms)') {
    super(
      'HLC_OVERFLOW',
      message,
      'You are generating > 65535 events per millisecond. Batch your writes or rate-limit.',
      'https://docs.better-sync.dev/errors/hlc-overflow',
    )
    this.name = 'HLCOverflowError'
  }
}

export class ProtocolVersionMismatchError extends SyncError {
  constructor(clientVersion: string, serverVersion: string) {
    super(
      'PROTOCOL_VERSION_MISMATCH',
      `Client protocol version ${clientVersion} is incompatible with server ${serverVersion}`,
      'Upgrade the client to a matching major version.',
      'https://docs.better-sync.dev/errors/protocol-version-mismatch',
    )
    this.name = 'ProtocolVersionMismatchError'
  }
}

export class BatchTooLargeError extends SyncError {
  constructor(actual: number, limit: number) {
    super(
      'BATCH_TOO_LARGE',
      `Sync batch contains ${actual} changes, exceeds limit of ${limit}`,
      'Reduce limit, or split changes into smaller batches.',
      'https://docs.better-sync.dev/errors/batch-too-large',
    )
    this.name = 'BatchTooLargeError'
  }
}

export class StaleClientError extends SyncError {
  constructor() {
    super(
      'STALE_CLIENT',
      'Client has not synced within the tombstone retention window',
      'Call sync.recover() to push pending writes and refetch full snapshot.',
      'https://docs.better-sync.dev/errors/stale-client',
    )
    this.name = 'StaleClientError'
  }
}

export class AdapterError extends SyncError {
  constructor(adapterId: string, original: unknown) {
    const originalMessage =
      original instanceof Error ? original.message : String(original)
    super(
      'ADAPTER_ERROR',
      `Adapter "${adapterId}" failed: ${originalMessage}`,
      'Check the underlying database driver logs.',
      'https://docs.better-sync.dev/errors/adapter-error',
    )
    this.name = 'AdapterError'
  }
}

export class UnauthorizedError extends SyncError {
  constructor(message = 'Authentication required') {
    super(
      'UNAUTHORIZED',
      message,
      'The auth hook returned no context or threw. Check Authorization header.',
      'https://docs.better-sync.dev/errors/unauthorized',
    )
    this.name = 'UnauthorizedError'
  }
}

export class HookTimeoutError extends SyncError {
  constructor(hookName: string, budgetMs: number) {
    super(
      'HOOK_TIMEOUT',
      `Hook "${hookName}" exceeded ${budgetMs}ms time budget`,
      'Move slow work out of afterWriteInTransaction. Use a DB queue + worker pattern.',
      'https://docs.better-sync.dev/errors/hook-timeout',
    )
    this.name = 'HookTimeoutError'
  }
}
