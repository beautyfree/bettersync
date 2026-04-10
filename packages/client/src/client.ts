/**
 * Local-first SyncClient.
 *
 * Design:
 *  - Every local write goes to the adapter (local store) first, then to the
 *    in-memory pending queue.
 *  - `syncNow()` drains the pending queue, POSTs to the server, merges the
 *    response into the local store, and clears the pending queue.
 *  - The HLC clock is ticked on every local write and merged with the
 *    server's `serverTime` on every successful sync.
 */

import {
  type ChangeSet,
  type FieldDef,
  getPrimaryKey,
  HLClock,
  type HLClockOptions,
  HLC_ZERO,
  PROTOCOL_VERSION,
  type Row,
  type Scope,
  type SyncAdapter,
  type SyncRequest,
  type SyncResponse,
  type SyncSchema,
  type Tombstone,
  type Where,
} from '@better-sync/core'

/**
 * Transport function — takes a SyncRequest, returns a SyncResponse.
 *
 * The HTTP transport wraps `fetch`. For tests, use a direct transport that
 * calls `server.handleSync(req, ctx)` in-process without going over HTTP.
 */
export type Transport = (request: SyncRequest) => Promise<SyncResponse>

/** A single pending operation waiting to be flushed to the server. */
export type PendingOp =
  | { type: 'upsert'; model: string; row: Row }
  | { type: 'delete'; tombstone: Tombstone }

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface CreateSyncClientOptions<Ctx = any> {
  database: SyncAdapter
  schema: SyncSchema<Ctx>
  transport: Transport
  /** Field on each row that stores the HLC. Default `'changed'`. */
  hlcField?: string
  /** HLC clock options (node id, custom clock). */
  clock?: HLClockOptions
  /** Max page size per sync request. Default 1000. */
  limit?: number
}

export interface SyncResult {
  /** Number of local writes pushed to the server. */
  pushed: number
  /** Number of remote changes merged into the local store. */
  pulled: number
  /** Number of tombstones applied from the server. */
  tombstonesApplied: number
  /** True if another `syncNow()` is needed to drain pagination. */
  hasMore: boolean
}

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface SyncClient<Ctx = any> {
  readonly clock: HLClock
  readonly options: CreateSyncClientOptions<Ctx>
  readonly schema: SyncSchema<Ctx>

  /** Initialize the adapter's sync tables. Must be called once before any writes. */
  start(): Promise<void>

  /** Drain the pending queue, round-trip with the server, and apply response. */
  syncNow(): Promise<SyncResult>

  /** Access a model's local-first CRUD API. */
  model<M extends string>(model: M): ModelAccessor
}

export interface ModelAccessor {
  insert(data: Row): Promise<Row>
  update(id: string, patch: Partial<Row>): Promise<Row>
  delete(id: string): Promise<void>
  findOne(where: Where): Promise<Row | null>
  findMany(where?: Where): Promise<Row[]>
}

/** Create a fresh sync client. */
export function createSyncClient<Ctx>(
  options: CreateSyncClientOptions<Ctx>,
): SyncClient<Ctx> {
  const clock = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const limit = options.limit ?? 1000

  // In-memory state (v0.1). Persistence comes in v0.2.
  let lastSyncHlc: string = HLC_ZERO
  const pending: PendingOp[] = []
  let started = false

  function ensureStarted(): void {
    if (!started) {
      throw new Error('SyncClient: call start() before using any method')
    }
  }

  function getModelDef(model: string) {
    const def = options.schema[model]
    if (!def) {
      throw new Error(`SyncClient: unknown model "${model}" (not in schema)`)
    }
    return def
  }

  function scopeFromRow(row: Row, model: string): Scope {
    // Extract the scope columns from a row based on the model's scope shape.
    // We don't actually call modelDef.scope(ctx) here because the client
    // doesn't have a user-auth context — the row itself carries scope
    // columns (e.g. userId) at write time.
    const scope: Record<string, unknown> = {}
    const def = getModelDef(model)
    // Use field names that typically appear in scope: "userId", "tenantId", etc.
    // Heuristic: any field that's a foreign key reference OR is present on
    // all rows is considered scope-bearing. For v0.1 simplicity, we snapshot
    // the non-sync-meta primitives from the row.
    for (const [name, field] of Object.entries(def.fields as Record<string, FieldDef>)) {
      if (field.primaryKey) continue
      if (field.sync === false) continue
      if (row[name] === undefined) continue
      // Scope columns are usually string or number. Skip complex values.
      const value = row[name]
      if (value !== null && typeof value !== 'object') {
        scope[name] = value
      }
    }
    return scope
  }

  const client: SyncClient<Ctx> = {
    clock,
    schema: options.schema,
    options,

    async start() {
      if (started) return
      await options.database.ensureSyncTables(options.schema)
      started = true
    },

    async syncNow() {
      ensureStarted()

      // ─── Drain pending queue into a SyncRequest ───────────────
      const pushedChanges: ChangeSet = {}
      const pushedTombstones: Tombstone[] = []
      for (const op of pending) {
        if (op.type === 'upsert') {
          let list = pushedChanges[op.model]
          if (!list) {
            list = []
            pushedChanges[op.model] = list
          }
          list.push(op.row)
        } else {
          pushedTombstones.push(op.tombstone)
        }
      }

      const request: SyncRequest = {
        protocolVersion: PROTOCOL_VERSION,
        clientTime: clock.tick(),
        since: lastSyncHlc,
        limit,
        ...(Object.keys(pushedChanges).length > 0 ? { changes: pushedChanges } : {}),
        ...(pushedTombstones.length > 0 ? { tombstones: pushedTombstones } : {}),
      }

      // ─── Send to server ─────────────────────────────────────
      const response = await options.transport(request)

      // ─── Merge server time into HLC clock ───────────────────
      clock.receive(response.serverTime)

      // ─── Apply server changes into local store ──────────────
      let pulled = 0
      let tombstonesApplied = 0
      await options.database.transaction(async (tx) => {
        for (const [model, rows] of Object.entries(response.changes)) {
          for (const row of rows) {
            const outcome = await tx.upsertIfNewer({ model, row })
            if (outcome !== 'skipped') pulled += 1
          }
        }
        for (const tombstone of response.tombstones) {
          const applied = await tx.upsertTombstoneIfNewer(tombstone)
          if (applied) tombstonesApplied += 1
        }
      })

      // ─── Clear pending — accepted by server (atomically in req) ──
      const pushedCount = pending.length
      pending.length = 0

      // ─── Advance last-sync marker ───────────────────────────
      lastSyncHlc = response.serverTime

      return {
        pushed: pushedCount,
        pulled,
        tombstonesApplied,
        hasMore: response.hasMore,
      }
    },

    model(modelKey) {
      ensureStarted()
      const modelDef = getModelDef(modelKey)
      const pkField = getPrimaryKey(modelKey, modelDef)

      const accessor: ModelAccessor = {
        async insert(data) {
          ensureStarted()
          const hlc = clock.tick()
          const row: Row = { ...data, [hlcField]: hlc }
          const result = await options.database.upsertIfNewer({
            model: modelKey,
            row,
          })
          if (result === 'skipped') {
            throw new Error(
              `insert on "${modelKey}": row ${String(
                row[pkField],
              )} already exists with a newer HLC. Use update() instead.`,
            )
          }
          pending.push({ type: 'upsert', model: modelKey, row: { ...row } })
          return { ...row }
        },

        async update(id, patch) {
          ensureStarted()
          const existing = await options.database.findOne({
            model: modelKey,
            where: { [pkField]: id },
          })
          if (!existing) {
            throw new Error(`update on "${modelKey}": row ${id} not found`)
          }
          const hlc = clock.tick()
          const row: Row = { ...existing, ...patch, [hlcField]: hlc }
          await options.database.upsertIfNewer({ model: modelKey, row })
          pending.push({ type: 'upsert', model: modelKey, row: { ...row } })
          return { ...row }
        },

        async delete(id) {
          ensureStarted()
          const existing = await options.database.findOne({
            model: modelKey,
            where: { [pkField]: id },
          })
          const hlc = clock.tick()
          const scope = existing ? scopeFromRow(existing, modelKey) : {}
          await options.database.delete({
            model: modelKey,
            where: { [pkField]: id },
          })
          const tombstone: Tombstone = {
            model: modelKey,
            id,
            hlc,
            scope,
          }
          await options.database.upsertTombstoneIfNewer(tombstone)
          pending.push({ type: 'delete', tombstone })
        },

        findOne(where) {
          ensureStarted()
          return options.database.findOne({ model: modelKey, where })
        },

        findMany(where) {
          ensureStarted()
          return options.database.findMany({
            model: modelKey,
            ...(where ? { where } : {}),
          })
        },
      }
      return accessor
    },
  }

  return client
}
