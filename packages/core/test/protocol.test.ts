import { describe, expect, it } from 'vitest'
import {
  emptySyncResponse,
  HLC_ZERO,
  isSyncError,
  parseSyncRequest,
  PROTOCOL_VERSION,
  serializeSyncResponse,
  SchemaViolationError,
} from '../src/index'

const VALID_HLC = '01941d8c2e800001a3f7e2c1'

describe('parseSyncRequest', () => {
  it('accepts a minimal valid request', () => {
    const req = parseSyncRequest({
      protocolVersion: PROTOCOL_VERSION,
      clientTime: VALID_HLC,
      since: HLC_ZERO,
    })
    expect(req.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(req.since).toBe(HLC_ZERO)
  })

  it('accepts a full valid request with cursor and changes', () => {
    const req = parseSyncRequest({
      protocolVersion: PROTOCOL_VERSION,
      clientTime: VALID_HLC,
      since: HLC_ZERO,
      cursor: { model: 'project', hlc: VALID_HLC, id: 'abc' },
      limit: 100,
      forceFetch: ['project'],
      changes: { project: [{ id: 'p1', changed: VALID_HLC }] },
      tombstones: [
        { model: 'project', id: 'gone', hlc: VALID_HLC, scope: { userId: 'u1' } },
      ],
    })
    expect(req.cursor?.id).toBe('abc')
    expect(req.changes?.project).toHaveLength(1)
    expect(req.tombstones).toHaveLength(1)
  })

  it('rejects non-object input', () => {
    expect(() => parseSyncRequest(null)).toThrow(SchemaViolationError)
    expect(() => parseSyncRequest('string')).toThrow(SchemaViolationError)
    expect(() => parseSyncRequest([])).toThrow(SchemaViolationError)
  })

  it('rejects missing protocolVersion', () => {
    expect(() => parseSyncRequest({ clientTime: VALID_HLC, since: HLC_ZERO })).toThrow(
      SchemaViolationError,
    )
  })

  it('rejects malformed HLC in since', () => {
    expect(() =>
      parseSyncRequest({
        protocolVersion: PROTOCOL_VERSION,
        clientTime: VALID_HLC,
        since: 'not-an-hlc',
      }),
    ).toThrow(SchemaViolationError)
  })

  it('rejects cursor without compound (hlc, id) tiebreak', () => {
    expect(() =>
      parseSyncRequest({
        protocolVersion: PROTOCOL_VERSION,
        clientTime: VALID_HLC,
        since: HLC_ZERO,
        cursor: { model: 'project', hlc: VALID_HLC },
      }),
    ).toThrow(SchemaViolationError)
  })

  it('rejects tombstone without scope (P0 security)', () => {
    let caught: unknown = null
    try {
      parseSyncRequest({
        protocolVersion: PROTOCOL_VERSION,
        clientTime: VALID_HLC,
        since: HLC_ZERO,
        tombstones: [{ model: 'project', id: 'x', hlc: VALID_HLC }],
      })
    } catch (e) {
      caught = e
    }
    expect(isSyncError(caught)).toBe(true)
    expect((caught as { code: string }).code).toBe('SCHEMA_VIOLATION')
  })

  it('rejects negative or zero limit', () => {
    expect(() =>
      parseSyncRequest({
        protocolVersion: PROTOCOL_VERSION,
        clientTime: VALID_HLC,
        since: HLC_ZERO,
        limit: 0,
      }),
    ).toThrow(SchemaViolationError)
    expect(() =>
      parseSyncRequest({
        protocolVersion: PROTOCOL_VERSION,
        clientTime: VALID_HLC,
        since: HLC_ZERO,
        limit: -1,
      }),
    ).toThrow(SchemaViolationError)
  })
})

describe('serializeSyncResponse', () => {
  it('round-trips through JSON', () => {
    const response = emptySyncResponse(VALID_HLC)
    const json = serializeSyncResponse(response)
    expect(JSON.parse(json)).toEqual(response)
  })

  it('emptySyncResponse has correct shape', () => {
    const r = emptySyncResponse(VALID_HLC)
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(r.serverTime).toBe(VALID_HLC)
    expect(r.changes).toEqual({})
    expect(r.tombstones).toEqual([])
    expect(r.hasMore).toBe(false)
    expect(r.cursor).toBeNull()
  })
})
