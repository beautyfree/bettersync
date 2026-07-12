/**
 * node-postgres (pg) SyncAdapter implementation.
 *
 * Uses `client.query(sql, params)` for parameterized queries.
 * Postgres SQL: ON CONFLICT ... WHERE, JSONB @>, (col1, col2) > (val1, val2).
 * Same SQL as the PGlite adapter — same Postgres dialect.
 */

import {
  type AdapterCapabilities,
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type FindTombstonesSinceParams,
  type FindTombstonesSinceResult,
  type Row,
  type Scope,
  type SyncAdapter,
  type SyncSchema,
  type Tombstone,
  type Where,
  columnMappingAdapter,
  getModelTableName,
  getPrimaryKey,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '@bettersync/core'

const CAPABILITIES: AdapterCapabilities = {
  adapterId: 'pg',
  adapterName: 'node-postgres (pg)',
  supportsJSON: true,
  supportsDates: true,
  supportsBooleans: true,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: true,
}

const TOMBSTONE_TABLE = 'sync_tombstones'
const OPERATION_TABLE = 'sync_operations'

export interface PgAdapterOptions {
  hlcField?: string
}

/** Minimal query interface — both Pool and PoolClient implement this. */
interface PgQueryable {
  query<T extends Record<string, unknown> = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>
}

/** Full Pool instance (has connect for transactions). */
interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>
}

/** A connected client from pool.connect(). */
interface PgClientLike extends PgQueryable {
  query<T extends Record<string, unknown> = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>
  release(): void
}

export function pgAdapter(pool: PgPoolLike, opts: PgAdapterOptions = {}): SyncAdapter {
  const hlcField = opts.hlcField ?? 'changed'
  let schema: SyncSchema | null = null

  function s(): SyncSchema {
    if (!schema) throw new Error('pgAdapter: call ensureSyncTables first')
    return schema
  }

  function tbl(model: string): string {
    const def = s()[model]
    if (!def) throw new Error(`pgAdapter: unknown model "${model}"`)
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

  /**
   * node-postgres serializes a raw JS array as a Postgres array literal
   * (`{a,b}`), which a JSONB column rejects. For fields typed `json` we
   * JSON.stringify objects/arrays ourselves so the driver sends a string
   * that JSONB can parse.
   */
  function serializeValue(model: string, col: string, v: unknown): unknown {
    if (v === null || v === undefined) return v
    const def = s()[model]?.fields[col]
    if (def?.type !== 'json') return v
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  }

  /**
   * node-postgres returns NUMERIC as a string to preserve precision. For
   * `number`-typed schema fields that's surprising (the client gets `"157"`
   * instead of `157` and `a + b` becomes string concat). Similarly JSONB
   * sometimes round-trips as a pre-parsed object and sometimes as a string —
   * depends on the driver build. Normalize both here so callers always get the
   * declared schema type.
   */
  function deserializeRow<T extends Record<string, unknown>>(
    model: string,
    row: T,
  ): T {
    const def = s()[model]
    if (!def) return row
    const out = { ...row } as Record<string, unknown>
    for (const [col, field] of Object.entries(def.fields)) {
      const v = out[col]
      if (v === null || v === undefined) continue
      if (field.type === 'number' && typeof v === 'string') {
        const n = Number(v)
        if (!Number.isNaN(n)) out[col] = n
      } else if (field.type === 'json' && typeof v === 'string') {
        try {
          out[col] = JSON.parse(v)
        } catch {
          /* leave as-is if unparseable */
        }
      } else if (field.type === 'boolean' && typeof v !== 'boolean') {
        out[col] = v === true || v === 'true' || v === 1 || v === '1' || v === 't'
      }
    }
    return out as T
  }

  function deserializeRows<T extends Record<string, unknown>>(
    model: string,
    rows: T[],
  ): T[] {
    return rows.map((r) => deserializeRow(model, r))
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

  function makeAdapter(conn: PgQueryable, isTransaction = false): SyncAdapter {
    async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await conn.query<T & Record<string, unknown>>(sql, params)
      return result.rows as T[]
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
          await conn.query(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`)
          if (hasHlc(modelKey)) {
            await conn.query(
              `CREATE INDEX IF NOT EXISTS "idx_${table}_sync" ON "${table}" ("${hlcField}", "${pkName}")`,
            )
          }
        }
        await conn.query(`
          CREATE TABLE IF NOT EXISTS "${TOMBSTONE_TABLE}" (
            model TEXT NOT NULL,
            id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            scope JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model, id)
          )
        `)
        await conn.query(
          `CREATE INDEX IF NOT EXISTS "idx_tombstones_hlc" ON "${TOMBSTONE_TABLE}" (hlc)`,
        )
        await conn.query(`
          CREATE TABLE IF NOT EXISTS "${OPERATION_TABLE}" (
            model TEXT NOT NULL,
            op_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model, op_id)
          )
        `)
      },

      async create({ model, data }) {
        const table = tbl(model)
        const cols = allCols(model)
        const colStr = cols.map((c) => `"${c}"`).join(', ')
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
        const values = cols.map((c) => serializeValue(model, c, data[c] ?? null))
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
          params.push(serializeValue(model, k, v))
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
        return rows[0] ? deserializeRow(model, rows[0]) : null
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
        const rows = await q(sql, w.params)
        return deserializeRows(model, rows)
      },

      async count({ model, where }) {
        const table = tbl(model)
        const w = whereClause(where)
        const rows = await q<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${w.sql}`,
          w.params,
        )
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
        const result: FindChangedSinceResult = { rows: deserializeRows(model, page) }
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
        const values = cols.map((c) => serializeValue(model, c, row[c] ?? null))
        const updateSet = cols
          .filter((c) => c !== pkName)
          .map((c) => `"${c}" = EXCLUDED."${c}"`)
          .join(', ')

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

      async findTombstonesSince(
        params: FindTombstonesSinceParams,
      ): Promise<FindTombstonesSinceResult> {
        const { model, sinceHlc, limit: lim, cursor, scope } = params
        const conditions = ['model = $1']
        const values: unknown[] = [model]
        let index = 2
        if (scope && Object.keys(scope).length > 0) {
          conditions.push(`scope @> $${index++}::jsonb`)
          values.push(JSON.stringify(scope))
        }
        if (cursor) {
          conditions.push(`(hlc, id) > ($${index}, $${index + 1})`)
          values.push(cursor.hlc, cursor.id)
        } else {
          conditions.push(`hlc > $${index}`)
          values.push(sinceHlc)
        }
        const rows = await q(
          `SELECT * FROM "${TOMBSTONE_TABLE}" WHERE ${conditions.join(' AND ')} ORDER BY hlc ASC, id ASC LIMIT ${lim + 1}`,
          values,
        )
        const hasMore = rows.length > lim
        const page = hasMore ? rows.slice(0, lim) : rows
        const result: FindTombstonesSinceResult = { tombstones: page.map(toTombstone) }
        if (hasMore && page.length > 0) {
          const last = page[page.length - 1]!
          result.nextCursor = { hlc: String(last.hlc), id: String(last.id) }
        }
        return result
      },

      async claimOperation({ model, opId }) {
        const rows = await q(
          `INSERT INTO "${OPERATION_TABLE}" (model, op_id) VALUES ($1, $2)
           ON CONFLICT (model, op_id) DO NOTHING
           RETURNING op_id`,
          [model, opId],
        )
        return rows.length > 0
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
          // Already in a transaction — just run inline.
          return fn(adapter)
        }
        const client = await (pool as PgPoolLike).connect()
        try {
          await client.query('BEGIN')
          const txAdapter = makeAdapter(client, true)
          const orig = txAdapter.ensureSyncTables
          txAdapter.ensureSyncTables = async () => {}
          try {
            const result = await fn(txAdapter)
            await client.query('COMMIT')
            return result
          } catch (err) {
            await client.query('ROLLBACK')
            throw err
          } finally {
            txAdapter.ensureSyncTables = orig
          }
        } finally {
          client.release()
        }
      },
    }

    return adapter
  }

  return columnMappingAdapter(makeAdapter(pool), hlcField)
}

function sqlType(type: string | readonly string[]): string {
  if (Array.isArray(type)) return 'TEXT'
  switch (type) {
    case 'string':
      return 'TEXT'
    case 'number':
      return 'NUMERIC'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'TEXT'
    case 'json':
      return 'JSONB'
    default:
      return 'TEXT'
  }
}

function toTombstone(row: Row): Tombstone {
  return {
    model: String(row.model),
    id: String(row.id),
    hlc: String(row.hlc),
    scope: typeof row.scope === 'string' ? JSON.parse(row.scope) : ((row.scope as Scope) ?? {}),
  }
}
