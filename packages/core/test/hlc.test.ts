import { describe, expect, it } from 'vitest'
import {
  compareHlc,
  decodeHlc,
  encodeHlc,
  HLC_LENGTH,
  HLC_MAX_LOGICAL,
  HLC_ZERO,
  HLClock,
  HLCOverflowError,
} from '../src/index'

describe('encode/decode roundtrip', () => {
  it('preserves all fields', () => {
    const parts = { wall: 1741234567890, logical: 42, node: 0xa1b2c3d4 }
    const encoded = encodeHlc(parts)
    expect(encoded).toHaveLength(HLC_LENGTH)
    const decoded = decodeHlc(encoded)
    expect(decoded).toEqual(parts)
  })

  it('encodes zero correctly', () => {
    expect(encodeHlc({ wall: 0, logical: 0, node: 0 })).toBe(HLC_ZERO)
  })

  it('decodes HLC_ZERO to zero parts', () => {
    expect(decodeHlc(HLC_ZERO)).toEqual({ wall: 0, logical: 0, node: 0 })
  })

  it('encodes max values', () => {
    const max = encodeHlc({
      wall: 0xffffffffffff,
      logical: 0xffff,
      node: 0xffffffff,
    })
    expect(max).toBe('ffffffffffffffffffffffff')
  })

  it('rejects out-of-range wall', () => {
    expect(() => encodeHlc({ wall: 0xffffffffffff + 1, logical: 0, node: 0 })).toThrow(RangeError)
  })

  it('rejects out-of-range logical', () => {
    expect(() => encodeHlc({ wall: 0, logical: 0x10000, node: 0 })).toThrow(RangeError)
  })

  it('rejects out-of-range node', () => {
    expect(() => encodeHlc({ wall: 0, logical: 0, node: 0x100000000 })).toThrow(RangeError)
  })

  it('rejects negative values', () => {
    expect(() => encodeHlc({ wall: -1, logical: 0, node: 0 })).toThrow(RangeError)
  })

  it('rejects malformed strings on decode', () => {
    expect(() => decodeHlc('too short')).toThrow(RangeError)
    expect(() => decodeHlc('FFFFFFFFFFFFFFFFFFFFFFFF')).toThrow(RangeError) // uppercase
    expect(() => decodeHlc('zzzzzzzzzzzzzzzzzzzzzzzz')).toThrow(RangeError) // not hex
  })
})

describe('lex string compare matches temporal compare', () => {
  it('orders correctly across all axes', () => {
    const a = encodeHlc({ wall: 100, logical: 5, node: 0xaaaaaaaa })
    const b = encodeHlc({ wall: 100, logical: 5, node: 0xbbbbbbbb })
    const c = encodeHlc({ wall: 100, logical: 6, node: 0xaaaaaaaa })
    const d = encodeHlc({ wall: 101, logical: 0, node: 0xaaaaaaaa })
    const sorted = [d, c, b, a].sort()
    expect(sorted).toEqual([a, b, c, d])
  })

  it('compareHlc matches sort order', () => {
    const earlier = encodeHlc({ wall: 100, logical: 0, node: 0 })
    const later = encodeHlc({ wall: 101, logical: 0, node: 0 })
    expect(compareHlc(earlier, later)).toBeLessThan(0)
    expect(compareHlc(later, earlier)).toBeGreaterThan(0)
    expect(compareHlc(earlier, earlier)).toBe(0)
  })

  it('1000 random HLCs sort consistently', () => {
    const items: Array<{ str: string; parts: { wall: number; logical: number; node: number } }> = []
    for (let i = 0; i < 1000; i++) {
      const parts = {
        wall: Math.floor(Math.random() * 0xffffffffff),
        logical: Math.floor(Math.random() * 0xffff),
        node: Math.floor(Math.random() * 0xffffffff),
      }
      items.push({ str: encodeHlc(parts), parts })
    }
    const byString = [...items].sort((a, b) => compareHlc(a.str, b.str))
    const byTuple = [...items].sort((a, b) => {
      if (a.parts.wall !== b.parts.wall) return a.parts.wall - b.parts.wall
      if (a.parts.logical !== b.parts.logical) return a.parts.logical - b.parts.logical
      return a.parts.node - b.parts.node
    })
    expect(byString.map((x) => x.str)).toEqual(byTuple.map((x) => x.str))
  })
})

describe('HLClock.tick monotonicity', () => {
  it('produces strictly monotonic HLCs across many ticks in same ms', () => {
    const clock = new HLClock({ nodeId: 1, now: () => 1000 })
    const seen: string[] = []
    for (let i = 0; i < 100; i++) {
      seen.push(clock.tick())
    }
    for (let i = 1; i < seen.length; i++) {
      expect(compareHlc(seen[i - 1] as string, seen[i] as string)).toBeLessThan(0)
    }
  })

  it('resets logical when wall advances', () => {
    let now = 1000
    const clock = new HLClock({ nodeId: 1, now: () => now })
    clock.tick()
    clock.tick()
    clock.tick()
    expect(clock.currentParts().logical).toBe(2)
    now = 2000
    clock.tick()
    expect(clock.currentParts().logical).toBe(0)
    expect(clock.currentParts().wall).toBe(2000)
  })

  it('handles clock going backwards (still monotonic)', () => {
    let now = 5000
    const clock = new HLClock({ nodeId: 1, now: () => now })
    const a = clock.tick()
    now = 4000 // clock went backwards
    const b = clock.tick()
    expect(compareHlc(a, b)).toBeLessThan(0)
    expect(clock.currentParts().wall).toBe(5000) // wall stays
    expect(clock.currentParts().logical).toBe(1) // logical incremented
  })

  it('throws HLCOverflowError when logical counter overflows', () => {
    const clock = new HLClock({ nodeId: 1, now: () => 1000 })
    for (let i = 0; i <= HLC_MAX_LOGICAL; i++) {
      clock.tick()
    }
    expect(() => clock.tick()).toThrow(HLCOverflowError)
  })
})

describe('HLClock.receive merge semantics', () => {
  it('adopts remote wall when remote is ahead', () => {
    const clock = new HLClock({ nodeId: 1, now: () => 1000 })
    const remote = encodeHlc({ wall: 5000, logical: 7, node: 2 })
    clock.receive(remote)
    expect(clock.currentParts().wall).toBe(5000)
    expect(clock.currentParts().logical).toBe(8) // remote.logical + 1
  })

  it('keeps local wall when local is ahead', () => {
    let now = 1000
    const clock = new HLClock({ nodeId: 1, now: () => now })
    now = 5000
    clock.tick() // local at 5000
    const remote = encodeHlc({ wall: 3000, logical: 99, node: 2 })
    clock.receive(remote)
    expect(clock.currentParts().wall).toBe(5000)
  })

  it('takes max logical when both walls are equal', () => {
    let now = 1000
    const clock = new HLClock({ nodeId: 1, now: () => now })
    clock.tick()
    clock.tick()
    clock.tick() // local logical=2
    const remote = encodeHlc({ wall: 1000, logical: 5, node: 2 })
    clock.receive(remote)
    expect(clock.currentParts().wall).toBe(1000)
    expect(clock.currentParts().logical).toBe(6) // max(2, 5) + 1
  })

  it('preserves local nodeId after receive', () => {
    const clock = new HLClock({ nodeId: 0xaaaa, now: () => 1000 })
    const remote = encodeHlc({ wall: 5000, logical: 0, node: 0xbbbb })
    clock.receive(remote)
    expect(clock.nodeId).toBe(0xaaaa)
  })

  it('result is always greater than received remote', () => {
    let now = 1000
    const clock = new HLClock({ nodeId: 1, now: () => now })
    for (let i = 0; i < 50; i++) {
      now += Math.floor(Math.random() * 100)
      const remote = encodeHlc({
        wall: now + Math.floor(Math.random() * 200) - 100,
        logical: Math.floor(Math.random() * 50),
        node: Math.floor(Math.random() * 0xffff),
      })
      const local = clock.receive(remote)
      expect(compareHlc(remote, local)).toBeLessThan(0)
    }
  })
})

describe('clock skew survival', () => {
  it('two clients with skewed clocks still produce sortable HLCs', () => {
    // Client A's clock is 60s ahead of Client B's
    let timeA = 1_000_000_000
    let timeB = 1_000_000_000 - 60_000

    const clockA = new HLClock({ nodeId: 1, now: () => timeA })
    const clockB = new HLClock({ nodeId: 2, now: () => timeB })

    const writes: Array<{ from: string; hlc: string; realTime: number }> = []

    // 100 interleaved writes from both clients
    for (let i = 0; i < 50; i++) {
      timeA += 100
      timeB += 100
      writes.push({ from: 'A', hlc: clockA.tick(), realTime: timeA })
      writes.push({ from: 'B', hlc: clockB.tick(), realTime: timeB })
    }

    // After exchange (each receives the other's HLC), they converge
    const lastA = writes.filter((w) => w.from === 'A').pop()
    const lastB = writes.filter((w) => w.from === 'B').pop()
    if (!lastA || !lastB) throw new Error('test setup broken')
    clockA.receive(lastB.hlc)
    clockB.receive(lastA.hlc)

    // Both clocks now produce HLCs that sort consistently with each other
    const newA = clockA.tick()
    const newB = clockB.tick()
    expect(compareHlc(newA, newB)).not.toBe(0)
  })
})

describe('setState recovery', () => {
  it('restores from a serialized HLC', () => {
    const original = new HLClock({ nodeId: 0xdeadbeef, now: () => 1000 })
    original.tick()
    original.tick()
    const snapshot = original.current()

    const restored = new HLClock({ nodeId: 0, now: () => 0 })
    restored.setState(snapshot)
    expect(restored.current()).toBe(snapshot)
    expect(restored.nodeId).toBe(0xdeadbeef)
  })
})
