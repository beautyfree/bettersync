/**
 * PGlite SyncAdapter implementation.
 *
 * Uses `pglite.query(sql, params)` for parameterized queries.
 * Postgres SQL: ON CONFLICT ... WHERE, JSONB @>, (col1, col2) > (val1, val2).
 * Same SQL as the Drizzle adapter — PGlite IS Postgres.
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
  adapterId: 'pglite',
  adapterName: 'PGlite (Postgres WASM)',
  supportsJSON: true,
  supportsDates: true,
  supportsBooleans: true,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: true,
}

const TOMBSTONE_TABLE = 'sync_tombstones'

export interface PGliteAdapterOptions {
  hlcField?: string
}

/** Minimal PGlite interface — just the methods we use. */
/** Minimal query interface — both PGlite and PGlite Transaction implement this. */
interface PGliteQueryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(sql: string): Promise<unknown>
}

/** Full PGlite instance (has transaction support). */
interface PGliteLike extends PGliteQueryable {
  transaction<T>(fn: (tx: PGliteQueryable) => Promise<T>): Promise<T>
}

export function pgliteAdapter(pg: PGliteLike, opts: PGliteAdapterOptions = {}): SyncAdapter {
  const hlcField = opts.hlcField ?? 'changed'
  let schema: SyncSchema | null = null
  const rootPg = pg // keep reference for transaction support

  function s(): SyncSchema {
    if (!schema) throw new Error('pgliteAdapter: call ensureSyncTables first')
    return schema
  }

  function tbl(model: string): string {
    const def = s()[model]
    if (!def) throw new Error(`pgliteAdapter: unknown model "${model}"`)
    return getModelTableName(model, def)
  }

  function pk(model: string): string {
    return getPrimaryKey(model, s()[model]!)
  }

  /** Does the model declare the HLC column? (Internal tables like
   *  `_sync_pending` / `_sync_meta` don't — they live outside HLC.) */
  function hasHlc(model: string): boolean {
    return hlcField in s()[model]!.fields
  }

  function allCols(model: string): string[] {
    const fields = Object.keys(s()[model]!.fields)
    return hasHlc(model) ? [...new Set([...fields, hlcField])] : fields
  }

  function whereClause(where: Where | undefined, startIdx = 1): { sql: string; params: unknown[] } {
    if (!where || Object.keys(where).length === 0) return { sql: 'TRUE', params: [] }
    const parts: string[] = []
    const params: unknown[] = []
    let idx = startIdx
    for (const [k, v] of Object.entries(where)) {
      parts.push(`"${k}" = $${idx++}`)
      params.push(v)
    }
    return { sql: parts.join(' AND '), params }
  }

  function makeAdapter(conn: PGliteQueryable, isTransaction = false): SyncAdapter {
    async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await conn.query<T>(sql, params)
      return result.rows
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
          await conn.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`)
          if (hasHlc(modelKey)) {
            await conn.exec(
              `CREATE INDEX IF NOT EXISTS "idx_${table}_sync" ON "${table}" ("${hlcField}", "${pkName}")`,
            )
          }
        }
        await conn.exec(`
          CREATE TABLE IF NOT EXISTS "${TOMBSTONE_TABLE}" (
            model TEXT NOT NULL,
            id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            scope JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model, id)
          )
        `)
        await conn.exec(`CREATE INDEX IF NOT EXISTS "idx_tombstones_hlc" ON "${TOMBSTONE_TABLE}" (hlc)`)
      },

      async create({ model, data }) {
        const table = tbl(model)
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
        const values = cols.map((c) => data[c] ?? null)
        const rows = await q(`INSERT INTO "${table}" (${colStr}) VALUES (${placeholders}) RETURNING *`, values)
        return rows[0] ?? data
      },

      async update({ model, where, update: patch }) {
        const table = tbl(model)
        const entries = Object.entries(patch)
        if (entries.length === 0) return null
        const sets: string[] = []
        const params: unknown[] = []
        let idx = 1
        for (const [k, v] of entries) {
          sets.push(`"${k}" = $${idx++}`)
          params.push(v)
        }
        const w = whereClause(where, idx)
        params.push(...w.params)
        const rows = await q(`UPDATE "${table}" SET ${sets.join(', ')} WHERE ${w.sql} RETURNING *`, params)
        return rows[0] ?? null
      },

      async delete({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        await q(`DELETE FROM "${table}" WHERE ${w.sql}`, w.params)
      },

      async findOne({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const rows = await q(`SELECT * FROM "${table}" WHERE ${w.sql} LIMIT 1`, w.params)
        return rows[0] ?? null
      },

      async findMany({ model, where, limit: lim, offset: off, sortBy }) {
        const table = tbl(model)
        const w = whereClause(where)
        let sql = `SELECT * FROM "${table}" WHERE ${w.sql}`
        if (sortBy) {
          const order = Object.entries(sortBy).map(([k, dir]) => `"${k}" ${dir.toUpperCase()}`).join(', ')
          sql += ` ORDER BY ${order}`
        }
        if (lim != null) sql += ` LIMIT ${lim}`
        if (off != null && off > 0) sql += ` OFFSET ${off}`
        return q(sql, w.params)
      },

      async count({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const rows = await q<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${w.sql}`, w.params)
        return rows[0]?.count ?? 0
      },

      async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
        const { model, sinceHlc, limit: lim, cursor, scope } = params
        const table = tbl(model)
        const pkName = pk(model)
        const conditions: string[] = []
        const values: unknown[] = []
        let idx = 1

        if (scope) {
          for (const [k, v] of Object.entries(scope)) {
            conditions.push(`"${k}" = $${idx++}`)
            values.push(v)
          }
        }

        if (cursor) {
          conditions.push(`("${hlcField}", "${pkName}") > ($${idx}, $${idx + 1})`)
          values.push(cursor.hlc, cursor.id)
          idx += 2
        } else {
          conditions.push(`"${hlcField}" > $${idx++}`)
          values.push(sinceHlc)
        }

        const where = conditions.join(' AND ')
        const fetchLimit = lim + 1
        const rows = await q(
          `SELECT * FROM "${table}" WHERE ${where} ORDER BY "${hlcField}" ASC, "${pkName}" ASC LIMIT ${fetchLimit}`,
          values,
        )

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
        const tombs = await q<{ hlc: string }>(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = $1 AND id = $2`,
          [model, id],
        )
        if (tombs.length > 0 && shouldDropAsResurrection(tombs[0]!.hlc, rowHlc)) return 'skipped'

        // Existence check
        const existing = await q(`SELECT "${hlcField}" FROM "${table}" WHERE "${pkName}" = $1`, [id])
        const wasExisting = existing.length > 0

        // Conditional upsert
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
        const values = cols.map((c) => row[c] ?? null)
        const updateSet = cols.filter((c) => c !== pkName).map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')

        const result = await q(
          `INSERT INTO "${table}" (${colStr}) VALUES (${placeholders})
           ON CONFLICT ("${pkName}") DO UPDATE SET ${updateSet}
           WHERE "${table}"."${hlcField}" < EXCLUDED."${hlcField}"
           RETURNING "${pkName}"`,
          values,
        )
        if (result.length === 0) return 'skipped'
        return wasExisting ? 'updated' : 'inserted'
      },

      async findTombstonesSince({ sinceHlc, limit: lim, scope }) {
        if (scope && Object.keys(scope).length > 0) {
          const rows = await q(
            `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE hlc > $1 AND scope @> $2::jsonb ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
            [sinceHlc, JSON.stringify(scope)],
          )
          return rows.map(toTombstone)
        }
        const rows = await q(
          `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE hlc > $1 ORDER BY hlc ASC, id ASC LIMIT ${lim}`,
          [sinceHlc],
        )
        return rows.map(toTombstone)
      },

      async upsertTombstoneIfNewer(t) {
        const existing = await q<{ hlc: string }>(
          `SELECT hlc FROM "${TOMBSTONE_TABLE}" WHERE model = $1 AND id = $2`,
          [t.model, t.id],
        )
        if (existing.length > 0 && !shouldApplyTombstone(existing[0]!.hlc, t.hlc)) return false

        await q(
          `INSERT INTO "${TOMBSTONE_TABLE}" (model, id, hlc, scope)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (model, id) DO UPDATE SET hlc = EXCLUDED.hlc, scope = EXCLUDED.scope
           WHERE "${TOMBSTONE_TABLE}".hlc < EXCLUDED.hlc`,
          [t.model, t.id, t.hlc, JSON.stringify(t.scope)],
        )
        const table = tbl(t.model)
        const pkName = pk(t.model)
        await q(`DELETE FROM "${table}" WHERE "${pkName}" = $1`, [t.id])
        return true
      },

      async gcTombstones({ olderThanHlc }) {
        const rows = await q<{ count: number }>(
          `WITH deleted AS (DELETE FROM "${TOMBSTONE_TABLE}" WHERE hlc < $1 RETURNING 1) SELECT COUNT(*)::int AS count FROM deleted`,
          [olderThanHlc],
        )
        return rows[0]?.count ?? 0
      },

      async transaction(fn) {
        if (isTransaction) {
          // Already in a transaction — PGlite doesn't support nested tx.
          // Just run inline (savepoints not supported in PGlite v0.2).
          return fn(adapter)
        }
        return rootPg.transaction(async (tx) => {
          const txAdapter = makeAdapter(tx, true)
          const orig = txAdapter.ensureSyncTables
          txAdapter.ensureSyncTables = async () => {}
          try {
            return await fn(txAdapter)
          } finally {
            txAdapter.ensureSyncTables = orig
          }
        })
      },
    }

    return adapter
  }

  return makeAdapter(pg)
}

function sqlType(type: string | readonly string[]): string {
  if (Array.isArray(type)) return 'TEXT'
  switch (type) {
    case 'string': return 'TEXT'
    case 'number': return 'NUMERIC'
    case 'boolean': return 'BOOLEAN'
    case 'date': return 'TEXT'
    case 'json': return 'JSONB'
    default: return 'TEXT'
  }
}

function toTombstone(row: Row): Tombstone {
  return {
    model: String(row.model),
    id: String(row.id),
    hlc: String(row.hlc),
    scope: typeof row.scope === 'string' ? JSON.parse(row.scope) : (row.scope as Scope) ?? {},
  }
}
