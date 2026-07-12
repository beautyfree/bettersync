import type {
  AdapterCapabilities,
  BatchUpsertResult,
  FindChangedSinceParams,
  FindChangedSinceResult,
  FindTombstonesSinceParams,
  FindTombstonesSinceResult,
  SyncAdapter,
  UpsertResult,
} from './adapter'
import type { Tombstone } from './protocol'
import type { ModelDef, SyncSchema } from './schema'
import type { Row, SortBy, Where } from './types'

/**
 * Maps sync's logical field names to physical database columns around a raw
 * adapter. Raw adapters can therefore keep simple SQL while callers use the
 * schema's TypeScript names everywhere.
 *
 * The HLC field must keep its physical name unless the raw adapter itself is
 * configured with that physical name. Failing closed here prevents rows being
 * written with a second, unsynchronised clock column.
 */
export function columnMappingAdapter(base: SyncAdapter, hlcField = 'changed'): SyncAdapter {
  let schema: SyncSchema | null = null

  function definition(model: string): ModelDef {
    const def = schema?.[model]
    if (!def) throw new Error(`columnMappingAdapter: unknown model "${model}"`)
    return def
  }

  function column(model: string, field: string): string {
    return definition(model).fields[field]?.columnName ?? field
  }

  function toPhysicalRow(model: string, row: Row): Row {
    const mapped: Row = {}
    for (const [field, value] of Object.entries(row)) mapped[column(model, field)] = value
    return mapped
  }

  function fromPhysicalRow(model: string, row: Row): Row {
    const def = definition(model)
    const byColumn = new Map<string, string>()
    for (const [field, config] of Object.entries(def.fields)) {
      byColumn.set(config.columnName ?? field, field)
    }
    const mapped: Row = {}
    for (const [name, value] of Object.entries(row)) mapped[byColumn.get(name) ?? name] = value
    return mapped
  }

  function toPhysicalWhere(model: string, where: Where | undefined): Where | undefined {
    if (!where) return where
    const mapped: Where = {}
    for (const [field, value] of Object.entries(where)) mapped[column(model, field)] = value
    return mapped
  }

  function toPhysicalSort(model: string, sortBy: SortBy | undefined): SortBy | undefined {
    if (!sortBy) return sortBy
    const mapped: SortBy = {}
    for (const [field, direction] of Object.entries(sortBy)) mapped[column(model, field)] = direction
    return mapped
  }

  function physicalSchema(logical: SyncSchema): SyncSchema {
    const mapped: SyncSchema = {}
    for (const [model, def] of Object.entries(logical)) {
      const fields: ModelDef['fields'] = {}
      for (const [field, config] of Object.entries(def.fields)) {
        const physical = config.columnName ?? field
        if (field === hlcField && physical !== hlcField) {
          throw new Error(
            `columnMappingAdapter: "${model}.${field}" maps to "${physical}". ` +
              'Configure the raw adapter with that physical hlcField before enabling this mapping.',
          )
        }
        fields[physical] = { ...config, columnName: undefined }
      }
      mapped[model] = { ...def, fields }
    }
    return mapped
  }

  function wrap(raw: SyncAdapter): SyncAdapter {
    return {
      capabilities: raw.capabilities as AdapterCapabilities,
      async ensureSyncTables(nextSchema) {
        schema = nextSchema
        await raw.ensureSyncTables(physicalSchema(nextSchema))
      },
      async create({ model, data }) {
        return fromPhysicalRow(model, await raw.create({ model, data: toPhysicalRow(model, data) }))
      },
      async update({ model, where, update }) {
        const result = await raw.update({
          model,
          where: toPhysicalWhere(model, where)!,
          update: toPhysicalRow(model, update),
        })
        return result ? fromPhysicalRow(model, result) : null
      },
      async delete({ model, where }) {
        await raw.delete({ model, where: toPhysicalWhere(model, where)! })
      },
      async findOne({ model, where }) {
        const result = await raw.findOne({ model, where: toPhysicalWhere(model, where)! })
        return result ? fromPhysicalRow(model, result) : null
      },
      async findMany({ model, where, limit, offset, sortBy }) {
        const rows = await raw.findMany({
          model,
          ...(where ? { where: toPhysicalWhere(model, where) } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(sortBy ? { sortBy: toPhysicalSort(model, sortBy) } : {}),
        })
        return rows.map((row) => fromPhysicalRow(model, row))
      },
      async count({ model, where }) {
        return raw.count({ model, ...(where ? { where: toPhysicalWhere(model, where) } : {}) })
      },
      async findChangedSince(params: FindChangedSinceParams): Promise<FindChangedSinceResult> {
        const result = await raw.findChangedSince({
          ...params,
          ...(params.scope ? { scope: toPhysicalWhere(params.model, params.scope) } : {}),
        })
        return { ...result, rows: result.rows.map((row) => fromPhysicalRow(params.model, row)) }
      },
      async upsertIfNewer({ model, row }): Promise<UpsertResult> {
        return raw.upsertIfNewer({ model, row: toPhysicalRow(model, row) })
      },
      ...(raw.batchUpsertIfNewer
        ? {
            async batchUpsertIfNewer({ model, rows }: { model: string; rows: Row[] }): Promise<BatchUpsertResult> {
              return raw.batchUpsertIfNewer!({ model, rows: rows.map((row) => toPhysicalRow(model, row)) })
            },
          }
        : {}),
      findTombstonesSince(params: FindTombstonesSinceParams): Promise<FindTombstonesSinceResult> {
        return raw.findTombstonesSince(params)
      },
      upsertTombstoneIfNewer(tombstone: Tombstone): Promise<boolean> {
        return raw.upsertTombstoneIfNewer(tombstone)
      },
      claimOperation: (params) => raw.claimOperation(params),
      gcTombstones: (params) => raw.gcTombstones(params),
      transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))),
    }
  }

  return wrap(base)
}
