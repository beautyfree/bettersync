/**
 * In-memory SyncAdapter implementation.
 *
 * Storage layout:
 *   store:      Map<modelName, Map<id, Row>>
 *   tombstones: Map<`${model}:${id}`, Tombstone>
 *
 * Transactions are implemented via deep-copy snapshot + rollback on throw.
 * This is fine for tests and small datasets; do NOT use this adapter for
 * production workloads.
 */

import {
  type AdapterCapabilities,
  type AdapterCursor,
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type ModelDef,
  type Row,
  type Scope,
  type SyncAdapter,
  type SyncSchema,
  type Tombstone,
  type Where,
  compareHlc,
  decideMerge,
  getPrimaryKey,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '@better-sync/core'

const CAPABILITIES: AdapterCapabilities = {
  adapterId: 'memory',
  adapterName: 'In-Memory',
  supportsJSON: true,
  supportsDates: true,
  supportsBooleans: true,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: true,
}

export interface MemoryAdapterOptions {
  /**
   * Field name on each row that stores the HLC. Defaults to `'changed'`.
   */
  hlcField?: string
}

interface InternalState {
  schema: SyncSchema | null
  store: Map<string, Map<string, Row>>
  tombstones: Map<string, Tombstone>
  hlcField: string
}

/**
 * Create a fresh in-memory adapter. Each call returns an isolated instance.
 */
export function memoryAdapter(opts: MemoryAdapterOptions = {}): SyncAdapter {
  const state: InternalState = {
    schema: null,
    store: new Map(),
    tombstones: new Map(),
    hlcField: opts.hlcField ?? 'changed',
  }
  return createAdapter(state)
}

function tombstoneKey(model: string, id: string): string {
  return `${model}:${id}`
}

function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  for (const [k, v] of Object.entries(where)) {
    if (row[k] !== v) return false
  }
  return true
}

function matchesScope(
  source: Record<string, unknown>,
  scope: Scope | undefined,
): boolean {
  if (!scope) return true
  for (const [k, v] of Object.entries(scope)) {
    if (source[k] !== v) return false
  }
  return true
}

function cloneRow(row: Row): Row {
  return { ...row }
}

function cloneTombstone(t: Tombstone): Tombstone {
  return { ...t, scope: { ...t.scope } }
}

function snapshotState(state: InternalState): Pick<InternalState, 'store' | 'tombstones'> {
  const store = new Map<string, Map<string, Row>>()
  for (const [model, table] of state.store) {
    const inner = new Map<string, Row>()
    for (const [id, row] of table) {
      inner.set(id, cloneRow(row))
    }
    store.set(model, inner)
  }
  const tombstones = new Map<string, Tombstone>()
  for (const [key, t] of state.tombstones) {
    tombstones.set(key, cloneTombstone(t))
  }
  return { store, tombstones }
}

function restoreState(
  state: InternalState,
  snapshot: Pick<InternalState, 'store' | 'tombstones'>,
): void {
  state.store = snapshot.store
  state.tombstones = snapshot.tombstones
}

function createAdapter(state: InternalState): SyncAdapter {
  function requireSchema(): SyncSchema {
    if (!state.schema) {
      throw new Error(
        'memoryAdapter: ensureSyncTables(schema) must be called before any other method',
      )
    }
    return state.schema
  }

  function requireModelDef(model: string): ModelDef {
    const def = requireSchema()[model]
    if (!def) throw new Error(`memoryAdapter: model "${model}" is not in the schema`)
    return def
  }

  function requirePkField(model: string): string {
    return getPrimaryKey(model, requireModelDef(model))
  }

  function requireTable(model: string): Map<string, Row> {
    let tbl = state.store.get(model)
    if (!tbl) {
      tbl = new Map()
      state.store.set(model, tbl)
    }
    return tbl
  }

  function compareBySortBy(
    a: Row,
    b: Row,
    sortBy: Record<string, 'asc' | 'desc'>,
  ): number {
    for (const [field, dir] of Object.entries(sortBy)) {
      const av = a[field]
      const bv = b[field]
      if (av === bv) continue
      const cmp =
        av == null
          ? -1
          : bv == null
            ? 1
            : av < bv
              ? -1
              : 1
      return dir === 'asc' ? cmp : -cmp
    }
    return 0
  }

  const adapter: SyncAdapter = {
    capabilities: CAPABILITIES,

    async ensureSyncTables(schema) {
      state.schema = schema
      for (const modelKey of Object.keys(schema)) {
        if (!state.store.has(modelKey)) state.store.set(modelKey, new Map())
      }
    },

    async create({ model, data }) {
      const pk = requirePkField(model)
      const table = requireTable(model)
      const idVal = data[pk]
      if (idVal == null) {
        throw new Error(`memoryAdapter: create on "${model}" missing primary key "${pk}"`)
      }
      const id = String(idVal)
      if (table.has(id)) {
        throw new Error(`memoryAdapter: duplicate primary key on "${model}": ${id}`)
      }
      const stored = cloneRow(data)
      table.set(id, stored)
      return cloneRow(stored)
    },

    async update({ model, where, update }) {
      const table = requireTable(model)
      for (const [id, row] of table) {
        if (matchesWhere(row, where)) {
          const updated = { ...row, ...update }
          table.set(id, updated)
          return cloneRow(updated)
        }
      }
      return null
    },

    async delete({ model, where }) {
      const table = requireTable(model)
      for (const [id, row] of [...table.entries()]) {
        if (matchesWhere(row, where)) {
          table.delete(id)
        }
      }
    },

    async findOne({ model, where }) {
      const table = requireTable(model)
      for (const row of table.values()) {
        if (matchesWhere(row, where)) return cloneRow(row)
      }
      return null
    },

    async findMany({ model, where, limit, offset = 0, sortBy }) {
      const table = requireTable(model)
      let rows: Row[] = []
      for (const row of table.values()) {
        if (matchesWhere(row, where)) rows.push(row)
      }
      if (sortBy) {
        rows.sort((a, b) => compareBySortBy(a, b, sortBy))
      }
      if (offset > 0) rows = rows.slice(offset)
      if (limit != null) rows = rows.slice(0, limit)
      return rows.map(cloneRow)
    },

    async count({ model, where }) {
      const table = requireTable(model)
      let n = 0
      for (const row of table.values()) {
        if (matchesWhere(row, where)) n += 1
      }
      return n
    },

    async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
      const { model, sinceHlc, limit, cursor, scope } = params
      const pk = requirePkField(model)
      const table = requireTable(model)

      const filtered: Row[] = []
      for (const row of table.values()) {
        if (!matchesScope(row as Record<string, unknown>, scope)) continue
        const rowHlc = String(row[state.hlcField])
        if (compareHlc(rowHlc, sinceHlc) <= 0) continue
        if (cursor) {
          // Compound (changed, id) > (cursor.hlc, cursor.id)
          const hlcCmp = compareHlc(rowHlc, cursor.hlc)
          if (hlcCmp < 0) continue
          if (hlcCmp === 0) {
            const idCmp = String(row[pk]).localeCompare(cursor.id)
            if (idCmp <= 0) continue
          }
        }
        filtered.push(row)
      }

      filtered.sort((a, b) => {
        const hlcCmp = compareHlc(String(a[state.hlcField]), String(b[state.hlcField]))
        if (hlcCmp !== 0) return hlcCmp
        return String(a[pk]).localeCompare(String(b[pk]))
      })

      const hasMore = filtered.length > limit
      const page = filtered.slice(0, limit).map(cloneRow)

      const result: FindChangedSinceResult = { rows: page }
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]
        if (last) {
          const nextCursor: AdapterCursor = {
            hlc: String(last[state.hlcField]),
            id: String(last[pk]),
          }
          result.nextCursor = nextCursor
        }
      }
      return result
    },

    async upsertIfNewer({ model, row }) {
      const pk = requirePkField(model)
      const table = requireTable(model)
      const id = String(row[pk])

      // Check for resurrection against tombstone
      const ts = state.tombstones.get(tombstoneKey(model, id))
      const rowHlc = String(row[state.hlcField])
      if (shouldDropAsResurrection(ts?.hlc ?? null, rowHlc)) {
        return 'skipped'
      }

      const existing = table.get(id) ?? null
      const { action, result } = decideMerge(existing, row, state.hlcField)
      if (action !== 'skipped') {
        table.set(id, cloneRow(result))
      }
      return action
    },

    async batchUpsertIfNewer({ model, rows }) {
      let inserted = 0
      let updated = 0
      let skipped = 0
      for (const row of rows) {
        const outcome = await adapter.upsertIfNewer({ model, row })
        if (outcome === 'inserted') inserted += 1
        else if (outcome === 'updated') updated += 1
        else skipped += 1
      }
      return { inserted, updated, skipped }
    },

    async findTombstonesSince({ sinceHlc, limit, scope }) {
      const filtered: Tombstone[] = []
      for (const t of state.tombstones.values()) {
        if (compareHlc(t.hlc, sinceHlc) <= 0) continue
        if (!matchesScope(t.scope, scope)) continue
        filtered.push(t)
      }
      filtered.sort((a, b) => {
        const c = compareHlc(a.hlc, b.hlc)
        if (c !== 0) return c
        return a.id.localeCompare(b.id)
      })
      return filtered.slice(0, limit).map(cloneTombstone)
    },

    async upsertTombstoneIfNewer(t) {
      const key = tombstoneKey(t.model, t.id)
      const existing = state.tombstones.get(key)
      if (!shouldApplyTombstone(existing?.hlc ?? null, t.hlc)) return false
      state.tombstones.set(key, cloneTombstone(t))
      // Also remove the row if present — delete semantics
      const table = state.store.get(t.model)
      if (table) table.delete(t.id)
      return true
    },

    async gcTombstones({ olderThanHlc }) {
      let removed = 0
      for (const [key, t] of [...state.tombstones.entries()]) {
        if (compareHlc(t.hlc, olderThanHlc) < 0) {
          state.tombstones.delete(key)
          removed += 1
        }
      }
      return removed
    },

    async transaction(fn) {
      const snapshot = snapshotState(state)
      try {
        return await fn(adapter)
      } catch (err) {
        restoreState(state, snapshot)
        throw err
      }
    },
  }

  return adapter
}
