/**
 * better-sqlite3 SyncAdapter implementation.
 *
 * Uses synchronous better-sqlite3 API wrapped in async interface.
 * SQLite quirks handled:
 *   - No JSONB: scope stored as TEXT, queried with json_extract()
 *   - No compound row comparison: boolean expansion (hlc > ? OR (hlc = ? AND id > ?))
 *   - No TIMESTAMPTZ: timestamps stored as TEXT
 *   - No BOOLEAN: stored as INTEGER (0/1)
 *   - Placeholders: ? instead of $1/$2
 *   - Transactions: synchronous db.transaction()
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
  adapterId: 'better-sqlite3',
  adapterName: 'better-sqlite3 (SQLite)',
  supportsJSON: false,
  supportsDates: false,
  supportsBooleans: false,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: false,
}

const TOMBSTONE_TABLE = 'sync_tombstones'

export interface BetterSqlite3AdapterOptions {
  hlcField?: string
}

/** Minimal better-sqlite3 statement interface. */
interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}

/** Minimal better-sqlite3 database interface. */
interface SqliteDbLike {
  prepare(sql: string): SqliteStatementLike
  exec(sql: string): void
  transaction<T>(fn: () => T): () => T
}

export function betterSqlite3Adapter(
  db: SqliteDbLike,
  opts: BetterSqlite3AdapterOptions = {},
): SyncAdapter {
  const hlcField = opts.hlcField ?? 'changed'
  let schema: SyncSchema | null = null

  function s(): SyncSchema {
    if (!schema) throw new Error('betterSqlite3Adapter: call ensureSyncTables first')
    return schema
  }

  function tbl(model: string): string {
    const def = s()[model]
    if (!def) throw new Error(`betterSqlite3Adapter: unknown model "${model}"`)
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

  function makeAdapter(conn: SqliteDbLike, isTransaction = false): SyncAdapter {
    function run(sql: string, params: unknown[] = []): { changes: number } {
      return conn.prepare(sql).run(...params)
    }

    function get(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
      return conn.prepare(sql).get(...params)
    }

    function all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
      return conn.prepare(sql).all(...params)
    }

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
          conn.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`)
          conn.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${table}_sync" ON "${table}" ("${hlcField}", "${pkName}")`,
          )
        }
        conn.exec(`
          CREATE TABLE IF NOT EXISTS "${TOMBSTONE_TABLE}" (
            model TEXT NOT NULL,
            id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (model, id)
          )
        `)
        conn.exec(
          `CREATE INDEX IF NOT EXISTS "idx_tombstones_hlc" ON "${TOMBSTONE_TABLE}" (hlc)`,
        )
      },

      async create({ model, data }) {
        const table = tbl(model)
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => data[c] ?? null)
        run(`INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})`, values)
        const row = get(`SELECT * FROM "${table}" WHERE "${pk(model)}" = ?`, [
          data[pk(model)],
        ])
        return (row as Row) ?? data
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
        params.push(...w.params)
        run(`UPDATE "${table}" SET ${sets.join(', ')} WHERE ${w.sql}`, params)
        // Return the updated row
        const row = get(`SELECT * FROM "${table}" WHERE ${w.sql}`, w.params)
        return (row as Row) ?? null
      },

      async delete({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        run(`DELETE FROM "${table}" WHERE ${w.sql}`, w.params)
      },

      async findOne({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const row = get(`SELECT * FROM "${table}" WHERE ${w.sql} LIMIT 1`, w.params)
        return (row as Row) ?? null
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
        return all(sql, w.params) as Row[]
      },

      async count({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const row = get(
          `SELECT COUNT(*) AS count FROM "${table}" WHERE ${w.sql}`,
          w.params,
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
          // Boolean expansion: (hlc > ? OR (hlc = ? AND id > ?))
          conditions.push(`("${hlcField}" > ? OR ("${hlcField}" = ? AND "${pkName}" > ?))`)
          values.push(cursor.hlc, cursor.hlc, cursor.id)
        } else {
          conditions.push(`"${hlcField}" > ?`)
          values.push(sinceHlc)
        }

        const where = conditions.join(' AND ')
        const fetchLimit = lim + 1
        const rows = all(
          `SELECT * FROM "${table}" WHERE ${where} ORDER BY "${hlcField}" ASC, "${pkName}" ASC LIMIT ${fetchLimit}`,
          values,
        ) as Row[]

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

        // Resurrection check
        const tomb = get(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = ? AND id = ?`,
          [model, id],
        )
        if (tomb && shouldDropAsResurrection(String(tomb.hlc), rowHlc)) return 'skipped'

        // Check existence before upsert to determine insert vs update
        const existing = get(
          `SELECT "${hlcField}" FROM "${table}" WHERE "${pkName}" = ?`,
          [id],
        )
        const wasExisting = !!existing

        // Conditional upsert via INSERT ... ON CONFLICT DO UPDATE ... WHERE
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => row[c] ?? null)
        const updateSet = cols
          .filter((c) => c !== pkName)
          .map((c) => `"${c}" = excluded."${c}"`)
          .join(', ')

        const result = run(
          `INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})
           ON CONFLICT ("${pkName}") DO UPDATE SET ${updateSet}
           WHERE "${table}"."${hlcField}" < excluded."${hlcField}"`,
          values,
        )

        if (result.changes === 0) return 'skipped'
        return wasExisting ? 'updated' : 'inserted'
      },

      async findTombstonesSince({ sinceHlc, limit: lim, scope }) {
        if (scope && Object.keys(scope).length > 0) {
          // Use json_extract for scope matching since SQLite has no @> operator
          const conditions: string[] = ['hlc > ?']
          const params: unknown[] = [sinceHlc]
          for (const [k, v] of Object.entries(scope)) {
            conditions.push(`json_extract(scope, '$.' || ?) = ?`)
            params.push(k, v)
          }
          const rows = all(
            `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE ${conditions.join(' AND ')} ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
            params,
          )
          return rows.map(toTombstone)
        }
        const rows = all(
          `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE hlc > ? ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
          [sinceHlc],
        )
        return rows.map(toTombstone)
      },

      async upsertTombstoneIfNewer(t) {
        const existing = get(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = ? AND id = ?`,
          [t.model, t.id],
        )
        if (existing && !shouldApplyTombstone(String(existing.hlc), t.hlc)) return false

        run(
          `INSERT INTO "${TOMBSTONE_TABLE}" (model, id, hlc, scope)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (model, id) DO UPDATE SET hlc = excluded.hlc, scope = excluded.scope
           WHERE "${TOMBSTONE_TABLE}".hlc < excluded.hlc`,
          [t.model, t.id, t.hlc, JSON.stringify(t.scope)],
        )
        const table = tbl(t.model)
        const pkName = pk(t.model)
        run(`DELETE FROM "${table}" WHERE "${pkName}" = ?`, [t.id])
        return true
      },

      async gcTombstones({ olderThanHlc }) {
        const result = run(
          `DELETE FROM "${TOMBSTONE_TABLE}" WHERE hlc < ?`,
          [olderThanHlc],
        )
        return result.changes
      },

      async transaction(fn) {
        if (isTransaction) {
          // Already in a transaction — run inline.
          return fn(adapter)
        }
        // better-sqlite3 transactions are synchronous, but our adapter interface
        // is async. Since all adapter operations underneath are synchronous
        // (better-sqlite3 is sync), awaits resolve in the same tick, keeping
        // the transaction valid. We use manual BEGIN/COMMIT/ROLLBACK to allow
        // awaiting the async callback.
        conn.exec('BEGIN')
        try {
          const txAdapter = makeAdapter(conn, true)
          const orig = txAdapter.ensureSyncTables
          txAdapter.ensureSyncTables = async () => {}
          const result = await fn(txAdapter)
          txAdapter.ensureSyncTables = orig
          conn.exec('COMMIT')
          return result
        } catch (err) {
          conn.exec('ROLLBACK')
          throw err
        }
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
    scope: typeof row.scope === 'string' ? JSON.parse(row.scope as string) : (row.scope as Scope) ?? {},
  }
}
