import { describe, expect, it } from 'vitest'
import {
  AdapterError,
  BatchTooLargeError,
  HLCOverflowError,
  isSyncError,
  ScopeViolationError,
  SchemaViolationError,
  StaleClientError,
  SyncError,
  UnauthorizedError,
} from '../src/index'

describe('isSyncError structural guard', () => {
  it('returns true for SyncError instances', () => {
    expect(isSyncError(new SyncError('TEST', 'message'))).toBe(true)
  })

  it('returns true for all subclass instances', () => {
    expect(isSyncError(new SchemaViolationError('msg'))).toBe(true)
    expect(isSyncError(new ScopeViolationError('msg'))).toBe(true)
    expect(isSyncError(new HLCOverflowError())).toBe(true)
    expect(isSyncError(new BatchTooLargeError(100, 50))).toBe(true)
    expect(isSyncError(new StaleClientError())).toBe(true)
    expect(isSyncError(new UnauthorizedError())).toBe(true)
    expect(isSyncError(new AdapterError('test', new Error('boom')))).toBe(true)
  })

  it('returns true for plain objects with the brand and required fields', () => {
    // Simulates a SyncError thrown across a duplicate copy of the module
    const fake = {
      __betterSyncError: true,
      code: 'FAKE_CODE',
      message: 'something',
    }
    expect(isSyncError(fake)).toBe(true)
  })

  it('returns false for plain Error', () => {
    expect(isSyncError(new Error('plain'))).toBe(false)
  })

  it('returns false for null and undefined', () => {
    expect(isSyncError(null)).toBe(false)
    expect(isSyncError(undefined)).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isSyncError('string')).toBe(false)
    expect(isSyncError(42)).toBe(false)
    expect(isSyncError(true)).toBe(false)
  })

  it('returns false for objects without the brand', () => {
    expect(isSyncError({ code: 'X', message: 'Y' })).toBe(false)
  })

  it('returns false for objects with brand but missing required fields', () => {
    expect(isSyncError({ __betterSyncError: true })).toBe(false)
    expect(isSyncError({ __betterSyncError: true, code: 'X' })).toBe(false)
  })
})

describe('SyncError.toJSON wire format', () => {
  it('serializes minimal error correctly', () => {
    const err = new SyncError('TEST_CODE', 'a message')
    expect(err.toJSON()).toEqual({
      type: 'test_code',
      code: 'TEST_CODE',
      message: 'a message',
    })
  })

  it('includes hint, param, doc_url when present', () => {
    const err = new SyncError(
      'TEST',
      'msg',
      'try this',
      'https://docs.example.com/test',
      'fieldName',
    )
    expect(err.toJSON()).toEqual({
      type: 'test',
      code: 'TEST',
      message: 'msg',
      hint: 'try this',
      param: 'fieldName',
      doc_url: 'https://docs.example.com/test',
    })
  })

  it('omits optional fields when undefined', () => {
    const err = new SyncError('TEST', 'msg')
    const json = err.toJSON()
    expect(json).not.toHaveProperty('hint')
    expect(json).not.toHaveProperty('param')
    expect(json).not.toHaveProperty('doc_url')
  })
})

describe('subclass error properties', () => {
  it('SchemaViolationError carries correct code and docs', () => {
    const err = new SchemaViolationError('field bad')
    expect(err.code).toBe('SCHEMA_VIOLATION')
    expect(err.docsUrl).toContain('schema-violation')
  })

  it('BatchTooLargeError formats actual and limit in message', () => {
    const err = new BatchTooLargeError(5000, 1000)
    expect(err.message).toContain('5000')
    expect(err.message).toContain('1000')
  })

  it('AdapterError wraps an underlying error', () => {
    const original = new Error('connection refused')
    const err = new AdapterError('drizzle-pg', original)
    expect(err.message).toContain('connection refused')
    expect(err.message).toContain('drizzle-pg')
  })
})
