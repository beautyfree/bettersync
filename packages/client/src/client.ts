/**
 * Local-first SyncClient (v0.1.1 — persisted pending queue + polling).
 *
 * Design:
 *  - Every local write goes to the adapter (local store) first, then to the
 *    adapter-backed `_sync_pending` table (persists across crash/restart).
 *  - Sync metadata (lastSyncHlc, nodeId) persisted in `_sync_meta` table.
 *  - `syncNow()` drains pending, round-trips with the server, applies response.
 *  - `start()` begins a polling loop with adaptive interval backoff.
 *  - `stop()` cancels the polling loop.
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
 * For tests, use a direct transport that calls server.handleSync() in-process.
 */
export type Transport = (request: SyncRequest) => Promise<SyncResponse>

/** A single pending operation stored in `_sync_pending` adapter table. */
export interface PendingOp {
  type: 'upsert' | 'delete'
  model: string
  row?: Row
  tombstone?: Tombstone
}

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
  /** Polling interval in milliseconds. Default 30000 (30s). */
  pollInterval?: number
  /** Maximum polling interval after backoff. Default 120000 (2 min). */
  maxPollInterval?: number
}

export interface SyncResult {
  pushed: number
  pulled: number
  tombstonesApplied: number
  hasMore: boolean
}

// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface SyncClient<Ctx = any> {
  readonly clock: HLClock
  readonly options: CreateSyncClientOptions<Ctx>
  readonly schema: SyncSchema<Ctx>

  /** Initialize adapter tables (including internal _sync_pending, _sync_meta). Start polling. */
  start(): Promise<void>
  /** Stop the polling loop. */
  stop(): void
  /** Manual sync trigger. */
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

// ─── Internal model schemas ─────────────────────────────────────────

const INTERNAL_SCHEMA_PENDING = {
  fields: {
    id: { type: 'string' as const, primaryKey: true },
    model: { type: 'string' as const },
    action: { type: 'string' as const },  // 'upsert' | 'delete'
    payload: { type: 'string' as const }, // JSON-serialized Row or Tombstone
    hlc: { type: 'string' as const },
    createdAt: { type: 'string' as const },
  },
}

const INTERNAL_SCHEMA_META = {
  fields: {
    key: { type: 'string' as const, primaryKey: true },
    value: { type: 'string' as const },
  },
}

// ─── Factory ────────────────────────────────────────────────────────

export function createSyncClient<Ctx>(
  options: CreateSyncClientOptions<Ctx>,
): SyncClient<Ctx> {
  const clock = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const limit = options.limit ?? 1000
  const pollInterval = options.pollInterval ?? 30_000
  const maxPollInterval = options.maxPollInterval ?? 120_000

  let started = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let currentPollInterval = pollInterval
  let syncing = false

  // Build extended schema with internal tables (avoids modifying user schema)
  const extendedSchema: SyncSchema = {
    ...options.schema,
    _sync_pending: INTERNAL_SCHEMA_PENDING,
    _sync_meta: INTERNAL_SCHEMA_META,
  }

  // ─── Meta helpers ───────────────────────────────────────────────

  async function getMeta(key: string): Promise<string | null> {
    const row = await options.database.findOne({
      model: '_sync_meta',
      where: { key },
    })
    return row ? String(row.value) : null
  }

  async function setMeta(key: string, value: string): Promise<void> {
    const existing = await options.database.findOne({
      model: '_sync_meta',
      where: { key },
    })
    if (existing) {
      await options.database.update({
        model: '_sync_meta',
        where: { key },
        update: { value },
      })
    } else {
      await options.database.create({
        model: '_sync_meta',
        data: { key, value },
      })
    }
  }

  // ─── Pending queue helpers ──────────────────────────────────────

  async function enqueuePending(op: PendingOp): Promise<void> {
    const payload =
      op.type === 'upsert'
        ? JSON.stringify(op.row)
        : JSON.stringify(op.tombstone)
    await options.database.create({
      model: '_sync_pending',
      data: {
        id: generateId(),
        model: op.model,
        action: op.type,
        payload,
        hlc: op.type === 'upsert' ? String(op.row?.[hlcField] ?? '') : (op.tombstone?.hlc ?? ''),
        createdAt: String(Date.now()),
      },
    })
  }

  async function drainPending(): Promise<
    Array<{ id: string; op: PendingOp }>
  > {
    const rows = await options.database.findMany({
      model: '_sync_pending',
      sortBy: { createdAt: 'asc' },
    })
    return rows.map((r) => {
      const parsed = JSON.parse(String(r.payload)) as Row | Tombstone
      const action = String(r.action) as 'upsert' | 'delete'
      const op: PendingOp =
        action === 'upsert'
          ? { type: 'upsert', model: String(r.model), row: parsed as Row }
          : {
              type: 'delete',
              model: String(r.model),
              tombstone: parsed as Tombstone,
            }
      return { id: String(r.id), op }
    })
  }

  async function clearPending(ids: string[]): Promise<void> {
    for (const id of ids) {
      await options.database.delete({
        model: '_sync_pending',
        where: { id },
      })
    }
  }

  // ─── Polling ────────────────────────────────────────────────────

  function scheduleNextPoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(pollTick, currentPollInterval)
  }

  async function pollTick(): Promise<void> {
    if (syncing) {
      scheduleNextPoll()
      return
    }
    try {
      const result = await client.syncNow()
      if (result.pushed > 0 || result.pulled > 0) {
        currentPollInterval = pollInterval
      } else {
        currentPollInterval = Math.min(
          currentPollInterval * 1.5,
          maxPollInterval,
        )
      }
    } catch {
      currentPollInterval = pollInterval
    }
    scheduleNextPoll()
  }

  // ─── Main logic ─────────────────────────────────────────────────

  function ensureStarted(): void {
    if (!started) {
      throw new Error('SyncClient: call start() before using any method')
    }
  }

  function getModelDef(modelKey: string) {
    const def = options.schema[modelKey]
    if (!def) {
      throw new Error(
        `SyncClient: unknown model "${modelKey}" (not in schema)`,
      )
    }
    return def
  }

  function scopeFromRow(row: Row, modelKey: string): Scope {
    const scope: Record<string, unknown> = {}
    const def = getModelDef(modelKey)
    for (const [name, field] of Object.entries(
      def.fields as Record<string, FieldDef>,
    )) {
      if (field.primaryKey) continue
      if (field.sync === false) continue
      const value = row[name]
      if (value === undefined) continue
      if (value !== null && typeof value !== 'object') {
        scope[name] = value
      }
    }
    return scope
  }

  // ─── Client instance ───────────────────────────────────────────

  const client: SyncClient<Ctx> = {
    clock,
    schema: options.schema,
    options,

    async start() {
      if (started) return
      await options.database.ensureSyncTables(extendedSchema)

      // Restore HLC state from meta
      const savedHlc = await getMeta('hlc_state')
      if (savedHlc) {
        try {
          clock.setState(savedHlc)
        } catch {
          // corrupted, start fresh
        }
      }

      started = true
      scheduleNextPoll()
    },

    stop() {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
    },

    async syncNow() {
      ensureStarted()
      if (syncing) {
        return { pushed: 0, pulled: 0, tombstonesApplied: 0, hasMore: false }
      }
      syncing = true
      try {
        return await doSync()
      } finally {
        syncing = false
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
              `insert on "${modelKey}": row ${String(row[pkField])} exists with newer HLC`,
            )
          }
          await enqueuePending({ type: 'upsert', model: modelKey, row: { ...row } })
          await setMeta('hlc_state', clock.current())
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
          await enqueuePending({ type: 'upsert', model: modelKey, row: { ...row } })
          await setMeta('hlc_state', clock.current())
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
          const tombstone: Tombstone = { model: modelKey, id, hlc, scope }
          await options.database.upsertTombstoneIfNewer(tombstone)
          await enqueuePending({ type: 'delete', model: modelKey, tombstone })
          await setMeta('hlc_state', clock.current())
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

  // ─── Sync round-trip ──────────────────────────────────────────

  async function doSync(): Promise<SyncResult> {
    const lastSyncHlc = (await getMeta('last_sync_hlc')) ?? HLC_ZERO
    const pendingRows = await drainPending()

    const changes: ChangeSet = {}
    const tombstones: Tombstone[] = []
    for (const { op } of pendingRows) {
      if (op.type === 'upsert' && op.row) {
        let list = changes[op.model]
        if (!list) {
          list = []
          changes[op.model] = list
        }
        list.push(op.row)
      } else if (op.type === 'delete' && op.tombstone) {
        tombstones.push(op.tombstone)
      }
    }

    const request: SyncRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientTime: clock.tick(),
      since: lastSyncHlc,
      limit,
      ...(Object.keys(changes).length > 0 ? { changes } : {}),
      ...(tombstones.length > 0 ? { tombstones } : {}),
    }

    const response = await options.transport(request)

    clock.receive(response.serverTime)

    let pulled = 0
    let tombstonesApplied = 0
    await options.database.transaction(async (tx) => {
      for (const [modelKey, rows] of Object.entries(response.changes)) {
        for (const row of rows) {
          const outcome = await tx.upsertIfNewer({ model: modelKey, row })
          if (outcome !== 'skipped') pulled += 1
        }
      }
      for (const tombstone of response.tombstones) {
        const applied = await tx.upsertTombstoneIfNewer(tombstone)
        if (applied) tombstonesApplied += 1
      }
    })

    // Clear acknowledged pending ops
    await clearPending(pendingRows.map((p) => p.id))

    // Persist sync state
    await setMeta('last_sync_hlc', response.serverTime)
    await setMeta('hlc_state', clock.current())

    return {
      pushed: pendingRows.length,
      pulled,
      tombstonesApplied,
      hasMore: response.hasMore,
    }
  }

  return client
}

// ─── Helpers ────────────────────────────────────────────────────────

let idCounter = 0
function generateId(): string {
  return `_sp_${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`
}
