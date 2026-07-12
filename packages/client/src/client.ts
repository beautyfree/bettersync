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
  type ClientChangeSet,
  type DeleteOperation,
  type FieldDef,
  getPrimaryKey,
  HLClock,
  type HLClockOptions,
  HLC_ZERO,
  parseSyncResponse,
  PROTOCOL_VERSION,
  type Row,
  type Scope,
  type SyncRealtimeEvent,
  type SyncAdapter,
  type SyncRequest,
  type SyncResponse,
  type SyncSchema,
  type Tombstone,
  validateSchema,
  type Where,
} from '@bettersync/core'

/**
 * Transport function — takes a SyncRequest, returns a SyncResponse.
 * For tests, use a direct transport that calls server.handleSync() in-process.
 */
export type Transport = (request: SyncRequest) => Promise<SyncResponse>

export type RealtimeUnsubscribe = () => void | Promise<void>

export interface RealtimeHandlers {
  onEvent: (event: SyncRealtimeEvent) => void
  onError: (error: Error) => void
}

export type RealtimeSubscribe =
  (handlers: RealtimeHandlers) => RealtimeUnsubscribe | Promise<RealtimeUnsubscribe | void> | void

export interface RealtimeTransport {
  subscribe: RealtimeSubscribe
}

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
  /**
   * Optional realtime invalidation channel. It should emit "wake up"
   * events only; client then pulls scoped data via syncNow().
   *
   * Polling stays enabled as fallback.
   */
  realtime?: RealtimeSubscribe | RealtimeTransport
  /** Shorthand: sync endpoint URL. Creates an HTTP transport automatically. */
  syncUrl?: string
  /** Shorthand: SSE endpoint URL. Creates a realtime transport if EventSource exists. */
  eventsUrl?: string
  /** Headers to include with every sync HTTP request (e.g. Authorization). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** Abort an HTTP sync request after this many milliseconds. Default: 15 seconds. */
  syncRequestTimeoutMs?: number
  /** Field on each row that stores the HLC. Default `'changed'`. */
  hlcField?: string
  /** HLC clock options (node id, custom clock). */
  clock?: HLClockOptions
  /** Max page size per sync request. Default 1000. */
  limit?: number
  /** Max local operations sent per request. Default 250. */
  maxPushBatchSize?: number
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
  /** Debounce window for realtime invalidation pulls. Default 50ms. */
  realtimeDebounceMs?: number
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
  realtime?: RealtimeSubscribe | RealtimeTransport
  syncUrl?: string
  eventsUrl?: string
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** Abort an HTTP sync request after this many milliseconds. Default: 15 seconds. */
  syncRequestTimeoutMs?: number
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
  /**
   * Stop all network activity and keep local rows plus the persisted outbox.
   * A later `enableSync()` resumes and drains the same pending changes.
   */
  disableSync(): void
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
  validateSchema(options.schema)
  // Resolve transport. If neither `transport` nor `syncUrl` is provided,
  // the client starts in local-only mode (no network round-trips). Callers
  // can later flip it on via `client.enableSync({ transport | syncUrl })`.
  let currentTransport: Transport | null = options.transport
    ?? (options.syncUrl ? createHttpTransport(options.syncUrl, options.headers, options.syncRequestTimeoutMs) : null)
  let currentRealtime: RealtimeSubscribe | null = normalizeRealtime(
    options.realtime ?? (options.eventsUrl ? createEventSourceRealtime(options.eventsUrl, options.headers) : undefined),
  )
  let localOnly: boolean = options.localOnly ?? currentTransport === null

  const clock = new HLClock(options.clock ?? {})
  const hlcField = options.hlcField ?? 'changed'
  const limit = options.limit ?? 1000
  const maxPushBatchSize = options.maxPushBatchSize ?? 250
  if (!Number.isInteger(maxPushBatchSize) || maxPushBatchSize <= 0) {
    throw new Error('SyncClient: maxPushBatchSize must be a positive integer')
  }
  const pollInterval = options.pollInterval ?? 30_000
  const maxPollInterval = options.maxPollInterval ?? 120_000
  const syncOnWrite = options.syncOnWrite ?? true
  const syncOnWriteDebounceMs = options.syncOnWriteDebounceMs ?? 250
  const realtimeDebounceMs = options.realtimeDebounceMs ?? 50

  let started = false
  let startPromise: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let writeSyncTimer: ReturnType<typeof setTimeout> | undefined
  let realtimeSyncTimer: ReturnType<typeof setTimeout> | undefined
  let realtimeUnsubscribe: RealtimeUnsubscribe | null = null
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

  async function getMeta(key: string, database: SyncAdapter = options.database): Promise<string | null> {
    const row = await database.findOne({
      model: '_sync_meta',
      where: { key },
    })
    return row ? String(row.value) : null
  }

  async function setMeta(key: string, value: string, database: SyncAdapter = options.database): Promise<void> {
    const existing = await database.findOne({
      model: '_sync_meta',
      where: { key },
    })
    if (existing) {
      await database.update({
        model: '_sync_meta',
        where: { key },
        update: { value },
      })
    } else {
      await database.create({
        model: '_sync_meta',
        data: { key, value },
      })
    }
  }

  // ─── Pending queue helpers ──────────────────────────────────────

  async function enqueuePending(database: SyncAdapter, id: string, op: PendingOp): Promise<void> {
    const payload =
      op.type === 'upsert'
        ? JSON.stringify(op.row)
        : JSON.stringify(op.tombstone)
    await database.create({
      model: '_sync_pending',
      data: {
        id,
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

  async function clearPending(database: SyncAdapter, ids: string[]): Promise<void> {
    for (const id of ids) {
      await database.delete({
        model: '_sync_pending',
        where: { id },
      })
    }
  }

  async function migrateLocalRows(): Promise<void> {
    await options.database.transaction(async (tx) => {
      for (const [modelKey, def] of Object.entries(options.schema)) {
        const targetVersion = def.version ?? 0
        const metaKey = `schema_version:${modelKey}`
        const rawVersion = await getMeta(metaKey, tx)
        const currentVersion = rawVersion === null ? 0 : Number(rawVersion)
        if (!Number.isInteger(currentVersion) || currentVersion < 0) {
          throw new Error(`SyncClient: invalid stored schema version for "${modelKey}"`)
        }
        if (currentVersion > targetVersion) {
          throw new Error(
            `SyncClient: local schema for "${modelKey}" is version ${currentVersion}, newer than configured ${targetVersion}`,
          )
        }
        if (currentVersion === targetVersion) continue

        const migrate = (row: Row): Row => {
          let next = { ...row }
          for (let version = currentVersion + 1; version <= targetVersion; version++) {
            const step = def.migrations?.[version]
            if (step) next = step(next)
          }
          return next
        }
        const pkField = getPrimaryKey(modelKey, def)
        for (const row of await tx.findMany({ model: modelKey })) {
          const migrated = migrate(row)
          const patch = { ...migrated }
          delete patch[pkField]
          await tx.update({ model: modelKey, where: { [pkField]: row[pkField] }, update: patch })
        }

        // Pending writes are part of the same local data set. Rewriting them
        // transactionally prevents an old payload from undoing a migration on
        // the first post-upgrade sync.
        for (const pending of await tx.findMany({ model: '_sync_pending' })) {
          if (pending.model !== modelKey || pending.action !== 'upsert') continue
          const row = JSON.parse(String(pending.payload)) as Row
          await tx.update({
            model: '_sync_pending',
            where: { id: pending.id },
            update: { payload: JSON.stringify(migrate(row)) },
          })
        }
        await setMeta(metaKey, String(targetVersion), tx)
      }
    })
  }

  function rowForSync(modelKey: string, row: Row): Row {
    const def = getModelDef(modelKey)
    const result: Row = {}
    for (const [fieldName, field] of Object.entries(def.fields as Record<string, FieldDef>)) {
      if (field.sync === false || field.input === false) continue
      if (fieldName in row) result[fieldName] = row[fieldName]
    }
    // The HLC may be implicit in older schemas but is required on the wire.
    result[hlcField] = row[hlcField]
    return result
  }

  function mergeRemoteRow(modelKey: string, existing: Row | null, incoming: Row): Row {
    if (!existing) return incoming
    const def = getModelDef(modelKey)
    const result = { ...incoming }
    for (const [fieldName, field] of Object.entries(def.fields as Record<string, FieldDef>)) {
      if (field.sync === false && fieldName in existing) result[fieldName] = existing[fieldName]
    }
    return result
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

  function scheduleRealtimeSync(): void {
    if (localOnly || !currentTransport) return
    if (realtimeSyncTimer) clearTimeout(realtimeSyncTimer)
    realtimeSyncTimer = setTimeout(() => {
      realtimeSyncTimer = undefined
      void client.syncNow({ drain: true }).catch((err: unknown) => {
        lastError = err instanceof Error ? err : new Error(String(err))
        emitError(lastError)
      })
    }, realtimeDebounceMs)
    unrefTimer(realtimeSyncTimer)
  }

  async function installRealtime(): Promise<void> {
    if (localOnly || !currentRealtime || realtimeUnsubscribe) return
    try {
      const unsubscribe = await currentRealtime({
        onEvent: () => scheduleRealtimeSync(),
        onError: (error) => {
          lastError = error
          emitError(error)
        },
      })
      realtimeUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      emitError(lastError)
    }
  }

  async function uninstallRealtime(): Promise<void> {
    const unsubscribe = realtimeUnsubscribe
    realtimeUnsubscribe = null
    if (!unsubscribe) return
    try {
      await unsubscribe()
    } catch {
      // ignore shutdown errors
    }
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
        await migrateLocalRows()
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
        await installRealtime()
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
    if (def.scope && !def.tombstoneScope) {
      throw new Error(
        `delete on "${modelKey}" requires model.tombstoneScope for scoped sync`,
      )
    }
    for (const name of def.tombstoneScope ?? []) {
      const field = (def.fields as Record<string, FieldDef>)[name]
      if (!field || field.sync === false) continue
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
      if (realtimeSyncTimer) {
        clearTimeout(realtimeSyncTimer)
        realtimeSyncTimer = undefined
      }
      // `start()` must be able to install timers and realtime again after a
      // foreground/background lifecycle stop.
      started = false
      startPromise = null
      void uninstallRealtime()
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
      const run = (async () => {
        try {
          const result = await doSyncMaybeDrain(syncOptions)
          // Listeners commonly read status to update UI. Publish the successful
          // sync only after that status has become idle.
          syncing = false
          emitSync(result.pushed, result.pulled)
          return result
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err))
          emitError(lastError)
          throw err
        } finally {
          syncing = false
        }
      })()
      syncPromise = run
      void run.then(
        () => {
          if (syncPromise === run) syncPromise = null
        },
        () => {
          if (syncPromise === run) syncPromise = null
        },
      )
      return run
    },

    async enableSync(opts: EnableSyncOptions) {
      const newTransport: Transport | null = opts.transport
        ?? (opts.syncUrl ? createHttpTransport(opts.syncUrl, opts.headers, opts.syncRequestTimeoutMs) : null)
      if (!newTransport) {
        throw new Error('enableSync: provide either `transport` or `syncUrl`')
      }
      currentTransport = newTransport
      const nextRealtime = normalizeRealtime(
        opts.realtime ?? (opts.eventsUrl ? createEventSourceRealtime(opts.eventsUrl, opts.headers) : undefined),
      )
      if (nextRealtime && nextRealtime !== currentRealtime) {
        await uninstallRealtime()
        currentRealtime = nextRealtime
      }
      localOnly = false
      await initIfNeeded()
      await installRealtime()
      // Reset backoff so the next poll runs at the base interval.
      currentPollInterval = pollInterval
      scheduleNextPoll()
      // Immediate round-trip to flush accumulated pending writes.
      return client.syncNow({ drain: true })
    },

    disableSync() {
      client.stop()
      localOnly = true
      currentTransport = null
      currentRealtime = null
      lastError = null
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
      if (syncing && syncPromise) {
        await syncPromise
      }
      syncing = true
      const run = (async () => {
        try {
          // Flush pending local writes before replacing the local snapshot.
          await doSync()

          // Wipe only synced models. The durable outbox and HLC state survive.
          for (const modelKey of Object.keys(options.schema)) {
            const rows = await options.database.findMany({ model: modelKey })
            const pkField = getPrimaryKey(modelKey, getModelDef(modelKey))
            for (const row of rows) {
              await options.database.delete({ model: modelKey, where: { [pkField]: row[pkField] } })
            }
            if (rows.length > 0) emitChange(modelKey, rows.map((row) => String(row[pkField])))
          }

          // The preparatory sync may have left a pagination cursor. A full
          // snapshot must always start at zero with no continuation state.
          await setMeta('last_sync_hlc', HLC_ZERO)
          await setMeta('pending_cursor', '')

          const result = await doSyncMaybeDrain({ drain: true })
          syncing = false
          emitSync(result.pushed, result.pulled)
          return result
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err))
          emitError(lastError)
          throw err
        } finally {
          syncing = false
        }
      })()
      syncPromise = run
      void run.then(
        () => {
          if (syncPromise === run) syncPromise = null
        },
        () => {
          if (syncPromise === run) syncPromise = null
        },
      )
      return run
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
          const opId = generateId()
          await options.database.transaction(async (tx) => {
            const result = await tx.upsertIfNewer({ model: modelKey, row })
            if (result === 'skipped') {
              throw new Error(
                `insert on "${modelKey}": row ${String(row[pkField])} exists with newer HLC`,
              )
            }
            await enqueuePending(tx, opId, { type: 'upsert', model: modelKey, row: { ...row } })
            await setMeta('hlc_state', clock.current(), tx)
          })
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
          const hasSyncedPatch = Object.keys(patch).some(
            (fieldName) => (modelDef.fields[fieldName] as FieldDef | undefined)?.sync !== false,
          )
          if (!hasSyncedPatch) {
            await options.database.update({ model: modelKey, where: { [pkField]: id }, update: patch })
            emitChange(modelKey, [id])
            return { ...existing, ...patch }
          }
          const hlc = clock.tick()
          const row: Row = { ...existing, ...patch, [hlcField]: hlc }
          const opId = generateId()
          await options.database.transaction(async (tx) => {
            await tx.upsertIfNewer({ model: modelKey, row })
            await enqueuePending(tx, opId, { type: 'upsert', model: modelKey, row: { ...row } })
            await setMeta('hlc_state', clock.current(), tx)
          })
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
          if (!existing) {
            throw new Error(`delete on "${modelKey}": row ${id} not found`)
          }
          const hlc = clock.tick()
          const scope = scopeFromRow(existing, modelKey)
          const tombstone: Tombstone = { model: modelKey, id, hlc, scope }
          const opId = generateId()
          await options.database.transaction(async (tx) => {
            await tx.delete({ model: modelKey, where: { [pkField]: id } })
            await tx.upsertTombstoneIfNewer(tombstone)
            await enqueuePending(tx, opId, { type: 'delete', model: modelKey, tombstone })
            await setMeta('hlc_state', clock.current(), tx)
          })
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
      if (++guard >= 50) {
        // A repeated or non-advancing server cursor must never leave a
        // foreground caller (for example pull-to-refresh) awaiting forever.
        // Keep the durable cursor/pending queue intact; the next sync can
        // resume once the server-side pagination fault is fixed.
        throw new Error('Sync pagination did not complete after 50 pages')
      }
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
    const outboundPending = pendingRows.slice(0, maxPushBatchSize)

    const changes: ClientChangeSet = {}
    const tombstones: DeleteOperation[] = []
    for (const { id, op } of outboundPending) {
      if (op.type === 'upsert' && op.row) {
        let list = changes[op.model]
        if (!list) {
          list = []
          changes[op.model] = list
        }
        list.push({ opId: id, row: rowForSync(op.model, op.row) })
      } else if (op.type === 'delete' && op.tombstone) {
        tombstones.push({ opId: id, tombstone: op.tombstone })
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
    const response = parseSyncResponse(await currentTransport(request))

    clock.receive(response.serverTime)

    let pulled = 0
    let tombstonesApplied = 0
    const changedModels = new Map<string, string[]>() // model → ids

    await options.database.transaction(async (tx) => {
      for (const [modelKey, rows] of Object.entries(response.changes)) {
        for (const row of rows) {
          const existing = await tx.findOne({
            model: modelKey,
            where: { [getPrimaryKey(modelKey, getModelDef(modelKey))]: row[getPrimaryKey(modelKey, getModelDef(modelKey))] },
          })
          const outcome = await tx.upsertIfNewer({
            model: modelKey,
            row: mergeRemoteRow(modelKey, existing, row),
          })
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

      await clearPending(tx, outboundPending.map((p) => p.id))
      if (response.hasMore && response.cursor) {
        await setMeta('pending_cursor', JSON.stringify(response.cursor), tx)
      } else {
        await setMeta('pending_cursor', '', tx)
        await setMeta('last_sync_hlc', response.serverTime, tx)
      }
      await setMeta('hlc_state', clock.current(), tx)
    })
    lastSyncedAt = Date.now()
    lastError = null

    // Emit events
    for (const [model, ids] of changedModels) {
      emitChange(model, ids)
    }

    return {
      pushed: outboundPending.length,
      pulled,
      tombstonesApplied,
      hasMore: response.hasMore || pendingRows.length > outboundPending.length,
      staleClient: response.staleClient ?? false,
    }
  }

  return client
}

function normalizeRealtime(
  realtime: RealtimeSubscribe | RealtimeTransport | undefined,
): RealtimeSubscribe | null {
  if (!realtime) return null
  if (typeof realtime === 'function') return realtime
  return realtime.subscribe.bind(realtime)
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
  timeoutMs = 15_000,
): Transport {
  return async (request) => {
    const resolvedHeaders = typeof headers === 'function' ? await headers() : (headers ?? {})
    const controller = typeof AbortController === 'undefined' ? null : new AbortController()
    let didTimeOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let res: Response
    try {
      const fetchRequest = fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...resolvedHeaders },
        body: JSON.stringify(request),
        ...(controller ? { signal: controller.signal } : {}),
      })
      // AbortController is advisory in some React Native fetch stacks: they
      // observe the signal yet leave the request Promise pending. Race it
      // against an independent rejection so every sync call has a hard bound.
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          didTimeOut = true
          controller?.abort()
          reject(new Error(`Sync request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
      res = await Promise.race([fetchRequest, timedOut])
    } catch (err) {
      if (didTimeOut) throw new Error(`Sync request timed out after ${timeoutMs}ms`)
      throw err
    } finally {
      if (timeout) clearTimeout(timeout)
    }
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

/**
 * Create a browser/EventSource realtime transport from an SSE endpoint.
 *
 * React Native does not ship EventSource by default. In RN, pass a custom
 * `realtime.subscribe` implementation or an EventSource polyfill.
 */
export function createEventSourceRealtime(
  url: string,
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>),
): RealtimeSubscribe {
  return ({ onEvent, onError }) => {
    const EventSourceCtor = (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource
    if (!EventSourceCtor) {
      throw new Error('EventSource is not available; pass a custom realtime.subscribe transport')
    }

    // Native EventSource cannot set dynamic headers. Keep the headers argument
    // for API symmetry; custom transports should use it where supported.
    void headers

    const source = new EventSourceCtor(url)
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as SyncRealtimeEvent)
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
    source.onerror = () => {
      onError(new Error('Realtime EventSource connection failed'))
    }
    return () => source.close()
  }
}
