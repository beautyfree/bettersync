import { describe, expect, it } from 'vitest'
import {
  defineSchema,
  getModelTableName,
  getPrimaryKey,
  RESERVED_FIELDS,
  SchemaViolationError,
  validateSchema,
} from '../src/index'

describe('defineSchema validation', () => {
  it('accepts a minimal valid schema', () => {
    const schema = defineSchema({
      project: {
        fields: {
          id: { type: 'string', primaryKey: true },
          title: { type: 'string' },
        },
      },
    })
    expect(schema.project).toBeDefined()
  })

  it('accepts schema with all field types', () => {
    expect(() =>
      defineSchema({
        item: {
          fields: {
            id: { type: 'string', primaryKey: true },
            name: { type: 'string' },
            count: { type: 'number' },
            active: { type: 'boolean' },
            createdAt: { type: 'date' },
            metadata: { type: 'json' },
            status: { type: ['draft', 'published'] as const },
          },
        },
      }),
    ).not.toThrow()
  })

  it('rejects schema with no models', () => {
    expect(() => validateSchema({})).toThrow(SchemaViolationError)
  })

  it('rejects model with no fields', () => {
    expect(() =>
      validateSchema({
        empty: { fields: {} },
      }),
    ).toThrow(SchemaViolationError)
  })

  it('rejects model without a primary key', () => {
    expect(() =>
      validateSchema({
        bad: { fields: { name: { type: 'string' } } },
      }),
    ).toThrow(/primary key/i)
  })

  it('rejects model with multiple primary keys', () => {
    expect(() =>
      validateSchema({
        bad: {
          fields: {
            a: { type: 'string', primaryKey: true },
            b: { type: 'string', primaryKey: true },
          },
        },
      }),
    ).toThrow(/2 primary keys/)
  })

  it('rejects reserved field names', () => {
    for (const reserved of RESERVED_FIELDS) {
      expect(() =>
        validateSchema({
          bad: {
            fields: {
              id: { type: 'string', primaryKey: true },
              [reserved]: { type: 'string' },
            },
          },
        }),
      ).toThrow(/reserved/)
    }
  })

  it('rejects empty enum array', () => {
    expect(() =>
      validateSchema({
        bad: {
          fields: {
            id: { type: 'string', primaryKey: true },
            status: { type: [] as readonly string[] },
          },
        },
      }),
    ).toThrow(/enum.*at least one variant/i)
  })

  it('rejects unknown primitive type', () => {
    expect(() =>
      validateSchema({
        bad: {
          fields: {
            id: { type: 'string', primaryKey: true },
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
            x: { type: 'integer' as any },
          },
        },
      }),
    ).toThrow(/must be one of/)
  })

  it('rejects references to nonexistent model', () => {
    expect(() =>
      validateSchema({
        post: {
          fields: {
            id: { type: 'string', primaryKey: true },
            authorId: {
              type: 'string',
              references: { model: 'user', field: 'id' },
            },
          },
        },
      }),
    ).toThrow(/does not exist/)
  })

  it('rejects references to nonexistent field on existing model', () => {
    expect(() =>
      validateSchema({
        user: { fields: { id: { type: 'string', primaryKey: true } } },
        post: {
          fields: {
            id: { type: 'string', primaryKey: true },
            authorId: {
              type: 'string',
              references: { model: 'user', field: 'nonexistent' },
            },
          },
        },
      }),
    ).toThrow(/does not exist/)
  })

  it('accepts valid cross-model reference', () => {
    expect(() =>
      defineSchema({
        user: { fields: { id: { type: 'string', primaryKey: true } } },
        post: {
          fields: {
            id: { type: 'string', primaryKey: true },
            authorId: {
              type: 'string',
              references: { model: 'user', field: 'id', onDelete: 'cascade' },
            },
          },
        },
      }),
    ).not.toThrow()
  })
})

describe('helpers', () => {
  it('getModelTableName uses modelName when provided', () => {
    expect(
      getModelTableName('project', {
        modelName: 'projects',
        fields: { id: { type: 'string', primaryKey: true } },
      }),
    ).toBe('projects')
  })

  it('getModelTableName falls back to model key', () => {
    expect(
      getModelTableName('project', {
        fields: { id: { type: 'string', primaryKey: true } },
      }),
    ).toBe('project')
  })

  it('getPrimaryKey returns the pk field name', () => {
    expect(
      getPrimaryKey('project', {
        fields: {
          id: { type: 'string', primaryKey: true },
          title: { type: 'string' },
        },
      }),
    ).toBe('id')
  })

  it('getPrimaryKey throws when no pk', () => {
    expect(() =>
      getPrimaryKey('bad', {
        fields: { title: { type: 'string' } },
      }),
    ).toThrow(SchemaViolationError)
  })
})
