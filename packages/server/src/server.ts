/**
 * createSyncServer — factory that takes an adapter + schema + hooks and
 * returns a server with a `handleSync` method.
 *
 * The server is framework-agnostic: `handleSync` takes a parsed SyncRequest
 * and an authenticated context and returns a SyncResponse. Framework bindings
 * (@bettersync/server-hono, /server-next, etc.) will call this under the hood.
 */

import {
  type ChangeSet,
  decodeHlc,
  HLC_ZERO,
  HLClock,
  type HLClockOptions,
  type PaginationCursor,
  PROTOCOL_VERSION,
  ProtocolVersionMismatchError,
  type Row,
  SchemaViolationError,
  ScopeViolationError,
  type Scope,
  type SyncAdapter,
  type SyncRequest,
  type SyncResponse,
  type SyncSchema,
  type Tombstone,
  emptySyncResponse,
  isSyncError,
  parseSyncRequest,
} from '@bettersync/core'
import { DEFAULT_HOOK_BUDGET_MS, runHookWithTimeout } from './hooks'

export interface BeforeReadArgs<Ctx> {
  model: string
  ctx: Ctx
}

export interface HookChangeDescriptor {
  model: string
  row: Row
  action: 'insert' | 'update' | 'delete'
}

export interface AfterWriteInTransactionArgs<Ctx> extends HookChangeDescriptor {
  ctx: Ctx
  tx: SyncAdapter
}

export interface AfterCommitArgs<Ctx> {
  changes: HookChangeDescriptor[]
  ctx: Ctx
}

/**
 * Hooks are split into three phases with STRICT rules:
 *
 * - `beforeRead`: can extend the scope filter before reads. Pure, fast.
 * - `afterWriteInTransaction`: runs inside the sync transaction with a
 *   hard 100ms budget. Use ONLY for atomic DB writes (e.g. enqueue job
 *   row). Do NOT make network calls here.
 * - `afterCommit`: runs after the sync transaction commits. Fire-and-forget,
 *   unbounded time. Use for SSE broadcast, cache invalidation, webhooks.
 *   Errors are caught and logged; they do NOT affect the sync response.
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface SyncServerHooks<Ctx = any> {
  beforeRead?: (args: BeforeReadArgs<Ctx>) => Promise<Scope | void>
  afterWriteInTransaction?: (args: AfterWriteInTransactionArgs<Ctx>) => Promise<void>
  afterCommit?: (args: AfterCommitArgs<Ctx>) => Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface CreateSyncServerOptions<Ctx = any> {
  database: SyncAdapter
  schema: SyncSchema<Ctx>
  hooks?: SyncServerHooks<Ctx>
  /** Field name where the HLC lives on rows. Default: `'changed'`. */
  hlcField?: string
  /** Time budget for afterWriteInTransaction hooks (ms). Default: 100. */
  afterWriteInTransactionBudgetMs?: number
  /** HLC clock options (node id, custom clock function). */
  clock?: HLClockOptions
  /**
   * Tombstone retention in milliseconds. Clients that haven't synced within
   * this window get `staleClient: true` and must call `recover()`.
   * Default: 30 days. Set to 0 to disable stale detection.
   */
  tombstoneRetentionMs?: number
  /**
   * Auth resolver for the built-in `sync.handler` Web API handler.
   * Extracts context (e.g. userId) from the incoming Request.
   * Can also be set later via `sync.setAuth(fn)`.
   */
  auth?: AuthResolver<Ctx>
}

export type AuthResolver<Ctx> = (req: Request) => Promise<Ctx> | Ctx

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface SyncServer<Ctx = any> {
  readonly hlc: HLClock
  readonly schema: SyncSchema<Ctx>
  readonly options: CreateSyncServerOptions<Ctx>
  handleSync(request: SyncRequest, ctx: Ctx): Promise<SyncResponse>
  /**
   * Standard Web API handler. Pass an auth resolver to extract context.
   *
   * Usage with any framework that supports Web API Request/Response:
   *   // Hono: app.post('/sync', (c) => sync.handler(c.req.raw))
   *   // Elysia: app.mount(sync.handler)
   *   // Next.js: export const POST = (req) => sync.handler(req)
   *   // Bun: Bun.serve({ fetch: sync.handler })
   */
  handler: (req: Request) => Promise<Response>
  /** Set the auth resolver used by handler(). */
  setAuth(auth: AuthResolver<Ctx>): void
}

/**
 * Create a sync server. Call `server.handleSync(request, ctx)` from your
 * HTTP handler (Next.js Route Handler, Hono, Express, etc.).
 */
export function createSyncServer<Ctx>(
  options: CreateSyncServerOptions<Ctx>,
): SyncServer<Ctx> {
  const hlc = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const budget = options.afterWriteInTransactionBudgetMs ?? DEFAULT_HOOK_BUDGET_MS
  const retentionMs = options.tombstoneRetentionMs ?? 30 * 24 * 60 * 60 * 1000 // 30 days
  let authResolver: AuthResolver<Ctx> | null = (options as { auth?: AuthResolver<Ctx> }).auth ?? null

  const server: SyncServer<Ctx> = {
    hlc,
    schema: options.schema,
    options,

    async handleSync(request, ctx) {
      // ─── Protocol version check ─────────────────────────────────
      if (!isProtocolCompatible(request.protocolVersion)) {
        throw new ProtocolVersionMismatchError(request.protocolVersion, PROTOCOL_VERSION)
      }

      // ─── HLC merge with client time ─────────────────────────────
      hlc.receive(request.clientTime)

      // ─── Stale client detection ─────────────────────────────────
      const isStale = retentionMs > 0 && isClientStale(request.since, retentionMs)

      const limit = Math.min(request.limit ?? 1000, 1000)
      const appliedChanges: HookChangeDescriptor[] = []

      // ─── Apply client writes inside transaction ─────────────────
      // We STILL apply client writes even for stale clients — their
      // pending data is valid. We just can't guarantee tombstone
      // consistency, so we flag staleClient in the response.
      const response: SyncResponse = await options.database.transaction(async (tx) => {
        await applyClientChanges({
          tx,
          request,
          ctx,
          schema: options.schema,
          hlcField,
          hooks: options.hooks,
          budget,
          appliedChanges,
          serverHlc: hlc,
        })

        // ─── Build server → client response inside the same tx ──
        const { changes, tombstones, hasMore, cursor } = await buildServerResponse({
          tx,
          request,
          ctx,
          schema: options.schema,
          limit,
          hooks: options.hooks,
        })

        return {
          protocolVersion: PROTOCOL_VERSION,
          serverTime: hlc.tick(),
          changes,
          tombstones,
          hasMore,
          cursor,
          ...(isStale ? { staleClient: true } : {}),
        }
      })

      // ─── afterCommit hook (fire-and-forget) ─────────────────────
      if (options.hooks?.afterCommit && appliedChanges.length > 0) {
        const afterCommit = options.hooks.afterCommit
        // Do NOT await. Catch errors to avoid unhandled rejections.
        Promise.resolve()
          .then(() => afterCommit({ changes: appliedChanges, ctx }))
          .catch((err) => {
            // Intentional: afterCommit errors should not affect the sync response.
            // In production, wire this to a logger.
            // biome-ignore lint/suspicious/noConsole: library fallback logger
            console.error('[better-sync] afterCommit hook failed:', err)
          })
      }

      return response
    },

    // ─── Web API handler ──────────────────────────────────────
    handler: async (req: Request): Promise<Response> => {
      if (!authResolver) {
        return Response.json({ error: { message: 'Auth not configured. Call sync.setAuth() or pass auth to betterSync().' } }, { status: 500 })
      }
      try {
        const body = await req.json()
        const syncReq = parseSyncRequest(body)
        const ctx = await authResolver(req)
        const syncRes = await server.handleSync(syncReq, ctx)
        return Response.json(syncRes)
      } catch (err: unknown) {
        if (isSyncError(err)) {
          const s = err as { code: string; toJSON(): unknown }
          return Response.json(s.toJSON(), { status: errorCodeToHttpStatus(s.code) })
        }
        const message = err instanceof Error ? err.message : 'Internal server error'
        const status = message.toLowerCase().includes('unauthorized') ? 401 : 500
        return Response.json({ error: { message } }, { status })
      }
    },

    setAuth(auth: AuthResolver<Ctx>) {
      authResolver = auth
    },
  }

  return server
}

function errorCodeToHttpStatus(code: string): number {
  switch (code) {
    case 'SCHEMA_VIOLATION': return 400
    case 'UNAUTHORIZED': return 401
    case 'SCOPE_VIOLATION': return 403
    case 'PROTOCOL_VERSION_MISMATCH': return 409
    case 'BATCH_TOO_LARGE': return 413
    case 'STALE_CLIENT': return 410
    default: return 500
  }
}

function isProtocolCompatible(clientVersion: string): boolean {
  const [clientMajor] = clientVersion.split('.')
  const [serverMajor] = PROTOCOL_VERSION.split('.')
  return clientMajor === serverMajor
}

/**
 * Check if a client's `since` HLC is older than the retention window.
 * Extracts the wall clock ms from the HLC and compares to now.
 */
function isClientStale(sinceHlc: string, retentionMs: number): boolean {
  if (sinceHlc === HLC_ZERO) return false // First sync is not stale
  try {
    const parts = decodeHlc(sinceHlc)
    const age = Date.now() - parts.wall
    return age > retentionMs
  } catch {
    return false
  }
}

// ─── Client → server write pipeline ─────────────────────────────────

interface ApplyClientChangesParams<Ctx> {
  tx: SyncAdapter
  request: SyncRequest
  ctx: Ctx
  schema: SyncSchema<Ctx>
  hlcField: string
  hooks: SyncServerHooks<Ctx> | undefined
  budget: number
  appliedChanges: HookChangeDescriptor[]
  /**
   * Server's HLC clock. Used to RE-STAMP incoming client writes with a
   * server-authoritative HLC, so that `findChangedSince(since=server_time)`
   * works consistently. Without re-stamping, rows written by clients with
   * clock-skew-behind-server would be invisible to other clients' sync
   * queries (their HLCs are less than the server's `since` marker).
   */
  serverHlc: HLClock
}

async function applyClientChanges<Ctx>({
  tx,
  request,
  ctx,
  schema,
  hlcField,
  hooks,
  budget,
  appliedChanges,
  serverHlc,
}: ApplyClientChangesParams<Ctx>): Promise<void> {
  // Row upserts
  if (request.changes) {
    for (const [model, rows] of Object.entries(request.changes)) {
      const modelDef = schema[model]
      if (!modelDef) {
        throw new SchemaViolationError(
          `Unknown model "${model}" in request.changes`,
          'Make sure the model is declared in your sync schema.',
          `changes.${model}`,
        )
      }

      const canCreate = modelDef.clientCanCreate !== false
      const canUpdate = modelDef.clientCanUpdate !== false
      if (!canCreate && !canUpdate) continue

      for (const row of rows) {
        const clientHlc = row[hlcField]
        if (typeof clientHlc !== 'string') {
          throw new SchemaViolationError(
            `Row on model "${model}" is missing "${hlcField}" HLC field`,
            undefined,
            `changes.${model}.${hlcField}`,
          )
        }

        // Scope enforcement: if model has scope, row must match ctx scope
        if (modelDef.scope) {
          const expected = modelDef.scope(ctx)
          enforceScope(row, expected, model)
        }

        // Strip `input: false` fields — server owns those
        const sanitized = sanitizeForWrite(row, modelDef)

        // RE-STAMP with server HLC — required for findChangedSince to work
        // across clients with divergent clocks. The server's HLC advances
        // past the client's on `receive`, guaranteeing the stamped row's
        // HLC is greater than any prior server state.
        const stampedHlc = serverHlc.receive(clientHlc)
        const stamped: Row = { ...sanitized, [hlcField]: stampedHlc }

        const outcome = await tx.upsertIfNewer({ model, row: stamped })
        if (outcome === 'skipped') continue

        const descriptor: HookChangeDescriptor = {
          model,
          row: stamped,
          action: outcome === 'inserted' ? 'insert' : 'update',
        }
        appliedChanges.push(descriptor)

        if (hooks?.afterWriteInTransaction) {
          const hook = hooks.afterWriteInTransaction
          await runHookWithTimeout(
            'afterWriteInTransaction',
            () => hook({ ...descriptor, ctx, tx }),
            budget,
          )
        }
      }
    }
  }

  // Tombstones
  if (request.tombstones) {
    for (const tombstone of request.tombstones) {
      const modelDef = schema[tombstone.model]
      if (!modelDef) {
        throw new SchemaViolationError(
          `Unknown model "${tombstone.model}" in request.tombstones`,
          undefined,
          `tombstones.${tombstone.model}`,
        )
      }
      if (modelDef.clientCanDelete === false) continue

      // Scope enforcement on tombstones
      if (modelDef.scope) {
        const expected = modelDef.scope(ctx)
        enforceScopeOnTombstone(tombstone.scope, expected, tombstone.model)
      }

      // Re-stamp tombstone HLC the same way as rows, for the same reason.
      const stampedTombstoneHlc = serverHlc.receive(tombstone.hlc)
      const stampedTombstone: Tombstone = {
        ...tombstone,
        hlc: stampedTombstoneHlc,
      }

      const applied = await tx.upsertTombstoneIfNewer(stampedTombstone)
      if (!applied) continue

      const descriptor: HookChangeDescriptor = {
        model: stampedTombstone.model,
        row: { id: stampedTombstone.id, ...stampedTombstone.scope },
        action: 'delete',
      }
      appliedChanges.push(descriptor)

      if (hooks?.afterWriteInTransaction) {
        const hook = hooks.afterWriteInTransaction
        await runHookWithTimeout(
          'afterWriteInTransaction',
          () => hook({ ...descriptor, ctx, tx }),
          budget,
        )
      }
    }
  }
}

function enforceScope(row: Row, expectedScope: Scope, model: string): void {
  for (const [k, v] of Object.entries(expectedScope)) {
    if (row[k] !== v) {
      throw new ScopeViolationError(
        `Row on model "${model}" has ${k}=${JSON.stringify(
          row[k],
        )}, but authenticated context expects ${k}=${JSON.stringify(v)}`,
      )
    }
  }
}

function enforceScopeOnTombstone(
  tombstoneScope: Scope,
  expectedScope: Scope,
  model: string,
): void {
  for (const [k, v] of Object.entries(expectedScope)) {
    if (tombstoneScope[k] !== v) {
      throw new ScopeViolationError(
        `Tombstone on model "${model}" has scope.${k}=${JSON.stringify(
          tombstoneScope[k],
        )}, but authenticated context expects ${k}=${JSON.stringify(v)}`,
      )
    }
  }
}

function sanitizeForWrite<Ctx>(row: Row, modelDef: SyncSchema<Ctx>[string]): Row {
  const result: Row = {}
  for (const [key, value] of Object.entries(row)) {
    const field = modelDef.fields[key]
    if (field && field.input === false) continue
    result[key] = value
  }
  return result
}

// ─── Server → client response pipeline ──────────────────────────────

interface BuildServerResponseParams<Ctx> {
  tx: SyncAdapter
  request: SyncRequest
  ctx: Ctx
  schema: SyncSchema<Ctx>
  limit: number
  hooks: SyncServerHooks<Ctx> | undefined
}

interface ServerResponseParts {
  changes: ChangeSet
  tombstones: Tombstone[]
  hasMore: boolean
  cursor: PaginationCursor | null
}

async function buildServerResponse<Ctx>({
  tx,
  request,
  ctx,
  schema,
  limit,
  hooks,
}: BuildServerResponseParams<Ctx>): Promise<ServerResponseParts> {
  const changes: ChangeSet = {}
  let tombstones: Tombstone[] = []
  let hasMore = false
  let cursor: PaginationCursor | null = null

  // Determine which models to read.
  const forceFetchSet = new Set(request.forceFetch ?? [])
  // If a cursor is present, resume from its model only. Other models are
  // served on the next request after the current one finishes paginating.
  const modelOrder = request.cursor
    ? [request.cursor.model]
    : Object.keys(schema)

  const emptyResponse = emptySyncResponse('')
  if (modelOrder.length === 0) {
    return { changes: emptyResponse.changes, tombstones: emptyResponse.tombstones, hasMore, cursor }
  }

  for (const modelKey of modelOrder) {
    const modelDef = schema[modelKey]
    if (!modelDef) continue

    let scope = modelDef.scope ? modelDef.scope(ctx) : undefined
    if (hooks?.beforeRead) {
      const extra = await hooks.beforeRead({ model: modelKey, ctx })
      if (extra) scope = { ...scope, ...extra }
    }

    const forceThisModel = forceFetchSet.has(modelKey)
    const sinceHlc = forceThisModel ? '000000000000000000000000' : request.since
    const cursorForModel =
      request.cursor && request.cursor.model === modelKey
        ? { hlc: request.cursor.hlc, id: request.cursor.id }
        : undefined

    const { rows, nextCursor } = await tx.findChangedSince({
      model: modelKey,
      sinceHlc,
      limit,
      ...(cursorForModel ? { cursor: cursorForModel } : {}),
      ...(scope ? { scope } : {}),
    })

    changes[modelKey] = filterOutput(rows, modelDef)

    if (nextCursor) {
      hasMore = true
      cursor = { model: modelKey, hlc: nextCursor.hlc, id: nextCursor.id }
      // Stop — one model at a time for pagination stability
      break
    }
  }

  // Tombstones: only collect when we're NOT mid-pagination (cursor is null),
  // to keep the protocol simple. Tombstones are included with the final page.
  if (!hasMore) {
    // Collect tombstones across all models we're serving.
    // For v0.1, use the first model's scope as a heuristic; multi-tenant
    // apps typically have the same scope shape for all models.
    const firstModelKey = Object.keys(schema)[0]
    const firstModelDef = firstModelKey ? schema[firstModelKey] : undefined
    const scope = firstModelDef?.scope ? firstModelDef.scope(ctx) : undefined

    const allTombs = await tx.findTombstonesSince({
      sinceHlc: request.since,
      limit: 1000,
      ...(scope ? { scope } : {}),
    })
    tombstones = allTombs.filter((t) => modelOrder.includes(t.model))
  }

  return { changes, tombstones, hasMore, cursor }
}

function filterOutput<Ctx>(rows: Row[], modelDef: SyncSchema<Ctx>[string]): Row[] {
  const hiddenFields = new Set<string>()
  for (const [name, field] of Object.entries(modelDef.fields)) {
    if (field.output === false) hiddenFields.add(name)
  }
  if (hiddenFields.size === 0) return rows
  return rows.map((row) => {
    const filtered: Row = {}
    for (const [k, v] of Object.entries(row)) {
      if (!hiddenFields.has(k)) filtered[k] = v
    }
    return filtered
  })
}
