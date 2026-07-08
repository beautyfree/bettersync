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
} from '@bettersync/core'

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
  /** Full transport function, OR a URL string for HTTP sync. */
  transport?: Transport
  /** Shorthand: sync endpoint URL. Creates an HTTP transport automatically. */
  syncUrl?: string
  /** Headers to include with every sync HTTP request (e.g. Authorization). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
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
  /**
   * Automatically attempt a sync after every local write when network sync
   * is enabled. Defaults to true. Writes still resolve after the local DB
   * commit unless caller passes `{ sync: 'remote' }`.
   */
  syncOnWrite?: boolean
  /** Debounce window for syncOnWrite. Default 250ms. */
  syncOnWriteDebounceMs?: number
  /**
   * Run in local-only mode: skip network sync entirely.
   * Local writes still go to the adapter and queue in `_sync_pending`,
   * but `syncNow`/polling is a no-op until `enableSync()` is called.
   * Defaults to `true` if neither `transport` nor `syncUrl` is provided.
   */
  localOnly?: boolean
}

/** Options passed to `enableSync()` to flip a local-only client into sync mode. */
export interface EnableSyncOptions {
  transport?: Transport
  syncUrl?: string
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
}

export interface SyncResult {
  pushed: number
  pulled: number
  tombstonesApplied: number
  hasMore: boolean
  /** True if server flagged this client as stale. Call recover(). */
  staleClient: boolean
}

export interface SyncNowOptions {
  /** Continue calling sync until server returns hasMore=false. */
  drain?: boolean
}

export interface WriteOptions {
  /**
   * `local` (default): return after local durable write, then background sync.
   * `remote`: return only after server accepted current pending queue.
   */
  sync?: 'local' | 'remote'
}

export interface SyncStatus {
  isStarted: boolean
  isSyncing: boolean
  isLocalOnly: boolean
  pendingCount: number
  lastSyncedAt: number | null
  lastError: Error | null
  currentHlc: string
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
  /** Manual sync trigger. No-op (returns zeros) when client is in local-only mode. */
  syncNow(options?: SyncNowOptions): Promise<SyncResult>
  /**
   * Switch a local-only client into sync mode. Installs the given transport
   * (or builds one from `syncUrl`), starts the polling loop, and immediately
   * triggers a syncNow() to drain any accumulated pending writes.
   *
   * Safe to call multiple times — later calls replace the transport (useful
   * for swapping auth headers). Calling on an already-syncing client just
   * updates transport and runs syncNow.
   */
  enableSync(options: EnableSyncOptions): Promise<SyncResult>
  /** True when client is local-only (no network sync). */
  readonly isLocalOnly: () => boolean
  /** Current sync status snapshot for UI/devtools/debugging. */
  status(): Promise<SyncStatus>
  /**
   * Recover from stale client state. Call when syncNow returns staleClient.
   * Pushes any remaining pending writes, wipes local synced data, and
   * does a full refetch from the server (since = 0).
   */
  recover(): Promise<SyncResult>
  /** Access a model's local-first CRUD API. */
  model<M extends string>(model: M): ModelAccessor
  /** Subscribe to change events. Returns unsubscribe function. */
  on(event: 'change', listener: ChangeListener): () => void
  on(event: 'sync', listener: SyncListener): () => void
  on(event: 'error', listener: ErrorListener): () => void
}

export type ChangeEvent = { model: string; ids: string[] }
export type SyncEvent = { pushed: number; pulled: number }
export type ChangeListener = (event: ChangeEvent) => void
export type SyncListener = (event: SyncEvent) => void
export type ErrorListener = (error: Error) => void

export interface ModelAccessor {
  insert(data: Row, options?: WriteOptions): Promise<Row>
  update(id: string, patch: Partial<Row>, options?: WriteOptions): Promise<Row>
  delete(id: string, options?: WriteOptions): Promise<void>
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
  // Resolve transport. If neither `transport` nor `syncUrl` is provided,
  // the client starts in local-only mode (no network round-trips). Callers
  // can later flip it on via `client.enableSync({ transport | syncUrl })`.
  let currentTransport: Transport | null = options.transport
    ?? (options.syncUrl ? createHttpTransport(options.syncUrl, options.headers) : null)
  let localOnly: boolean = options.localOnly ?? currentTransport === null

  const clock = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const limit = options.limit ?? 1000
  const pollInterval = options.pollInterval ?? 30_000
  const maxPollInterval = options.maxPollInterval ?? 120_000
  const syncOnWrite = options.syncOnWrite ?? true
  const syncOnWriteDebounceMs = options.syncOnWriteDebounceMs ?? 250

  let started = false
  let startPromise: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let writeSyncTimer: ReturnType<typeof setTimeout> | undefined
  let currentPollInterval = pollInterval
  let syncing = false
  let syncPromise: Promise<SyncResult> | null = null
  let lastSyncedAt: number | null = null
  let lastError: Error | null = null

  // ─── Event emitter ──────────────────────────────────────────────
  const listeners = {
    change: new Set<ChangeListener>(),
    sync: new Set<SyncListener>(),
    error: new Set<ErrorListener>(),
  }

  function emitChange(model: string, ids: string[]): void {
    for (const fn of listeners.change) {
      try { fn({ model, ids }) } catch { /* listener errors don't propagate */ }
    }
  }

  function emitSync(pushed: number, pulled: number): void {
    for (const fn of listeners.sync) {
      try { fn({ pushed, pulled }) } catch { /* */ }
    }
  }

  function emitError(error: Error): void {
    for (const fn of listeners.error) {
      try { fn(error) } catch { /* */ }
    }
  }

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
    if (localOnly || !currentTransport) return // no network: stay quiet
    pollTimer = setTimeout(pollTick, currentPollInterval)
    unrefTimer(pollTimer)
  }

  function scheduleWriteSync(): void {
    if (!syncOnWrite || localOnly || !currentTransport) return
    if (writeSyncTimer) clearTimeout(writeSyncTimer)
    writeSyncTimer = setTimeout(() => {
      writeSyncTimer = undefined
      void client.syncNow({ drain: true }).catch((err: unknown) => {
        lastError = err instanceof Error ? err : new Error(String(err))
        emitError(lastError)
      })
    }, syncOnWriteDebounceMs)
    unrefTimer(writeSyncTimer)
  }

  async function syncAfterWrite(options?: WriteOptions): Promise<void> {
    if (options?.sync === 'remote') {
      if (localOnly || !currentTransport) return
      if (writeSyncTimer) {
        clearTimeout(writeSyncTimer)
        writeSyncTimer = undefined
      }
      await client.syncNow({ drain: true })
      return
    }
    scheduleWriteSync()
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
    } catch (err) {
      currentPollInterval = pollInterval
      lastError = err instanceof Error ? err : new Error(String(err))
      emitError(lastError)
    }
    scheduleNextPoll()
  }

  // ─── Main logic ─────────────────────────────────────────────────

  /**
   * Initialize on first use. Safe to call concurrently — only the first
   * invocation runs ensureSyncTables / restores HLC / starts polling;
   * later callers just await the same promise.
   */
  async function initIfNeeded(): Promise<void> {
    if (started) return
    if (!startPromise) {
      startPromise = (async () => {
        await options.database.ensureSyncTables(extendedSchema)
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
      })()
    }
    await startPromise
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
      await initIfNeeded()
    },

    stop() {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
      if (writeSyncTimer) {
        clearTimeout(writeSyncTimer)
        writeSyncTimer = undefined
      }
    },

    async syncNow(syncOptions: SyncNowOptions = {}) {
      await initIfNeeded()
      if (localOnly || !currentTransport) {
        // local-only: writes still queue in `_sync_pending`, but no round-trip.
        return { pushed: 0, pulled: 0, tombstonesApplied: 0, hasMore: false, staleClient: false }
      }
      if (syncing && syncPromise) {
        const inFlight = syncPromise
        if (!syncOptions.drain) return inFlight
        return inFlight.then(async (result) => {
          if (!result.hasMore) return result
          const rest = await client.syncNow({ drain: true })
          return mergeSyncResults(result, rest)
        })
      }
      syncing = true
      syncPromise = doSyncMaybeDrain(syncOptions)
        .catch((err: unknown) => {
          lastError = err instanceof Error ? err : new Error(String(err))
          emitError(lastError)
          throw err
        })
        .finally(() => {
          syncing = false
          syncPromise = null
        })
      return syncPromise
    },

    async enableSync(opts: EnableSyncOptions) {
      const newTransport: Transport | null = opts.transport
        ?? (opts.syncUrl ? createHttpTransport(opts.syncUrl, opts.headers) : null)
      if (!newTransport) {
        throw new Error('enableSync: provide either `transport` or `syncUrl`')
      }
      currentTransport = newTransport
      localOnly = false
      await initIfNeeded()
      // Reset backoff so the next poll runs at the base interval.
      currentPollInterval = pollInterval
      scheduleNextPoll()
      // Immediate round-trip to flush accumulated pending writes.
      return client.syncNow({ drain: true })
    },

    isLocalOnly: () => localOnly,

    async status() {
      await initIfNeeded()
      return {
        isStarted: started,
        isSyncing: syncing,
        isLocalOnly: localOnly,
        pendingCount: (await drainPending()).length,
        lastSyncedAt,
        lastError,
        currentHlc: clock.current(),
      }
    },

    async recover() {
      await initIfNeeded()
      if (localOnly || !currentTransport) {
        throw new Error('recover() requires sync to be enabled; call enableSync() first')
      }
      syncing = true
      try {
        // Step 1: push any remaining pending writes (server still accepts them)
        await doSync()

        // Step 2: wipe local synced data (keep internal tables)
        for (const modelKey of Object.keys(options.schema)) {
          // Delete all rows in this model's local table
          const rows = await options.database.findMany({ model: modelKey })
          for (const row of rows) {
            const pkField = getPrimaryKey(modelKey, getModelDef(modelKey))
            await options.database.delete({ model: modelKey, where: { [pkField]: row[pkField] } })
          }
        }

        // Step 3: reset sync marker to zero (full refetch)
        await setMeta('last_sync_hlc', HLC_ZERO)

        // Step 4: full sync from zero
        return await doSync()
      } finally {
        syncing = false
      }
    },

    on(event: 'change' | 'sync' | 'error', listener: ChangeListener | SyncListener | ErrorListener) {
      const set = listeners[event] as Set<typeof listener>
      set.add(listener)
      return () => { set.delete(listener) }
    },

    model(modelKey) {
      const modelDef = getModelDef(modelKey)
      const pkField = getPrimaryKey(modelKey, modelDef)

      const accessor: ModelAccessor = {
        async insert(data, writeOptions) {
          await initIfNeeded()
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
          emitChange(modelKey, [String(row[pkField])])
          await syncAfterWrite(writeOptions)
          return { ...row }
        },

        async update(id, patch, writeOptions) {
          await initIfNeeded()
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
          emitChange(modelKey, [id])
          await syncAfterWrite(writeOptions)
          return { ...row }
        },

        async delete(id, writeOptions) {
          await initIfNeeded()
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
          emitChange(modelKey, [id])
          await syncAfterWrite(writeOptions)
        },

        async findOne(where) {
          await initIfNeeded()
          return options.database.findOne({ model: modelKey, where })
        },

        async findMany(where) {
          await initIfNeeded()
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

  async function doSyncMaybeDrain(syncOptions: SyncNowOptions): Promise<SyncResult> {
    const first = await doSync()
    if (!syncOptions.drain || !first.hasMore) return first

    const total: SyncResult = { ...first }
    let guard = 0
    while (total.hasMore) {
      if (++guard >= 50) break
      const next = await doSync()
      total.pushed += next.pushed
      total.pulled += next.pulled
      total.tombstonesApplied += next.tombstonesApplied
      total.hasMore = next.hasMore
      total.staleClient = total.staleClient || next.staleClient
    }
    return total
  }

  async function doSync(): Promise<SyncResult> {
    const lastSyncHlc = (await getMeta('last_sync_hlc')) ?? HLC_ZERO
    const pendingCursorRaw = await getMeta('pending_cursor')
    const pendingCursor =
      pendingCursorRaw && pendingCursorRaw.length > 0
        ? (JSON.parse(pendingCursorRaw) as { model: string; hlc: string; id: string })
        : null
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
      ...(pendingCursor ? { cursor: pendingCursor } : {}),
      ...(Object.keys(changes).length > 0 ? { changes } : {}),
      ...(tombstones.length > 0 ? { tombstones } : {}),
    }

    if (!currentTransport) {
      throw new Error('doSync called without a transport — this is a bug')
    }
    const response = await currentTransport(request)

    clock.receive(response.serverTime)

    let pulled = 0
    let tombstonesApplied = 0
    const changedModels = new Map<string, string[]>() // model → ids

    await options.database.transaction(async (tx) => {
      for (const [modelKey, rows] of Object.entries(response.changes)) {
        for (const row of rows) {
          const outcome = await tx.upsertIfNewer({ model: modelKey, row })
          if (outcome !== 'skipped') {
            pulled += 1
            const ids = changedModels.get(modelKey) ?? []
            ids.push(String(row.id ?? ''))
            changedModels.set(modelKey, ids)
          }
        }
      }
      for (const tombstone of response.tombstones) {
        const applied = await tx.upsertTombstoneIfNewer(tombstone)
        if (applied) {
          const modelDef = getModelDef(tombstone.model)
          const pkField = getPrimaryKey(tombstone.model, modelDef)
          await tx.delete({
            model: tombstone.model,
            where: { [pkField]: tombstone.id },
          })
          tombstonesApplied += 1
          const ids = changedModels.get(tombstone.model) ?? []
          ids.push(tombstone.id)
          changedModels.set(tombstone.model, ids)
        }
      }
    })

    // Clear acknowledged pending ops
    await clearPending(pendingRows.map((p) => p.id))

    // Persist sync state. While the server still has more pages
    // (hasMore + cursor), keep `last_sync_hlc` pointing at the prior
    // checkpoint and stash the continuation cursor so the next
    // syncNow picks up from the same model offset. Only once the
    // server reports a fully drained pull do we advance
    // `last_sync_hlc` to the new serverTime.
    if (response.hasMore && response.cursor) {
      await setMeta('pending_cursor', JSON.stringify(response.cursor))
    } else {
      await setMeta('pending_cursor', '')
      await setMeta('last_sync_hlc', response.serverTime)
    }
    await setMeta('hlc_state', clock.current())
    lastSyncedAt = Date.now()
    lastError = null

    // Emit events
    for (const [model, ids] of changedModels) {
      emitChange(model, ids)
    }
    emitSync(pendingRows.length, pulled)

    return {
      pushed: pendingRows.length,
      pulled,
      tombstonesApplied,
      hasMore: response.hasMore,
      staleClient: response.staleClient ?? false,
    }
  }

  return client
}

// ─── Helpers ────────────────────────────────────────────────────────

let idCounter = 0
function generateId(): string {
  return `_sp_${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`
}

function mergeSyncResults(a: SyncResult, b: SyncResult): SyncResult {
  return {
    pushed: a.pushed + b.pushed,
    pulled: a.pulled + b.pulled,
    tombstonesApplied: a.tombstonesApplied + b.tombstonesApplied,
    hasMore: b.hasMore,
    staleClient: a.staleClient || b.staleClient,
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void }
  maybe.unref?.()
}

/**
 * Create an HTTP transport from a URL string.
 * Used when the user passes `syncUrl` instead of a custom `transport`.
 */
function createHttpTransport(
  url: string,
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>),
): Transport {
  return async (request) => {
    const resolvedHeaders = typeof headers === 'function' ? await headers() : (headers ?? {})
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...resolvedHeaders },
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg = (body as Record<string, unknown>)?.error
        ? JSON.stringify((body as Record<string, unknown>).error)
        : `Sync failed: ${res.status}`
      throw new Error(msg)
    }
    return res.json() as Promise<SyncResponse>
  }
}
