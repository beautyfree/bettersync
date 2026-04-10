/**
 * SyncSchema DSL — better-auth-style schema declaration for sync models.
 *
 * Users describe their models as a plain TypeScript object with `fields`,
 * `scope`, and access-control flags. The framework reads this metadata
 * to generate migrations, validate wire data, enforce tenancy, and route
 * sync operations.
 *
 * @see ModelDef, FieldDef, defineSchema
 */

import { SchemaViolationError } from './errors'
import type { Row, Scope } from './types'

/**
 * Supported field data types. Adapters map these to native column types.
 *
 * Enum types are declared as a readonly array of literal strings, e.g.
 * `type: ['draft', 'published'] as const`.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'json'
  | readonly string[]

export interface FieldReference {
  model: string
  field: string
  onDelete?: 'cascade' | 'restrict' | 'set null' | 'no action'
}

/**
 * Field-level definition. Mirrors the better-auth pattern with sync-specific extensions.
 */
export interface FieldDef {
  type: FieldType
  /** True (default) means the field is required on writes. */
  required?: boolean
  /** True means the field has a unique constraint. */
  unique?: boolean
  /** True if this is the primary key. Exactly one field per model must have this. */
  primaryKey?: boolean
  /** Default value, or a thunk for dynamic defaults (e.g. `() => new Date()`). */
  defaultValue?: unknown | (() => unknown)
  /** Foreign key reference. */
  references?: FieldReference
  /** False means clients cannot set this field on writes (server-computed). */
  input?: boolean
  /** False means this field is never sent to clients (server-only secret). */
  output?: boolean
  /**
   * False means this field is local-only and never participates in sync.
   * Useful for client-only UI state (e.g. `isDraft`, `unreadBadge`).
   */
  sync?: boolean
}

/**
 * Model definition. The shape of a single sync table.
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export interface ModelDef<Ctx = any> {
  /** Database table name. Defaults to the object key in SyncSchema. */
  modelName?: string
  /** Field definitions, keyed by field name. */
  fields: Record<string, FieldDef>
  /** Schema version. Bump when shape changes. Used for client-side migrations. */
  version?: number
  /** Per-version row migration callbacks (v → row → row). */
  migrations?: Record<number, (row: Row) => Row>
  /** Multi-tenant scope filter. Returns predicate columns extracted from ctx. */
  scope?: (ctx: Ctx) => Scope
  /** Whether clients are allowed to insert. Default: true. */
  clientCanCreate?: boolean
  /** Whether clients are allowed to update. Default: true. */
  clientCanUpdate?: boolean
  /** Whether clients are allowed to delete. Default: true. */
  clientCanDelete?: boolean
  /** Skip auto-migration generation for this model. */
  disableMigration?: boolean
}

/**
 * A complete sync schema. Map of model key → model definition.
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export type SyncSchema<Ctx = any> = Record<string, ModelDef<Ctx>>

/** Field names that are reserved by the sync engine for internal use. */
export const RESERVED_FIELDS = new Set(['__sync_meta'])

/**
 * Define a sync schema. Validates the schema and returns it.
 *
 * @throws SchemaViolationError if the schema is malformed.
 */
// biome-ignore lint/suspicious/noExplicitAny: caller-defined ctx shape
export function defineSchema<Ctx = any>(schema: SyncSchema<Ctx>): SyncSchema<Ctx> {
  validateSchema(schema)
  return schema
}

/**
 * Validate a schema. Throws on the first violation.
 */
export function validateSchema(schema: SyncSchema): void {
  const modelKeys = Object.keys(schema)
  if (modelKeys.length === 0) {
    throw new SchemaViolationError('SyncSchema must contain at least one model')
  }

  for (const modelKey of modelKeys) {
    const def = schema[modelKey]
    if (!def) continue
    validateModel(modelKey, def, schema)
  }
}

function validateModel(modelKey: string, def: ModelDef, allModels: SyncSchema): void {
  if (!def.fields || Object.keys(def.fields).length === 0) {
    throw new SchemaViolationError(
      `Model "${modelKey}" must declare at least one field`,
      undefined,
      `${modelKey}.fields`,
    )
  }

  let primaryKeyCount = 0
  for (const fieldName of Object.keys(def.fields)) {
    if (RESERVED_FIELDS.has(fieldName)) {
      throw new SchemaViolationError(
        `Field name "${fieldName}" is reserved by the sync engine on model "${modelKey}"`,
        'Reserved field names: changed, __sync_meta. Pick a different name.',
        `${modelKey}.fields.${fieldName}`,
      )
    }
    const field = def.fields[fieldName]
    if (!field) continue
    validateField(modelKey, fieldName, field, allModels)
    if (field.primaryKey) primaryKeyCount += 1
  }

  if (primaryKeyCount === 0) {
    throw new SchemaViolationError(
      `Model "${modelKey}" must have exactly one primary key field, found 0`,
      'Add `primaryKey: true` to your id field.',
      `${modelKey}.fields`,
    )
  }
  if (primaryKeyCount > 1) {
    throw new SchemaViolationError(
      `Model "${modelKey}" has ${primaryKeyCount} primary keys, must have exactly one`,
      undefined,
      `${modelKey}.fields`,
    )
  }
}

const VALID_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'json',
])

function validateField(
  modelKey: string,
  fieldName: string,
  field: FieldDef,
  allModels: SyncSchema,
): void {
  const path = `${modelKey}.fields.${fieldName}`
  const fieldType: FieldType = field.type
  if (typeof fieldType === 'string') {
    if (!VALID_PRIMITIVE_TYPES.has(fieldType)) {
      throw new SchemaViolationError(
        `${path}.type must be one of: string, number, boolean, date, json, or a string enum array`,
        undefined,
        path,
      )
    }
  } else if (Array.isArray(fieldType)) {
    if (fieldType.length === 0) {
      throw new SchemaViolationError(
        `${path}.type enum must have at least one variant`,
        undefined,
        path,
      )
    }
    for (const variant of fieldType) {
      if (typeof variant !== 'string') {
        throw new SchemaViolationError(
          `${path}.type enum variants must be strings`,
          undefined,
          path,
        )
      }
    }
  } else {
    throw new SchemaViolationError(
      `${path}.type must be a string or string enum array`,
      undefined,
      path,
    )
  }
  if (field.references) {
    const refModel = field.references.model
    if (!(refModel in allModels)) {
      throw new SchemaViolationError(
        `${path}.references.model "${refModel}" does not exist in schema`,
        'Make sure the referenced model is declared in the same schema.',
        path,
      )
    }
    const refModelDef = allModels[refModel]
    if (refModelDef && !(field.references.field in refModelDef.fields)) {
      throw new SchemaViolationError(
        `${path}.references.field "${field.references.field}" does not exist on model "${refModel}"`,
        undefined,
        path,
      )
    }
  }
}

/**
 * Get the actual database table name for a model.
 */
export function getModelTableName(modelKey: string, def: ModelDef): string {
  return def.modelName ?? modelKey
}

/**
 * Get the primary key field name for a model.
 *
 * @throws SchemaViolationError if no primary key is declared.
 */
export function getPrimaryKey(modelKey: string, def: ModelDef): string {
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.primaryKey) return name
  }
  throw new SchemaViolationError(
    `Model "${modelKey}" has no primary key field`,
    'Add `primaryKey: true` to your id field.',
  )
}
