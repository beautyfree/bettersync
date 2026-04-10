import { describe, expect, it } from 'vitest'
import {
  CONFORMANCE_TEST_SCHEMA,
  CONFORMANCE_TESTS,
  getConformanceTestsByTag,
  hlcAt,
} from '../src/index'

describe('conformance suite shape', () => {
  it('exports a non-empty test list', () => {
    expect(CONFORMANCE_TESTS.length).toBeGreaterThan(10)
  })

  it('every test has a name, tags, and run function', () => {
    for (const t of CONFORMANCE_TESTS) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(Array.isArray(t.tags)).toBe(true)
      expect(typeof t.run).toBe('function')
    }
  })

  it('every test has at least one tag', () => {
    for (const t of CONFORMANCE_TESTS) {
      expect(t.tags.length).toBeGreaterThan(0)
    }
  })

  it('test names are unique', () => {
    const names = new Set(CONFORMANCE_TESTS.map((t) => t.name))
    expect(names.size).toBe(CONFORMANCE_TESTS.length)
  })

  it('getConformanceTestsByTag filters correctly', () => {
    const core = getConformanceTestsByTag(['core'])
    expect(core.length).toBeGreaterThan(0)
    expect(core.length).toBeLessThanOrEqual(CONFORMANCE_TESTS.length)
    for (const t of core) {
      expect(t.tags).toContain('core')
    }
  })

  it('getConformanceTestsByTag with empty array returns all', () => {
    expect(getConformanceTestsByTag([])).toEqual(CONFORMANCE_TESTS)
  })

  it('includes P0 scope leak prevention tests', () => {
    const scopeTests = CONFORMANCE_TESTS.filter((t) => t.tags.includes('scope'))
    expect(scopeTests.length).toBeGreaterThanOrEqual(2)
  })

  it('includes cursor pagination correctness test', () => {
    const cursorTests = CONFORMANCE_TESTS.filter((t) => t.tags.includes('cursor'))
    expect(cursorTests.length).toBeGreaterThanOrEqual(3)
    expect(cursorTests.some((t) => t.name.toLowerCase().includes('pagination'))).toBe(true)
  })
})

describe('hlcAt helper', () => {
  it('produces valid 24-char HLCs', () => {
    expect(hlcAt(100)).toMatch(/^[0-9a-f]{24}$/)
  })

  it('produces lex-sortable HLCs', () => {
    const a = hlcAt(100)
    const b = hlcAt(200)
    expect(a < b).toBe(true)
  })
})

describe('CONFORMANCE_TEST_SCHEMA', () => {
  it('has project and tag models', () => {
    expect(CONFORMANCE_TEST_SCHEMA.project).toBeDefined()
    expect(CONFORMANCE_TEST_SCHEMA.tag).toBeDefined()
  })

  it('project has a scope function', () => {
    expect(typeof CONFORMANCE_TEST_SCHEMA.project?.scope).toBe('function')
  })
})
