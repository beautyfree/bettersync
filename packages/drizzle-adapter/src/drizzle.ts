/**
 * Drizzle adapter — better-auth style.
 *
 * Takes actual Drizzle table objects. Uses Drizzle query builder for
 * CRUD (type-safe, column mapping is free). Raw SQL only for
 * ON CONFLICT ... WHERE (upsertIfNewer) which Drizzle can't express.
 *
 * Usage:
 *   import { projects, tasks } from './db/schema'
 *   drizzleAdapter(db, {
 *     schema: { project: projects, task: tasks },
 *   })
 */

import {
  type AdapterCapabilities,
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type Row,
  type Scope,
  type SyncAdapter,
  type Tombstone,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '@bettersync/core'
import {
  and,
  asc,
  count as countFn,
  eq,
  sql,
  type SQL,
} from 'drizzle-orm'
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTable } from 'drizzle-orm/pg-core'

const CAPABILITIES: AdapterCapabilities = {
  adapterId: 'drizzle-pg',
  adapterName: 'Drizzle (Postgres)',
  supportsJSON: true,
  supportsDates: true,
  supportsBooleans: true,
  supportsNumericIds: true,
  supportsTransaction: true,
  supportsBatchInsert: true,
  supportsCompoundComparison: true,
}

export interface DrizzleAdapterConfig {
  /**
   * Map of model name → Drizzle table object.
   * Column mapping comes for free from Drizzle definitions.
   */
  schema: Record<string, PgTable>
  /** HLC field key in the table. Default: 'changed'. */
  hlcField?: string
  /** Tombstone table name. Default: 'sync_tombstones'. */
  tombstoneTable?: string
}

type DbLike = NodePgDatabase<Record<string, never>>

export function drizzleAdapter(db: DbLike, config: DrizzleAdapterConfig): SyncAdapter {
  const hlcField = config.hlcField ?? 'changed'
  const tombTbl = config.tombstoneTable ?? 'sync_tombstones'

  function tbl(model: string): PgTable {
    const t = config.schema[model]
    if (!t) throw new Error(`drizzleAdapter: model "${model}" not in schema`)
    return t
  }

  function cols(model: string) {
    return getTableColumns(tbl(model))
  }

  function pkCol(model: string) {
    const c = cols(model)
    for (const col of Object.values(c)) {
      if ((col as { primary?: boolean }).primary) return col
    }
    if ('id' in c) return c.id!
    throw new Error(`drizzleAdapter: no PK on "${model}"`)
  }

  function hlcCol(model: string) {
    const c = cols(model)
    if (hlcField in c) return c[hlcField]!
    throw new Error(`drizzleAdapter: HLC field "${hlcField}" not on "${model}"`)
  }

  function colName(col: unknown): string {
    return (col as { name: string }).name
  }

  /** Build Drizzle WHERE from flat key-value object */
  function whereEq(model: string, where?: Record<string, unknown>): SQL | undefined {
    if (!where || Object.keys(where).length === 0) return undefined
    const c = cols(model)
    const parts: SQL[] = []
    for (const [key, value] of Object.entries(where)) {
      if (key in c) parts.push(eq(c[key]!, value))
    }
    return parts.length ? and(...parts) : undefined
  }

  function makeAdapter(conn: DbLike): SyncAdapter {
    const adapter: SyncAdapter = {
      capabilities: CAPABILITIES,

      async ensureSyncTables() {
        // User tables are managed by Drizzle migrations.
        // We create sync-internal tables + indexes.
        await conn.execute(sql.raw(`
          CREATE TABLE IF NOT EXISTS "${tombTbl}" (
            model TEXT NOT NULL, id TEXT NOT NULL, hlc TEXT NOT NULL,
            scope JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model, id)
          )
        `))
        await conn.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "idx_${tombTbl}_hlc" ON "${tombTbl}" (hlc)`))

        for (const modelKey of Object.keys(config.schema)) {
          const table = tbl(modelKey)
          const tn = getTableName(table)
          const pk = colName(pkCol(modelKey))
          const hlc = colName(hlcCol(modelKey))
          await conn.execute(sql.raw(`CREATE INDEX IF NOT EXISTS "idx_${tn}_sync" ON "${tn}" ("${hlc}", "${pk}")`))
        }
      },

      // ─── CRUD via Drizzle query builder ─────────────────────

      async create({ model, data }) {
        const table = tbl(model)
        const result = await conn.insert(table).values(data as Record<string, unknown>).returning()
        return (result[0] ?? data) as Row
      },

      async update({ model, where, update: patch }) {
        const table = tbl(model)
        const w = whereEq(model, where)
        const result = await conn.update(table).set(patch).where(w ?? sql`TRUE`).returning()
        return (result[0] as Row) ?? null
      },

      async delete({ model, where }) {
        const table = tbl(model)
        const w = whereEq(model, where)
        await conn.delete(table).where(w ?? sql`TRUE`)
      },

      async findOne({ model, where }) {
        const table = tbl(model)
        const w = whereEq(model, where)
        const rows = await conn.select().from(table).where(w ?? sql`TRUE`).limit(1)
        return (rows[0] as Row) ?? null
      },

      async findMany({ model, where, limit: lim, offset: off, sortBy }) {
        const table = tbl(model)
        const w = whereEq(model, where)
        let q = conn.select().from(table).where(w ?? sql`TRUE`).$dynamic()
        if (sortBy) {
          const c = cols(model)
          for (const [field] of Object.entries(sortBy)) {
            if (field in c) q = q.orderBy(asc(c[field]!))
          }
        }
        if (lim != null) q = q.limit(lim)
        if (off != null && off > 0) q = q.offset(off)
        return (await q) as Row[]
      },

      async count({ model, where }) {
        const table = tbl(model)
        const w = whereEq(model, where)
        const result = await conn.select({ count: countFn() }).from(table).where(w ?? sql`TRUE`)
        return result[0]?.count ?? 0
      },

      // ─── Sync-specific (raw SQL for compound ops) ──────────

      async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
        const { model, sinceHlc, limit: lim, cursor, scope } = params
        const tn = getTableName(tbl(model))
        const pk = colName(pkCol(model))
        const hlc = colName(hlcCol(model))
        const c = cols(model)

        const conds: string[] = []
        const vals: unknown[] = []
        let idx = 1

        if (scope) {
          for (const [key, value] of Object.entries(scope)) {
            if (key in c) {
              conds.push(`"${colName(c[key]!)}" = $${idx++}`)
              vals.push(value)
            }
          }
        }
        if (cursor) {
          conds.push(`("${hlc}", "${pk}") > ($${idx}, $${idx + 1})`)
          vals.push(cursor.hlc, cursor.id)
          idx += 2
        } else {
          conds.push(`"${hlc}" > $${idx++}`)
          vals.push(sinceHlc)
        }

        const where = conds.join(' AND ')
        const result = await conn.execute(
          paramSql(`SELECT * FROM "${tn}" WHERE ${where} ORDER BY "${hlc}" ASC, "${pk}" ASC LIMIT ${lim + 1}`, vals),
        )
        const rows = (result.rows ?? []) as Row[]
        const hasMore = rows.length > lim
        const page = hasMore ? rows.slice(0, lim) : rows

        // Map column names back to JS field names
        const colMap = cols(model)
        const mapped = page.map((row) => mapColumnsToFields(row, colMap))

        const out: FindChangedSinceResult = { rows: mapped }
        if (hasMore && page.length > 0) {
          const last = page[page.length - 1]!
          out.nextCursor = { hlc: String(last[hlc]), id: String(last[pk]) }
        }
        return out
      },

      async upsertIfNewer({ model, row }) {
        const tn = getTableName(tbl(model))
        const c = cols(model)
        const pk = colName(pkCol(model))
        const hlc = colName(hlcCol(model))

        // Map JS field names → SQL column values
        const colEntries = Object.entries(c)
        const id = row.id ?? row[pk]
        const rowHlc = row[hlcField] ?? row[hlc]
        if (!id || !rowHlc) throw new Error('upsertIfNewer: row must have id and HLC')

        // Resurrection check
        const tombResult = await conn.execute(
          sql`SELECT hlc FROM ${sql.identifier(tombTbl)} WHERE model = ${model} AND id = ${String(id)}`,
        )
        const tombHlc = ((tombResult.rows ?? []) as Row[])[0]?.hlc
        if (shouldDropAsResurrection(tombHlc ? String(tombHlc) : null, String(rowHlc))) return 'skipped'

        // Existence check
        const existing = await conn.select({ h: hlcCol(model) }).from(tbl(model)).where(eq(pkCol(model), id)).limit(1)
        const wasExisting = existing.length > 0

        // Build insert values (map JS keys → SQL columns)
        const sqlCols: string[] = []
        const sqlVals: unknown[] = []
        for (const [jsKey, col] of colEntries) {
          const cn = colName(col)
          sqlCols.push(`"${cn}"`)
          // Try JS key first, then SQL column name
          sqlVals.push(row[jsKey] ?? row[cn] ?? null)
        }
        const placeholders = sqlVals.map((_, i) => `$${i + 1}`)
        const updateSet = colEntries
          .filter(([, col]) => !(col as { primary?: boolean }).primary)
          .map(([, col]) => `"${colName(col)}" = EXCLUDED."${colName(col)}"`)
          .join(', ')

        const upsertResult = await conn.execute(paramSql(
          `INSERT INTO "${tn}" (${sqlCols.join(', ')}) VALUES (${placeholders.join(', ')})
           ON CONFLICT ("${pk}") DO UPDATE SET ${updateSet}
           WHERE "${tn}"."${hlc}" < EXCLUDED."${hlc}"
           RETURNING "${pk}"`,
          sqlVals,
        ))
        if ((upsertResult.rows ?? []).length === 0) return 'skipped'
        return wasExisting ? 'updated' : 'inserted'
      },

      async findTombstonesSince({ sinceHlc, limit: lim, scope }) {
        const q = scope && Object.keys(scope).length > 0
          ? sql`SELECT * FROM ${sql.identifier(tombTbl)} WHERE hlc > ${sinceHlc} AND scope @> ${JSON.stringify(scope)}::jsonb ORDER BY hlc ASC, id ASC LIMIT ${lim}`
          : sql`SELECT * FROM ${sql.identifier(tombTbl)} WHERE hlc > ${sinceHlc} ORDER BY hlc ASC, id ASC LIMIT ${lim}`
        const result = await conn.execute(q)
        return ((result.rows ?? []) as Row[]).map(toTombstone)
      },

      async upsertTombstoneIfNewer(t) {
        const existing = await conn.execute(
          sql`SELECT hlc FROM ${sql.identifier(tombTbl)} WHERE model = ${t.model} AND id = ${t.id}`,
        )
        const existingHlc = ((existing.rows ?? []) as Row[])[0]?.hlc
        if (!shouldApplyTombstone(existingHlc ? String(existingHlc) : null, t.hlc)) return false

        await conn.execute(
          sql`INSERT INTO ${sql.identifier(tombTbl)} (model, id, hlc, scope)
              VALUES (${t.model}, ${t.id}, ${t.hlc}, ${JSON.stringify(t.scope)}::jsonb)
              ON CONFLICT (model, id) DO UPDATE SET hlc = EXCLUDED.hlc, scope = EXCLUDED.scope
              WHERE ${sql.identifier(tombTbl)}.hlc < EXCLUDED.hlc`,
        )
        await conn.delete(tbl(t.model)).where(eq(pkCol(t.model), t.id))
        return true
      },

      async gcTombstones({ olderThanHlc }) {
        const result = await conn.execute(
          sql`WITH deleted AS (DELETE FROM ${sql.identifier(tombTbl)} WHERE hlc < ${olderThanHlc} RETURNING 1) SELECT COUNT(*)::int AS count FROM deleted`,
        )
        return ((result.rows ?? []) as Array<{ count: number }>)[0]?.count ?? 0
      },

      async transaction(fn) {
        return conn.transaction(async (tx) => {
          const txAdapter = makeAdapter(tx as unknown as DbLike)
          txAdapter.ensureSyncTables = async () => {}
          try { return await fn(txAdapter) }
          finally { txAdapter.ensureSyncTables = makeAdapter(conn).ensureSyncTables }
        })
      },
    }
    return adapter
  }

  return makeAdapter(db)
}

// ─── Helpers ────────────────────────────────────────────────────────

function toTombstone(row: Row): Tombstone {
  return {
    model: String(row.model),
    id: String(row.id),
    hlc: String(row.hlc),
    scope: typeof row.scope === 'string' ? JSON.parse(row.scope) : (row.scope as Scope) ?? {},
  }
}

function paramSql(query: string, params: unknown[]): SQL {
  const parts = query.split(/\$\d+/)
  const chunks: SQL[] = []
  for (let i = 0; i < parts.length; i++) {
    chunks.push(sql.raw(parts[i]!))
    if (i < params.length) chunks.push(sql`${params[i]}`)
  }
  return sql.join(chunks, sql.raw(''))
}

/** Map DB column names back to JS field names from a raw SQL result */
function mapColumnsToFields(row: Row, columns: Record<string, unknown>): Row {
  const result: Row = {}
  const colToField = new Map<string, string>()
  for (const [jsKey, col] of Object.entries(columns)) {
    const cn = (col as { name: string }).name
    colToField.set(cn, jsKey)
  }
  for (const [key, value] of Object.entries(row)) {
    const jsKey = colToField.get(key) ?? key
    result[jsKey] = value
  }
  return result
}
