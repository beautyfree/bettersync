/**
 * Drizzle + Postgres SyncAdapter.
 *
 * Uses Drizzle's sql tagged template for all queries — idiomatic,
 * parameterized, no string concatenation. Postgres-specific features:
 * - INSERT ... ON CONFLICT ... WHERE for atomic conditional upsert
 * - JSONB for tombstone scope storage
 * - (changed, id) compound comparison for cursor pagination
 */

import {
  type FindChangedSinceParams,
  type FindChangedSinceResult,
  type Row,
  type Scope,
  type SyncAdapter,
  type SyncSchema,
  type Tombstone,
  type AdapterCapabilities,
  getModelTableName,
  getPrimaryKey,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '@better-sync/core'
import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

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

const TOMBSTONE_TABLE = 'sync_tombstones'

export interface DrizzleAdapterOptions {
  hlcField?: string
}

type DbLike = NodePgDatabase<Record<string, never>>

export function drizzleAdapter(db: DbLike, opts: DrizzleAdapterOptions = {}): SyncAdapter {
  const hlcField = opts.hlcField ?? 'changed'
  let schema: SyncSchema | null = null

  function s(): SyncSchema {
    if (!schema) throw new Error('drizzleAdapter: call ensureSyncTables first')
    return schema
  }

  function tbl(model: string): string {
    const def = s()[model]
    if (!def) throw new Error(`drizzleAdapter: unknown model "${model}"`)
    return getModelTableName(model, def)
  }

  function pk(model: string): string {
    return getPrimaryKey(model, s()[model]!)
  }

  function fields(model: string): string[] {
    return Object.keys(s()[model]!.fields)
  }

  function ident(name: string) {
    return sql.identifier(name)
  }

  function whereSql(where: Record<string, unknown> | undefined): SQL {
    if (!where || Object.keys(where).length === 0) return sql`TRUE`
    const parts = Object.entries(where).map(([k, v]) => sql`${ident(k)} = ${v}`)
    return sql.join(parts, sql` AND `)
  }

  function buildInsert(table: string, row: Row, cols: string[]): SQL {
    const colList = sql.join(cols.map(c => ident(c)), sql`, `)
    const valList = sql.join(cols.map(c => sql`${row[c] ?? null}`), sql`, `)
    return sql`INSERT INTO ${ident(table)} (${colList}) VALUES (${valList})`
  }

  async function exec(dbConn: DbLike, q: SQL): Promise<Row[]> {
    const result = await dbConn.execute(q)
    return result.rows as Row[]
  }

  function makeAdapter(dbConn: DbLike): SyncAdapter {
    const adapter: SyncAdapter = {
      capabilities: CAPABILITIES,

      async ensureSyncTables(s_) {
        schema = s_
        for (const [modelKey, def] of Object.entries(s_)) {
          const table = getModelTableName(modelKey, def)
          const pkName = getPrimaryKey(modelKey, def)
          const colDefs: SQL[] = []
          for (const [name, f] of Object.entries(def.fields)) {
            const typ = sqlType(f.type)
            const parts = [ident(name), sql.raw(typ)]
            if (name === pkName) parts.push(sql.raw('PRIMARY KEY'))
            else if (f.required !== false) parts.push(sql.raw('NOT NULL'))
            colDefs.push(sql.join(parts, sql.raw(' ')))
          }
          // Only add HLC column if not already declared in field defs
          if (!(hlcField in def.fields)) {
            colDefs.push(sql.join([ident(hlcField), sql.raw('TEXT NOT NULL')], sql.raw(' ')))
          }
          const colsSql = sql.join(colDefs, sql.raw(', '))
          await dbConn.execute(sql`CREATE TABLE IF NOT EXISTS ${ident(table)} (${colsSql})`)
          await dbConn.execute(
            sql.raw(`CREATE INDEX IF NOT EXISTS "idx_${table}_sync" ON "${table}" ("${hlcField}", "${pkName}")`)
          )
        }
        // Tombstone table
        await dbConn.execute(sql.raw(`
          CREATE TABLE IF NOT EXISTS "${TOMBSTONE_TABLE}" (
            model TEXT NOT NULL,
            id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            scope JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (model, id)
          )
        `))
        await dbConn.execute(
          sql.raw(`CREATE INDEX IF NOT EXISTS "idx_tombstones_hlc" ON "${TOMBSTONE_TABLE}" (hlc)`)
        )
      },

      async create({ model, data }) {
        const table = tbl(model)
        const cols = [...new Set([...fields(model), hlcField])]
        const q = sql`${buildInsert(table, data, cols)} RETURNING *`
        const rows = await exec(dbConn, q)
        return rows[0] ?? data
      },

      async update({ model, where, update: patch }) {
        const table = tbl(model)
        const entries = Object.entries(patch)
        if (entries.length === 0) return null
        const sets = entries.map(([k, v]) => sql`${ident(k)} = ${v}`)
        const setSql = sql.join(sets, sql`, `)
        const rows = await exec(
          dbConn,
          sql`UPDATE ${ident(table)} SET ${setSql} WHERE ${whereSql(where)} RETURNING *`,
        )
        return rows[0] ?? null
      },

      async delete({ model, where }) {
        await exec(dbConn, sql`DELETE FROM ${ident(tbl(model))} WHERE ${whereSql(where)}`)
      },

      async findOne({ model, where }) {
        const rows = await exec(
          dbConn,
          sql`SELECT * FROM ${ident(tbl(model))} WHERE ${whereSql(where)} LIMIT 1`,
        )
        return rows[0] ?? null
      },

      async findMany({ model, where, limit: lim, offset: off, sortBy }) {
        let q = sql`SELECT * FROM ${ident(tbl(model))} WHERE ${whereSql(where)}`
        if (sortBy) {
          const order = Object.entries(sortBy).map(([k, dir]) =>
            sql`${ident(k)} ${sql.raw(dir.toUpperCase())}`,
          )
          q = sql`${q} ORDER BY ${sql.join(order, sql`, `)}`
        }
        if (lim != null) q = sql`${q} LIMIT ${lim}`
        if (off != null && off > 0) q = sql`${q} OFFSET ${off}`
        return exec(dbConn, q)
      },

      async count({ model, where }) {
        const rows = await exec(
          dbConn,
          sql`SELECT COUNT(*)::int AS count FROM ${ident(tbl(model))} WHERE ${whereSql(where)}`,
        )
        return ((rows[0] as { count: number })?.count) ?? 0
      },

      async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
        const { model, sinceHlc, limit: lim, cursor, scope } = params
        const table = tbl(model)
        const pkName = pk(model)
        const conditions: SQL[] = []

        if (scope) {
          for (const [k, v] of Object.entries(scope)) {
            conditions.push(sql`${ident(k)} = ${v}`)
          }
        }

        if (cursor) {
          conditions.push(
            sql`(${ident(hlcField)}, ${ident(pkName)}) > (${cursor.hlc}, ${cursor.id})`,
          )
        } else {
          conditions.push(sql`${ident(hlcField)} > ${sinceHlc}`)
        }

        const where = sql.join(conditions, sql` AND `)
        const fetchLimit = lim + 1
        const rows = await exec(
          dbConn,
          sql`SELECT * FROM ${ident(table)} WHERE ${where} ORDER BY ${ident(hlcField)} ASC, ${ident(pkName)} ASC LIMIT ${fetchLimit}`,
        )

        const hasMore = rows.length > lim
        const page = hasMore ? rows.slice(0, lim) : rows
        const result: FindChangedSinceResult = { rows: page }
        if (hasMore && page.length > 0) {
          const last = page[page.length - 1]!
          result.nextCursor = {
            hlc: String(last[hlcField]),
            id: String(last[pkName]),
          }
        }
        return result
      },

      async upsertIfNewer({ model, row }) {
        const table = tbl(model)
        const pkName = pk(model)
        const id = String(row[pkName])
        const rowHlc = String(row[hlcField])

        // Resurrection check
        const tombRows = await exec(
          dbConn,
          sql`SELECT hlc FROM ${ident(TOMBSTONE_TABLE)} WHERE model = ${model} AND id = ${id}`,
        )
        const tombHlc = tombRows.length > 0 ? String(tombRows[0]!.hlc) : null
        if (shouldDropAsResurrection(tombHlc, rowHlc)) return 'skipped'

        // Check existence for insert/update discrimination
        const existing = await exec(
          dbConn,
          sql`SELECT ${ident(hlcField)} FROM ${ident(table)} WHERE ${ident(pkName)} = ${id}`,
        )
        const wasExisting = existing.length > 0

        // Conditional upsert
        const cols = [...new Set([...fields(model), hlcField])]
        const colList = sql.join(cols.map(c => ident(c)), sql`, `)
        const valList = sql.join(cols.map(c => sql`${row[c] ?? null}`), sql`, `)
        const updateSet = sql.join(
          cols.filter(c => c !== pkName).map(c => sql`${ident(c)} = EXCLUDED.${ident(c)}`),
          sql`, `,
        )

        const upsertRows = await exec(
          dbConn,
          sql`INSERT INTO ${ident(table)} (${colList}) VALUES (${valList})
              ON CONFLICT (${ident(pkName)}) DO UPDATE SET ${updateSet}
              WHERE ${ident(table)}.${ident(hlcField)} < EXCLUDED.${ident(hlcField)}
              RETURNING ${ident(pkName)}`,
        )

        if (upsertRows.length === 0) return 'skipped'
        return wasExisting ? 'updated' : 'inserted'
      },

      async findTombstonesSince({ sinceHlc, limit: lim, scope }) {
        let q: SQL
        if (scope && Object.keys(scope).length > 0) {
          q = sql`SELECT * FROM ${ident(TOMBSTONE_TABLE)}
                  WHERE hlc > ${sinceHlc}
                  AND scope @> ${JSON.stringify(scope)}::jsonb
                  ORDER BY hlc ASC, id ASC LIMIT ${lim}`
        } else {
          q = sql`SELECT * FROM ${ident(TOMBSTONE_TABLE)}
                  WHERE hlc > ${sinceHlc}
                  ORDER BY hlc ASC, id ASC LIMIT ${lim}`
        }
        const rows = await exec(dbConn, q)
        return rows.map(toTombstone)
      },

      async upsertTombstoneIfNewer(t) {
        const existing = await exec(
          dbConn,
          sql`SELECT hlc FROM ${ident(TOMBSTONE_TABLE)} WHERE model = ${t.model} AND id = ${t.id}`,
        )
        const existingHlc = existing.length > 0 ? String(existing[0]!.hlc) : null
        if (!shouldApplyTombstone(existingHlc, t.hlc)) return false

        await exec(
          dbConn,
          sql`INSERT INTO ${ident(TOMBSTONE_TABLE)} (model, id, hlc, scope)
              VALUES (${t.model}, ${t.id}, ${t.hlc}, ${JSON.stringify(t.scope)}::jsonb)
              ON CONFLICT (model, id) DO UPDATE SET hlc = EXCLUDED.hlc, scope = EXCLUDED.scope
              WHERE ${ident(TOMBSTONE_TABLE)}.hlc < EXCLUDED.hlc`,
        )

        // Remove data row
        const table = tbl(t.model)
        const pkName = pk(t.model)
        await exec(dbConn, sql`DELETE FROM ${ident(table)} WHERE ${ident(pkName)} = ${t.id}`)
        return true
      },

      async gcTombstones({ olderThanHlc }) {
        const rows = await exec(
          dbConn,
          sql`WITH deleted AS (
            DELETE FROM ${ident(TOMBSTONE_TABLE)} WHERE hlc < ${olderThanHlc} RETURNING 1
          ) SELECT COUNT(*)::int AS count FROM deleted`,
        )
        return ((rows[0] as { count: number })?.count) ?? 0
      },

      async transaction(fn) {
        return dbConn.transaction(async (tx) => {
          const txAdapter = makeAdapter(tx as unknown as DbLike)
          // Share schema without re-running DDL
          const origEnsure = txAdapter.ensureSyncTables
          txAdapter.ensureSyncTables = async () => { /* no-op in tx */ }
          try {
            return await fn(txAdapter)
          } finally {
            txAdapter.ensureSyncTables = origEnsure
          }
        })
      },
    }

    return adapter
  }

  return makeAdapter(db)
}

// Helpers

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
