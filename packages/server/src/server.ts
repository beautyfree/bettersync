/**
 * createSyncServer — factory that takes an adapter + schema + hooks and
 * returns a server with a `handleSync` method.
 *
 * The server is framework-agnostic: `handleSync` takes a parsed SyncRequest
 * and an authenticated context and returns a SyncResponse. Framework bindings
 * (@bettersync/server-hono, /server-next, etc.) will call this under the hood.
 */

import {
  BatchTooLargeError,
  type ChangeSet,
  decodeHlc,
  getPrimaryKey,
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
  type SyncRealtimeEvent,
  type SyncResponse,
  type SyncSchema,
  type Tombstone,
  type DeleteOperation,
  type UpsertOperation,
  emptySyncResponse,
  isSyncError,
  parseSyncRequest,
  validateSchema,
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

/**
 * Arguments to `beforeWrite`. Fires INSIDE the sync transaction
 * BEFORE the row upsert (for insert/update) or tombstone application
 * (for delete). Throwing inside the hook rolls the whole transaction
 * back, so it's the right place for write-time authz checks like
 * "only the creator may delete this row".
 *
 * For `action: 'delete'`, `existing` is the row currently in the DB
 * (or `null` if the row was already gone). For insert / update,
 * `existing` is the prior row state if any (null for fresh inserts).
 * `row` is the incoming stamped row for insert/update, undefined for
 * delete.
 */
export interface BeforeWriteArgs<Ctx> {
  model: string
  action: 'insert' | 'update' | 'delete'
  row?: Row
  existing: Row | null
  tombstone?: Tombstone
  ctx: Ctx
  tx: SyncAdapter
}

export interface AfterCommitArgs<Ctx> {
  changes: HookChangeDescriptor[]
  ctx: Ctx
}

export interface SyncRealtimePublishArgs<Ctx> extends AfterCommitArgs<Ctx> {
  event: SyncRealtimeEvent
}

export interface SyncRealtimePublisher<Ctx> {
  publish(args: SyncRealtimePublishArgs<Ctx>): void | Promise<void>
}

export type SyncRealtimeUnsubscribe = () => void

export interface SyncRealtimeBus<Ctx> extends SyncRealtimePublisher<Ctx> {
  subscribe(ctx: Ctx, listener: (event: SyncRealtimeEvent) => void): SyncRealtimeUnsubscribe
  /**
   * Web API SSE handler. Mount next to the POST sync handler, e.g.
   * `GET /api/sync/events`.
   */
  handler(auth: AuthResolver<Ctx>): (req: Request) => Promise<Response>
}

/**
 * Hooks are split into four phases with STRICT rules:
 *
 * - `beforeRead`: can extend the scope filter before reads. Pure, fast.
 * - `beforeWrite`: fires INSIDE the sync transaction before each row
 *   upsert / tombstone is applied. Throw to abort the whole sync.
 *   Use for write-time authz (e.g. "only owner may delete").
 *   Same 100ms budget as afterWriteInTransaction — do NOT make
 *   network calls.
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
  beforeWrite?: (args: BeforeWriteArgs<Ctx>) => Promise<void>
  afterWriteInTransaction?: (args: AfterWriteInTransactionArgs<Ctx>) => Promise<void>
  afterCommit?: (args: AfterCommitArgs<Ctx>) => Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface CreateSyncServerOptions<Ctx = any> {
  database: SyncAdapter
  schema: SyncSchema<Ctx>
  hooks?: SyncServerHooks<Ctx>
  /**
   * Optional realtime invalidation publisher. Called after a successful
   * sync commit. It should only wake clients up; clients still fetch rows
   * through handleSync().
   */
  realtime?: SyncRealtimePublisher<Ctx>
  /** Field name where the HLC lives on rows. Default: `'changed'`. */
  hlcField?: string
  /** Time budget for afterWriteInTransaction hooks (ms). Default: 100. */
  afterWriteInTransactionBudgetMs?: number
  /** HLC clock options (node id, custom clock function). */
  clock?: HLClockOptions
  /**
   * Maximum page size the server will honor from `request.limit`.
   * Default: 1000. Raise this for trusted deployments with larger
   * initial snapshots to avoid multi-page cold-start pulls.
   */
  maxLimit?: number
  /** Maximum client upserts + deletes accepted in one request. Default: 1000. */
  maxBatchSize?: number
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
  validateSchema(options.schema)
  const hlc = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const budget = options.afterWriteInTransactionBudgetMs ?? DEFAULT_HOOK_BUDGET_MS
  const retentionMs = options.tombstoneRetentionMs ?? 30 * 24 * 60 * 60 * 1000 // 30 days
  const maxLimit = options.maxLimit ?? 1000
  const maxBatchSize = options.maxBatchSize ?? 1000
  let authResolver: AuthResolver<Ctx> | null = (options as { auth?: AuthResolver<Ctx> }).auth ?? null

  const server: SyncServer<Ctx> = {
    hlc,
    schema: options.schema,
    options,

    async handleSync(request, ctx) {
      // `handleSync` is public and can be called without the HTTP handler.
      // Validate here as well so direct framework integrations get the same
      // structural guarantees as `sync.handler()`.
      const parsedRequest = parseSyncRequest(request)
      const operationCount =
        Object.values(parsedRequest.changes ?? {}).reduce((total, operations) => total + operations.length, 0) +
        (parsedRequest.tombstones?.length ?? 0)
      if (operationCount > maxBatchSize) {
        throw new BatchTooLargeError(operationCount, maxBatchSize)
      }
      // ─── Protocol version check ─────────────────────────────────
      if (!isProtocolCompatible(parsedRequest.protocolVersion)) {
        throw new ProtocolVersionMismatchError(parsedRequest.protocolVersion, PROTOCOL_VERSION)
      }

      // ─── HLC merge with client time ─────────────────────────────
      hlc.receive(parsedRequest.clientTime)

      // ─── Stale client detection ─────────────────────────────────
      const isStale = retentionMs > 0 && isClientStale(parsedRequest.since, retentionMs)

      const limit = Math.min(parsedRequest.limit ?? maxLimit, maxLimit)
      const appliedChanges: HookChangeDescriptor[] = []

      // ─── Apply client writes inside transaction ─────────────────
      // We STILL apply client writes even for stale clients — their
      // pending data is valid. We just can't guarantee tombstone
      // consistency, so we flag staleClient in the response.
      const response: SyncResponse = await options.database.transaction(async (tx) => {
        await applyClientChanges({
          tx,
          request: parsedRequest,
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
          request: parsedRequest,
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
      if (appliedChanges.length > 0) {
        const event: SyncRealtimeEvent = {
          type: 'changes',
          models: uniqueModels(appliedChanges),
          at: new Date().toISOString(),
        }

        if (options.realtime) {
          const realtime = options.realtime
          Promise.resolve()
            .then(() => realtime.publish({ changes: appliedChanges, ctx, event }))
            .catch((err) => {
              // biome-ignore lint/suspicious/noConsole: library fallback logger
              console.error('[bettersync] realtime publish failed:', err)
            })
        }
      }

      if (options.hooks?.afterCommit && appliedChanges.length > 0) {
        const afterCommit = options.hooks.afterCommit
        // Do NOT await. Catch errors to avoid unhandled rejections.
        Promise.resolve()
          .then(() => afterCommit({ changes: appliedChanges, ctx }))
          .catch((err) => {
            // Intentional: afterCommit errors should not affect the sync response.
            // In production, wire this to a logger.
            // biome-ignore lint/suspicious/noConsole: library fallback logger
            console.error('[bettersync] afterCommit hook failed:', err)
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

export interface CreateInMemoryRealtimeBusOptions<Ctx> {
  /**
   * Topic used to match writers and subscribers. Keep it tenant/family/user
   * scoped. Returning multiple topics publishes/subscribes to each.
   */
  topic(ctx: Ctx): string | string[]
  /**
   * Optional filter for extra authz. Return false to suppress event for a
   * topic subscriber. Defaults to true.
   */
  filter?(args: { ctx: Ctx; event: SyncRealtimeEvent; changes: HookChangeDescriptor[] }): boolean
  /**
   * Coalesce bursts per topic before notifying listeners. Default: 50ms.
   * Use 0 for immediate delivery in tests.
   */
  debounceMs?: number
  /**
   * Optional safety cap for long-lived SSE subscribers. Prefer external
   * push infrastructure for large mobile fleets.
   */
  maxSubscribers?: number
}

export function createInMemoryRealtimeBus<Ctx>(
  options: CreateInMemoryRealtimeBusOptions<Ctx>,
): SyncRealtimeBus<Ctx> {
  const listenersByTopic = new Map<string, Set<(event: SyncRealtimeEvent) => void>>()
  const pendingByTopic = new Map<string, { models: Set<string>; timer: ReturnType<typeof setTimeout> }>()
  const debounceMs = options.debounceMs ?? 50
  let subscriberCount = 0

  function topicsFor(ctx: Ctx): string[] {
    const raw = options.topic(ctx)
    return (Array.isArray(raw) ? raw : [raw]).filter(Boolean)
  }

  function emitTopic(topic: string, event: SyncRealtimeEvent): void {
    const listeners = listenersByTopic.get(topic)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // listener errors do not affect other subscribers
      }
    }
  }

  function scheduleTopic(topic: string, event: SyncRealtimeEvent): void {
    if (debounceMs <= 0) {
      emitTopic(topic, event)
      return
    }

    const pending = pendingByTopic.get(topic)
    if (pending) {
      for (const model of event.models) pending.models.add(model)
      return
    }

    const models = new Set(event.models)
    const timer = setTimeout(() => {
      pendingByTopic.delete(topic)
      emitTopic(topic, {
        type: 'changes',
        models: Array.from(models).sort(),
        at: new Date().toISOString(),
      })
    }, debounceMs)
    unrefTimer(timer)
    pendingByTopic.set(topic, { models, timer })
  }

  const bus: SyncRealtimeBus<Ctx> = {
    publish({ changes, ctx, event }) {
      if (options.filter && !options.filter({ ctx, event, changes })) return
      for (const topic of topicsFor(ctx)) {
        scheduleTopic(topic, event)
      }
    },

    subscribe(ctx, listener) {
      if (options.maxSubscribers !== undefined && subscriberCount >= options.maxSubscribers) {
        throw new Error('bettersync realtime subscriber limit exceeded')
      }
      const topics = topicsFor(ctx)
      subscriberCount += 1
      for (const topic of topics) {
        let listeners = listenersByTopic.get(topic)
        if (!listeners) {
          listeners = new Set()
          listenersByTopic.set(topic, listeners)
        }
        listeners.add(listener)
      }
      return () => {
        subscriberCount = Math.max(0, subscriberCount - 1)
        for (const topic of topics) {
          const listeners = listenersByTopic.get(topic)
          if (!listeners) continue
          listeners.delete(listener)
          if (listeners.size === 0) listenersByTopic.delete(topic)
        }
      }
    },

    handler(auth) {
      return async (req: Request): Promise<Response> => {
        try {
          const ctx = await auth(req)
          const encoder = new TextEncoder()
          let unsubscribe: SyncRealtimeUnsubscribe | null = null
          let heartbeat: ReturnType<typeof setInterval> | null = null

          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(encoder.encode(': connected\n\n'))
              unsubscribe = bus.subscribe(ctx, (event) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              })
              heartbeat = setInterval(() => {
                controller.enqueue(encoder.encode(': heartbeat\n\n'))
              }, 25_000)
              unrefTimer(heartbeat)
            },
            cancel: () => {
              if (heartbeat) clearInterval(heartbeat)
              heartbeat = null
              unsubscribe?.()
              unsubscribe = null
            },
          })

          req.signal.addEventListener('abort', () => {
            if (heartbeat) clearInterval(heartbeat)
            heartbeat = null
            unsubscribe?.()
            unsubscribe = null
          }, { once: true })

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
            },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unauthorized'
          return Response.json({ error: { message } }, { status: 401 })
        }
      }
    },
  }

  return bus
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

function uniqueModels(changes: HookChangeDescriptor[]): string[] {
  return Array.from(new Set(changes.map((change) => change.model))).sort()
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybe = timer as unknown as { unref?: () => void }
  maybe.unref?.()
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

      for (const operation of rows) {
        const hasOperationEnvelope = isUpsertOperation(operation)
        const row = hasOperationEnvelope ? operation.row : operation
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

        // A lost HTTP response retries the same immutable operation. Claiming
        // first prevents that retry from being re-stamped as a newer write.
        if (hasOperationEnvelope && !(await tx.claimOperation({ model, opId: operation.opId }))) continue

        // Strip `input: false` fields — server owns those
        const sanitized = sanitizeForWrite(row, modelDef)

        // RE-STAMP with server HLC — required for findChangedSince to work
        // across clients with divergent clocks. The server's HLC advances
        // past the client's on `receive`, guaranteeing the stamped row's
        // HLC is greater than any prior server state.
        const stampedHlc = serverHlc.receive(clientHlc)
        const stamped: Row = { ...sanitized, [hlcField]: stampedHlc }

        if (hooks?.beforeWrite) {
          const pkField = getPrimaryKey(model, modelDef)
          const existing = await tx.findOne({
            model,
            where: { [pkField]: stamped[pkField] },
          })
          const beforeAction: 'insert' | 'update' = existing ? 'update' : 'insert'
          const hook = hooks.beforeWrite
          await runHookWithTimeout(
            'beforeWrite',
            () =>
              hook({
                model,
                action: beforeAction,
                row: stamped,
                existing,
                ctx,
                tx,
              }),
            budget,
          )
        }

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
    for (const operation of request.tombstones) {
      const hasOperationEnvelope = isDeleteOperation(operation)
      const incomingTombstone = hasOperationEnvelope ? operation.tombstone : operation
      const tombstone = incomingTombstone
      const modelDef = schema[tombstone.model]
      if (!modelDef) {
        throw new SchemaViolationError(
          `Unknown model "${tombstone.model}" in request.tombstones`,
          undefined,
          `tombstones.${tombstone.model}`,
        )
      }
      if (modelDef.clientCanDelete === false) continue

      // Legacy clients copied every scalar field into a tombstone. Preserve
      // their deletes during a rolling upgrade, but only persist the declared
      // tenancy fields needed to authorize and route the deletion.
      const scopedTombstone = sanitizeTombstoneScope(tombstone, modelDef)

      // Scope enforcement on tombstones
      if (modelDef.scope) {
        const expected = modelDef.scope(ctx)
        enforceScopeOnTombstone(scopedTombstone.scope, expected, scopedTombstone.model)
      }

      if (hasOperationEnvelope && !(await tx.claimOperation({ model: scopedTombstone.model, opId: operation.opId }))) continue

      // Re-stamp tombstone HLC the same way as rows, for the same reason.
      const stampedTombstoneHlc = serverHlc.receive(scopedTombstone.hlc)
      const stampedTombstone: Tombstone = {
        ...scopedTombstone,
        hlc: stampedTombstoneHlc,
      }

      if (hooks?.beforeWrite) {
        const pkField = getPrimaryKey(stampedTombstone.model, modelDef)
        const existing = await tx.findOne({
          model: stampedTombstone.model,
          where: { [pkField]: stampedTombstone.id },
        })
        const hook = hooks.beforeWrite
        await runHookWithTimeout(
          'beforeWrite',
          () =>
            hook({
              model: stampedTombstone.model,
              action: 'delete',
              existing,
              tombstone: stampedTombstone,
              ctx,
              tx,
            }),
          budget,
        )
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

function isUpsertOperation(operation: UpsertOperation | Row): operation is UpsertOperation {
  return (
    typeof operation.opId === 'string' &&
    operation.opId.length > 0 &&
    typeof operation.row === 'object' &&
    operation.row !== null &&
    !Array.isArray(operation.row)
  )
}

function isDeleteOperation(operation: DeleteOperation | Tombstone): operation is DeleteOperation {
  const candidate = operation as unknown as Record<string, unknown>
  return (
    typeof candidate.opId === 'string' &&
    candidate.opId.length > 0 &&
    typeof candidate.tombstone === 'object' &&
    candidate.tombstone !== null &&
    !Array.isArray(candidate.tombstone)
  )
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

function sanitizeTombstoneScope<Ctx>(
  tombstone: Tombstone,
  modelDef: SyncSchema<Ctx>[string],
): Tombstone {
  // Schemas without a scope have no tenancy data to retain. A scoped schema
  // must declare tombstoneScope (validated by validateSchema at startup).
  const allowed = modelDef.tombstoneScope ?? []
  const scope: Scope = {}
  for (const field of allowed) {
    if (field in tombstone.scope) scope[field] = tombstone.scope[field]
  }
  return { ...tombstone, scope }
}

function sanitizeForWrite<Ctx>(row: Row, modelDef: SyncSchema<Ctx>[string]): Row {
  const result: Row = {}
  for (const [key, value] of Object.entries(row)) {
    const field = modelDef.fields[key]
    // Schema is an allowlist. Never carry unknown database columns or
    // local-only/server-owned fields into a server write.
    if (!field || field.input === false || field.sync === false) continue
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

// Reserved cursor model for the tombstone phase after all row models have
// drained. Tombstones share the same durable client continuation mechanism.
const TOMBSTONE_CURSOR_PREFIX = '__bettersync_tombstones__:'

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

  if (request.cursor?.model.startsWith(TOMBSTONE_CURSOR_PREFIX)) {
    const page = await buildTombstonePage({ tx, request, ctx, schema, limit, hooks })
    return {
      changes,
      tombstones: page.tombstones,
      hasMore: page.hasMore,
      cursor: page.cursor,
    }
  }

  // Determine which models to read.
  const forceFetchSet = new Set(request.forceFetch ?? [])
  // If a cursor is present, resume from its model AND continue with
  // every model after it in the schema's declared order. Without the
  // suffix, once the cursor's model finishes paginating the server
  // would never serve subsequent models — every row of those models
  // would be silently lost from the client's perspective because
  // `hasMore` flips to false and `last_sync_hlc` jumps past their
  // HLCs on the next round trip.
  const allModels = Object.keys(schema)
  const modelOrder = request.cursor
    ? allModels.slice(allModels.indexOf(request.cursor.model))
    : allModels

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

  // Tombstones are a separate continuation phase after row pagination. They
  // cannot be truncated because advancing last_sync_hlc would lose deletes.
  if (!hasMore) {
    const page = await buildTombstonePage({ tx, request, ctx, schema, limit, hooks })
    tombstones = page.tombstones
    hasMore = page.hasMore
    cursor = page.cursor
  }

  return { changes, tombstones, hasMore, cursor }
}

async function buildTombstonePage<Ctx>({
  tx,
  request,
  ctx,
  schema,
  limit,
  hooks,
}: BuildServerResponseParams<Ctx>): Promise<{
  tombstones: Tombstone[]
  hasMore: boolean
  cursor: PaginationCursor | null
}> {
  const models = Object.entries(schema)
  const continuation = request.cursor?.model.startsWith(TOMBSTONE_CURSOR_PREFIX)
    ? request.cursor
    : null
  const continuationModel = continuation?.model.slice(TOMBSTONE_CURSOR_PREFIX.length)
  const start = continuationModel ? models.findIndex(([model]) => model === continuationModel) : 0
  if (start < 0) {
    throw new SchemaViolationError('Unknown tombstone pagination cursor model', undefined, 'cursor.model')
  }

  for (let index = start; index < models.length; index++) {
    const [modelKey, modelDef] = models[index]!
    let scope = modelDef.scope ? modelDef.scope(ctx) : undefined
    if (hooks?.beforeRead) {
      const extra = await hooks.beforeRead({ model: modelKey, ctx })
      if (extra) scope = { ...scope, ...extra }
    }
    const page = await tx.findTombstonesSince({
      model: modelKey,
      sinceHlc: request.since,
      limit,
      ...(continuation && index === start
        ? { cursor: { hlc: continuation.hlc, id: continuation.id } }
        : {}),
      ...(scope ? { scope } : {}),
    })
    if (page.tombstones.length === 0 && !page.nextCursor) continue

    const nextCursor = page.nextCursor
      ? { model: `${TOMBSTONE_CURSOR_PREFIX}${modelKey}`, hlc: page.nextCursor.hlc, id: page.nextCursor.id }
      : index + 1 < models.length
        ? { model: `${TOMBSTONE_CURSOR_PREFIX}${models[index + 1]![0]}`, hlc: HLC_ZERO, id: '' }
        : null
    return {
      tombstones: page.tombstones,
      hasMore: nextCursor !== null,
      cursor: nextCursor,
    }
  }

  return { tombstones: [], hasMore: false, cursor: null }
}

function filterOutput<Ctx>(rows: Row[], modelDef: SyncSchema<Ctx>[string]): Row[] {
  return rows.map((row) => {
    const filtered: Row = {}
    for (const [name, field] of Object.entries(modelDef.fields)) {
      if (field.output === false || field.sync === false) continue
      if (name in row) filtered[name] = row[name]
    }
    return filtered
  })
}
