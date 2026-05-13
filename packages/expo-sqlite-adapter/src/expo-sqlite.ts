/**
 * expo-sqlite SyncAdapter implementation.
 *
 * Wraps the async expo-sqlite API (`runAsync`, `getFirstAsync`,
 * `getAllAsync`, `execAsync`, `withExclusiveTransactionAsync`) so a
 * React Native / Expo client can hold a local-first sync store on-device.
 *
 * SQLite quirks handled (same as better-sqlite3 adapter):
 *   - No JSONB: scope stored as TEXT, queried with json_extract()
 *   - No compound row comparison: boolean expansion
 *   - No TIMESTAMPTZ: timestamps stored as TEXT
 *   - No BOOLEAN: stored as INTEGER (0/1)
 *   - Placeholders: ?  not  $1
 *   - Transactions: async withExclusiveTransactionAsync
 */

import {
  type AdapterCapabilities,
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type Row,
  type Scope,
  type SyncAdapter,
  type SyncSchema,
  type Tombstone,
  type Where,
  getModelTableName,
  getPrimaryKey,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '@bettersync/core'

const CAPABILITIES: AdapterCapabilities = {
  adapterId: 'expo-sqlite',
  adapterName: 'expo-sqlite (React Native)',
  supportsJSON: false,
  supportsDates: false,
  supportsBooleans: false,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: false,
}

const TOMBSTONE_TABLE = 'sync_tombstones'

export interface ExpoSqliteAdapterOptions {
  hlcField?: string
  /**
   * Use `withExclusiveTransactionAsync` (default) for serialized writes.
   * Set to `false` to fall back to `withTransactionAsync` (non-exclusive).
   */
  exclusiveTransactions?: boolean
}

/**
 * Minimal shape of an expo-sqlite database / transaction handle.
 * Compatible with both `SQLiteDatabase` and the `txn` arg passed to
 * `withExclusiveTransactionAsync`.
 */
export interface ExpoSqliteDbLike {
  execAsync(source: string): Promise<void>
  runAsync(
    source: string,
    ...params: unknown[]
  ): Promise<{ lastInsertRowId: number; changes: number }>
  getFirstAsync<T = Record<string, unknown>>(
    source: string,
    ...params: unknown[]
  ): Promise<T | null>
  getAllAsync<T = Record<string, unknown>>(
    source: string,
    ...params: unknown[]
  ): Promise<T[]>
  withExclusiveTransactionAsync?(
    task: (txn: ExpoSqliteDbLike) => Promise<void>,
  ): Promise<void>
  withTransactionAsync?(task: () => Promise<void>): Promise<void>
}

export function expoSqliteAdapter(
  db: ExpoSqliteDbLike,
  opts: ExpoSqliteAdapterOptions = {},
): SyncAdapter {
  const hlcField = opts.hlcField ?? 'changed'
  const useExclusive = opts.exclusiveTransactions ?? true
  let schema: SyncSchema | null = null

  function s(): SyncSchema {
    if (!schema) throw new Error('expoSqliteAdapter: call ensureSyncTables first')
    return schema
  }

  function tbl(model: string): string {
    const def = s()[model]
    if (!def) throw new Error(`expoSqliteAdapter: unknown model "${model}"`)
    return getModelTableName(model, def)
  }

  function pk(model: string): string {
    return getPrimaryKey(model, s()[model]!)
  }

  function allCols(model: string): string[] {
    return [...new Set([...Object.keys(s()[model]!.fields), hlcField])]
  }

  function whereClause(where: Where | undefined): { sql: string; params: unknown[] } {
    if (!where || Object.keys(where).length === 0) return { sql: '1=1', params: [] }
    const parts: string[] = []
    const params: unknown[] = []
    for (const [k, v] of Object.entries(where)) {
      parts.push(`"${k}" = ?`)
      params.push(v)
    }
    return { sql: parts.join(' AND '), params }
  }

  function makeAdapter(conn: ExpoSqliteDbLike, isTransaction = false): SyncAdapter {
    const adapter: SyncAdapter = {
      capabilities: CAPABILITIES,

      async ensureSyncTables(s_) {
        schema = s_
        for (const [modelKey, def] of Object.entries(s_)) {
          const table = getModelTableName(modelKey, def)
          const pkName = getPrimaryKey(modelKey, def)
          const cols = allCols(modelKey)
          const colDefs = cols.map((name) => {
            const f = def.fields[name]
            const typ = sqlType(f?.type ?? 'string')
            if (name === pkName) return `"${name}" ${typ} PRIMARY KEY`
            if (name === hlcField) return `"${name}" TEXT NOT NULL`
            const notNull = f?.required !== false ? ' NOT NULL' : ''
            return `"${name}" ${typ}${notNull}`
          })
          await conn.execAsync(
            `CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`,
          )
          await conn.execAsync(
            `CREATE INDEX IF NOT EXISTS "idx_${table}_sync" ON "${table}" ("${hlcField}", "${pkName}")`,
          )
        }
        await conn.execAsync(`
          CREATE TABLE IF NOT EXISTS "${TOMBSTONE_TABLE}" (
            model TEXT NOT NULL,
            id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (model, id)
          )
        `)
        await conn.execAsync(
          `CREATE INDEX IF NOT EXISTS "idx_tombstones_hlc" ON "${TOMBSTONE_TABLE}" (hlc)`,
        )
      },

      async create({ model, data }) {
        const table = tbl(model)
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => data[c] ?? null)
        await conn.runAsync(
          `INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})`,
          ...values,
        )
        const row = await conn.getFirstAsync<Row>(
          `SELECT * FROM "${table}" WHERE "${pk(model)}" = ?`,
          data[pk(model)],
        )
        return row ?? data
      },

      async update({ model, where, update: patch }) {
        const table = tbl(model)
        const entries = Object.entries(patch)
        if (entries.length === 0) return null
        const sets: string[] = []
        const params: unknown[] = []
        for (const [k, v] of entries) {
          sets.push(`"${k}" = ?`)
          params.push(v)
        }
        const w = whereClause(where)
        await conn.runAsync(
          `UPDATE "${table}" SET ${sets.join(', ')} WHERE ${w.sql}`,
          ...params,
          ...w.params,
        )
        const row = await conn.getFirstAsync<Row>(
          `SELECT * FROM "${table}" WHERE ${w.sql}`,
          ...w.params,
        )
        return row ?? null
      },

      async delete({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        await conn.runAsync(`DELETE FROM "${table}" WHERE ${w.sql}`, ...w.params)
      },

      async findOne({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const row = await conn.getFirstAsync<Row>(
          `SELECT * FROM "${table}" WHERE ${w.sql} LIMIT 1`,
          ...w.params,
        )
        return row ?? null
      },

      async findMany({ model, where, limit: lim, offset: off, sortBy }) {
        const table = tbl(model)
        const w = whereClause(where)
        let sql = `SELECT * FROM "${table}" WHERE ${w.sql}`
        if (sortBy) {
          const order = Object.entries(sortBy)
            .map(([k, dir]) => `"${k}" ${dir.toUpperCase()}`)
            .join(', ')
          sql += ` ORDER BY ${order}`
        }
        if (lim != null) sql += ` LIMIT ${lim}`
        if (off != null && off > 0) sql += ` OFFSET ${off}`
        return (await conn.getAllAsync<Row>(sql, ...w.params)) as Row[]
      },

      async count({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const row = await conn.getFirstAsync<{ count: number }>(
          `SELECT COUNT(*) AS count FROM "${table}" WHERE ${w.sql}`,
          ...w.params,
        )
        return Number(row?.count ?? 0)
      },

      async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
        const { model, sinceHlc, limit: lim, cursor, scope } = params
        const table = tbl(model)
        const pkName = pk(model)
        const conditions: string[] = []
        const values: unknown[] = []

        if (scope) {
          for (const [k, v] of Object.entries(scope)) {
            conditions.push(`"${k}" = ?`)
            values.push(v)
          }
        }

        if (cursor) {
          conditions.push(`("${hlcField}" > ? OR ("${hlcField}" = ? AND "${pkName}" > ?))`)
          values.push(cursor.hlc, cursor.hlc, cursor.id)
        } else {
          conditions.push(`"${hlcField}" > ?`)
          values.push(sinceHlc)
        }

        const where = conditions.join(' AND ')
        const fetchLimit = lim + 1
        const rows = (await conn.getAllAsync<Row>(
          `SELECT * FROM "${table}" WHERE ${where} ORDER BY "${hlcField}" ASC, "${pkName}" ASC LIMIT ${fetchLimit}`,
          ...values,
        )) as Row[]

        const hasMore = rows.length > lim
        const page = hasMore ? rows.slice(0, lim) : rows
        const result: FindChangedSinceResult = { rows: page }
        if (hasMore && page.length > 0) {
          const last = page[page.length - 1]!
          result.nextCursor = { hlc: String(last[hlcField]), id: String(last[pkName]) }
        }
        return result
      },

      async upsertIfNewer({ model, row }) {
        const table = tbl(model)
        const pkName = pk(model)
        const id = String(row[pkName])
        const rowHlc = String(row[hlcField])

        const tomb = await conn.getFirstAsync<{ hlc: string }>(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = ? AND id = ?`,
          model,
          id,
        )
        if (tomb && shouldDropAsResurrection(String(tomb.hlc), rowHlc)) return 'skipped'

        const existing = await conn.getFirstAsync<Record<string, unknown>>(
          `SELECT "${hlcField}" FROM "${table}" WHERE "${pkName}" = ?`,
          id,
        )
        const wasExisting = !!existing

        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => row[c] ?? null)
        const updateSet = cols
          .filter((c) => c !== pkName)
          .map((c) => `"${c}" = excluded."${c}"`)
          .join(', ')

        const result = await conn.runAsync(
          `INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})
           ON CONFLICT ("${pkName}") DO UPDATE SET ${updateSet}
           WHERE "${table}"."${hlcField}" < excluded."${hlcField}"`,
          ...values,
        )

        if (result.changes === 0) return 'skipped'
        return wasExisting ? 'updated' : 'inserted'
      },

      async findTombstonesSince({ sinceHlc, limit: lim, scope }) {
        if (scope && Object.keys(scope).length > 0) {
          const conditions: string[] = ['hlc > ?']
          const params: unknown[] = [sinceHlc]
          for (const [k, v] of Object.entries(scope)) {
            conditions.push(`json_extract(scope, '$.' || ?) = ?`)
            params.push(k, v)
          }
          const rows = await conn.getAllAsync<Row>(
            `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE ${conditions.join(' AND ')} ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
            ...params,
          )
          return rows.map(toTombstone)
        }
        const rows = await conn.getAllAsync<Row>(
          `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE hlc > ? ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
          sinceHlc,
        )
        return rows.map(toTombstone)
      },

      async upsertTombstoneIfNewer(t) {
        const existing = await conn.getFirstAsync<{ hlc: string }>(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = ? AND id = ?`,
          t.model,
          t.id,
        )
        if (existing && !shouldApplyTombstone(String(existing.hlc), t.hlc)) return false

        await conn.runAsync(
          `INSERT INTO "${TOMBSTONE_TABLE}" (model, id, hlc, scope)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (model, id) DO UPDATE SET hlc = excluded.hlc, scope = excluded.scope
           WHERE "${TOMBSTONE_TABLE}".hlc < excluded.hlc`,
          t.model,
          t.id,
          t.hlc,
          JSON.stringify(t.scope),
        )
        const table = tbl(t.model)
        const pkName = pk(t.model)
        await conn.runAsync(`DELETE FROM "${table}" WHERE "${pkName}" = ?`, t.id)
        return true
      },

      async gcTombstones({ olderThanHlc }) {
        const result = await conn.runAsync(
          `DELETE FROM "${TOMBSTONE_TABLE}" WHERE hlc < ?`,
          olderThanHlc,
        )
        return result.changes
      },

      async transaction(fn) {
        if (isTransaction) {
          return fn(adapter)
        }
        let captured: unknown
        let err: unknown
        const runner =
          useExclusive && conn.withExclusiveTransactionAsync
            ? (task: (txn: ExpoSqliteDbLike) => Promise<void>) =>
                conn.withExclusiveTransactionAsync!(task)
            : conn.withTransactionAsync
            ? (task: (txn: ExpoSqliteDbLike) => Promise<void>) =>
                conn.withTransactionAsync!(() => task(conn))
            : null

        if (!runner) {
          // Fallback: manual BEGIN/COMMIT for environments where neither
          // withExclusiveTransactionAsync nor withTransactionAsync exist
          // (e.g. test doubles). Not safe for concurrent writes.
          await conn.execAsync('BEGIN')
          try {
            const txAdapter = makeAdapter(conn, true)
            const orig = txAdapter.ensureSyncTables
            txAdapter.ensureSyncTables = async () => {}
            const result = await fn(txAdapter)
            txAdapter.ensureSyncTables = orig
            await conn.execAsync('COMMIT')
            return result
          } catch (e) {
            await conn.execAsync('ROLLBACK')
            throw e
          }
        }

        try {
          await runner(async (txn) => {
            const txAdapter = makeAdapter(txn, true)
            const orig = txAdapter.ensureSyncTables
            txAdapter.ensureSyncTables = async () => {}
            try {
              captured = await fn(txAdapter)
            } catch (e) {
              err = e
              throw e
            } finally {
              txAdapter.ensureSyncTables = orig
            }
          })
        } catch (e) {
          if (err) throw err
          throw e
        }
        return captured as Awaited<ReturnType<typeof fn>>
      },
    }

    return adapter
  }

  return makeAdapter(db)
}

function sqlType(type: string | readonly string[]): string {
  if (Array.isArray(type)) return 'TEXT'
  switch (type) {
    case 'string':
      return 'TEXT'
    case 'number':
      return 'REAL'
    case 'boolean':
      return 'INTEGER'
    case 'date':
      return 'TEXT'
    case 'json':
      return 'TEXT'
    default:
      return 'TEXT'
  }
}

function toTombstone(row: Row): Tombstone {
  return {
    model: String(row.model),
    id: String(row.id),
    hlc: String(row.hlc),
    scope:
      typeof row.scope === 'string'
        ? JSON.parse(row.scope as string)
        : ((row.scope as Scope) ?? {}),
  }
}
