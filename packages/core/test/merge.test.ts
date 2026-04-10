import { describe, expect, it } from 'vitest'
import {
  decideMerge,
  encodeHlc,
  shouldApplyTombstone,
  shouldDropAsResurrection,
} from '../src/index'

const hlcAt = (wall: number, logical = 0) =>
  encodeHlc({ wall, logical, node: 1 })

describe('decideMerge LWW', () => {
  it('inserts when no existing row', () => {
    const result = decideMerge(null, { id: 'x', changed: hlcAt(100) })
    expect(result.action).toBe('inserted')
    expect(result.result).toEqual({ id: 'x', changed: hlcAt(100) })
  })

  it('updates when incoming HLC is newer', () => {
    const existing = { id: 'x', changed: hlcAt(100), title: 'old' }
    const incoming = { id: 'x', changed: hlcAt(200), title: 'new' }
    const result = decideMerge(existing, incoming)
    expect(result.action).toBe('updated')
    expect(result.result.title).toBe('new')
  })

  it('skips when incoming HLC is older', () => {
    const existing = { id: 'x', changed: hlcAt(200), title: 'new' }
    const incoming = { id: 'x', changed: hlcAt(100), title: 'old' }
    const result = decideMerge(existing, incoming)
    expect(result.action).toBe('skipped')
    expect(result.result.title).toBe('new')
  })

  it('skips when incoming HLC is equal (idempotent)', () => {
    const hlc = hlcAt(100)
    const existing = { id: 'x', changed: hlc, title: 'a' }
    const incoming = { id: 'x', changed: hlc, title: 'a' }
    const result = decideMerge(existing, incoming)
    expect(result.action).toBe('skipped')
  })

  it('uses logical counter for same-ms tiebreak', () => {
    const existing = { id: 'x', changed: hlcAt(100, 5) }
    const incoming = { id: 'x', changed: hlcAt(100, 6) }
    expect(decideMerge(existing, incoming).action).toBe('updated')
  })

  it('respects custom HLC field name', () => {
    const existing = { id: 'x', _hlc: hlcAt(100) }
    const incoming = { id: 'x', _hlc: hlcAt(200) }
    expect(decideMerge(existing, incoming, '_hlc').action).toBe('updated')
  })
})

describe('shouldApplyTombstone', () => {
  it('applies when no existing tombstone', () => {
    expect(shouldApplyTombstone(null, hlcAt(100))).toBe(true)
  })

  it('applies when newer HLC arrives', () => {
    expect(shouldApplyTombstone(hlcAt(100), hlcAt(200))).toBe(true)
  })

  it('skips when older HLC arrives', () => {
    expect(shouldApplyTombstone(hlcAt(200), hlcAt(100))).toBe(false)
  })

  it('skips when equal HLC arrives', () => {
    const hlc = hlcAt(100)
    expect(shouldApplyTombstone(hlc, hlc)).toBe(false)
  })
})

describe('shouldDropAsResurrection', () => {
  it('does not drop when no tombstone', () => {
    expect(shouldDropAsResurrection(null, hlcAt(100))).toBe(false)
  })

  it('drops when row HLC is older than tombstone (stale write)', () => {
    expect(shouldDropAsResurrection(hlcAt(200), hlcAt(100))).toBe(true)
  })

  it('drops when row HLC equals tombstone (cannot revive at same instant)', () => {
    const hlc = hlcAt(100)
    expect(shouldDropAsResurrection(hlc, hlc)).toBe(true)
  })

  it('does NOT drop when row HLC is newer (legitimate recreate)', () => {
    expect(shouldDropAsResurrection(hlcAt(100), hlcAt(200))).toBe(false)
  })
})
