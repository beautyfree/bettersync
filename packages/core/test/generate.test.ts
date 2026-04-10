import { describe, expect, it } from 'vitest'
import {
  buildColumnMapping,
  columnsToRow,
  defineSchema,
  formatSQL,
  generateSQL,
  getColumnName,
  rowToColumns,
} from '../src/index'

const schema = defineSchema({
  project: {
    modelName: 'projects',
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string', columnName: 'user_id' },
      title: { type: 'string' },
      description: { type: 'string', required: false },
      status: { type: ['draft', 'active', 'archived'] as const },
      createdAt: { type: 'date', columnName: 'created_at', input: false },
      changed: { type: 'string' },
    },
  },
  task: {
    modelName: 'tasks',
    fields: {
      id: { type: 'string', primaryKey: true },
      projectId: { type: 'string', columnName: 'project_id', references: { model: 'project', field: 'id' } },
      title: { type: 'string' },
      done: { type: 'boolean', required: false },
      metadata: { type: 'json', required: false },
      changed: { type: 'string' },
    },
  },
})

describe('getColumnName', () => {
  it('returns columnName when set', () => {
    expect(getColumnName('userId', schema.project!)).toBe('user_id')
    expect(getColumnName('createdAt', schema.project!)).toBe('created_at')
    expect(getColumnName('projectId', schema.task!)).toBe('project_id')
  })

  it('returns field key when no columnName', () => {
    expect(getColumnName('title', schema.project!)).toBe('title')
    expect(getColumnName('id', schema.project!)).toBe('id')
  })
})

describe('buildColumnMapping', () => {
  it('builds bidirectional mapping', () => {
    const mapping = buildColumnMapping(schema.project!)
    expect(mapping.hasCustomMapping).toBe(true)
    expect(mapping.toColumn.userId).toBe('user_id')
    expect(mapping.toColumn.createdAt).toBe('created_at')
    expect(mapping.toColumn.title).toBe('title')
    expect(mapping.toField.user_id).toBe('userId')
    expect(mapping.toField.created_at).toBe('createdAt')
  })

  it('hasCustomMapping is false when no columnName set', () => {
    const noMapping = defineSchema({
      simple: {
        fields: {
          id: { type: 'string', primaryKey: true },
          name: { type: 'string' },
          changed: { type: 'string' },
        },
      },
    })
    const mapping = buildColumnMapping(noMapping.simple!)
    expect(mapping.hasCustomMapping).toBe(false)
  })
})

describe('rowToColumns / columnsToRow', () => {
  const mapping = buildColumnMapping(schema.project!)

  it('translates JS field names to DB column names', () => {
    const row = { id: '1', userId: 'u1', title: 'Hi', createdAt: '2024-01-01' }
    const cols = rowToColumns(row, mapping)
    expect(cols.user_id).toBe('u1')
    expect(cols.created_at).toBe('2024-01-01')
    expect(cols.title).toBe('Hi')
    expect(cols.userId).toBeUndefined()
  })

  it('translates DB column names back to JS field names', () => {
    const dbRow = { id: '1', user_id: 'u1', title: 'Hi', created_at: '2024-01-01' }
    const jsRow = columnsToRow(dbRow, mapping)
    expect(jsRow.userId).toBe('u1')
    expect(jsRow.createdAt).toBe('2024-01-01')
    expect(jsRow.user_id).toBeUndefined()
  })

  it('is a no-op when no custom mapping', () => {
    const noCustom = buildColumnMapping(
      defineSchema({
        x: { fields: { id: { type: 'string', primaryKey: true }, changed: { type: 'string' } } },
      }).x!,
    )
    const row = { id: '1', name: 'test' }
    expect(rowToColumns(row, noCustom)).toBe(row) // same reference
    expect(columnsToRow(row, noCustom)).toBe(row)
  })

  it('roundtrips correctly', () => {
    const row = { id: '1', userId: 'u1', title: 'Hi', createdAt: '2024-01-01', changed: 'abc' }
    const cols = rowToColumns(row, mapping)
    const back = columnsToRow(cols, mapping)
    expect(back).toEqual(row)
  })
})

describe('generateSQL — CREATE TABLE mode', () => {
  it('generates CREATE TABLE for each model + tombstones', () => {
    const stmts = generateSQL(schema)
    const sql = stmts.join('\n')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "projects"')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tasks"')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "sync_tombstones"')
  })

  it('uses columnName in CREATE TABLE', () => {
    const stmts = generateSQL(schema)
    const sql = stmts.join('\n')
    expect(sql).toContain('"user_id" TEXT NOT NULL')
    expect(sql).toContain('"created_at" TIMESTAMPTZ')
    expect(sql).toContain('"project_id" TEXT NOT NULL')
  })

  it('maps field types to SQL types', () => {
    const stmts = generateSQL(schema)
    const sql = stmts.join('\n')
    expect(sql).toContain('BOOLEAN')
    expect(sql).toContain('JSONB')
    expect(sql).toContain('TIMESTAMPTZ')
  })

  it('creates sync indexes', () => {
    const stmts = generateSQL(schema)
    const sql = stmts.join('\n')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_projects_sync"')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_tasks_sync"')
  })
})

describe('generateSQL — ALTER TABLE mode', () => {
  it('generates ALTER TABLE ADD COLUMN for HLC', () => {
    const stmts = generateSQL(schema, { alter: true })
    const sql = stmts.join('\n')
    expect(sql).toContain('ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "changed" TEXT')
    expect(sql).toContain('ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "changed" TEXT')
    expect(sql).toContain('ALTER TABLE "projects" ALTER COLUMN "changed" SET NOT NULL')
  })

  it('includes backfill when option set', () => {
    const stmts = generateSQL(schema, {
      alter: true,
      backfillHlc: '0190a1b2c3d40000deadbeef',
    })
    const sql = stmts.join('\n')
    expect(sql).toContain("UPDATE \"projects\" SET \"changed\" = '0190a1b2c3d40000deadbeef'")
    expect(sql).toContain("UPDATE \"tasks\" SET \"changed\" = '0190a1b2c3d40000deadbeef'")
  })

  it('still creates tombstone table (internal)', () => {
    const stmts = generateSQL(schema, { alter: true })
    const sql = stmts.join('\n')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "sync_tombstones"')
  })
})

describe('formatSQL', () => {
  it('adds header comment', () => {
    const stmts = generateSQL(schema)
    const formatted = formatSQL(stmts)
    expect(formatted).toContain('-- Generated by bettersync')
    expect(formatted).toContain('CREATE TABLE')
  })
})
