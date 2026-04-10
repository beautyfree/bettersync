/**
 * Hybrid Logical Clock — deterministic, lex-sortable, 24 hex characters.
 *
 * Wire format (24 hex chars, 96 bits total):
 *
 *   [0..11]  wall_ms_hex     (48 bits) — physical milliseconds since epoch
 *   [12..15] logical_hex     (16 bits) — logical counter, 0..65535 per ms
 *   [16..23] node_id_hex     (32 bits) — stable node identifier
 *
 * Lexicographic string compare matches temporal compare because the format
 * is fixed-width hex with the most significant bytes first.
 *
 * No randomness — two nodes producing the same (wall, logical) deterministically
 * tiebreak via the node_id field. This is critical for LWW convergence between
 * clients (otherwise they could disagree on the winner of two writes).
 *
 * @see HLClock for the stateful clock instance.
 */

import { HLCOverflowError } from './errors'

/** Length of an encoded HLC string. */
export const HLC_LENGTH = 24

/** The "zero" HLC. Used as the initial `since` value for first sync. */
export const HLC_ZERO = '000000000000000000000000'

/** Maximum value of the logical counter (16 bits). */
export const HLC_MAX_LOGICAL = 0xffff

/** Maximum value of the wall clock in ms (48 bits). Year ~10889. */
export const HLC_MAX_WALL = 0xffffffffffff

/**
 * Decoded HLC parts.
 */
export interface HLCParts {
  /** Physical milliseconds since epoch (48 bits). */
  wall: number
  /** Logical counter, 0..65535 (16 bits). */
  logical: number
  /** Node identifier (32 bits). */
  node: number
}

function toHex(n: number, padTo: number): string {
  if (n < 0) throw new RangeError(`HLC value must be non-negative, got ${n}`)
  return n.toString(16).padStart(padTo, '0')
}

/**
 * Encode HLC parts into a 24-character hex string.
 *
 * @throws RangeError if any part is out of range.
 */
export function encode(parts: HLCParts): string {
  if (parts.wall > HLC_MAX_WALL) {
    throw new RangeError(`HLC wall ${parts.wall} exceeds max ${HLC_MAX_WALL}`)
  }
  if (parts.logical > HLC_MAX_LOGICAL) {
    throw new RangeError(
      `HLC logical ${parts.logical} exceeds max ${HLC_MAX_LOGICAL}`,
    )
  }
  if (parts.node > 0xffffffff) {
    throw new RangeError(`HLC node ${parts.node} exceeds 32-bit max`)
  }
  return toHex(parts.wall, 12) + toHex(parts.logical, 4) + toHex(parts.node, 8)
}

/**
 * Decode a 24-character hex HLC string into parts.
 *
 * @throws RangeError if the string is malformed.
 */
export function decode(hlc: string): HLCParts {
  if (typeof hlc !== 'string' || hlc.length !== HLC_LENGTH) {
    throw new RangeError(
      `HLC must be a ${HLC_LENGTH}-character string, got ${typeof hlc} of length ${
        typeof hlc === 'string' ? hlc.length : 'n/a'
      }`,
    )
  }
  if (!/^[0-9a-f]{24}$/.test(hlc)) {
    throw new RangeError(`HLC must be lowercase hex, got "${hlc}"`)
  }
  return {
    wall: Number.parseInt(hlc.slice(0, 12), 16),
    logical: Number.parseInt(hlc.slice(12, 16), 16),
    node: Number.parseInt(hlc.slice(16, 24), 16),
  }
}

/**
 * Compare two HLCs. Returns negative if a < b, positive if a > b, 0 if equal.
 *
 * Lexicographic string compare suffices because the format is fixed-width hex.
 */
export function compare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Minimal structural type for the WebCrypto API methods we use.
 * We don't depend on `lib.dom.d.ts` so this works in pure-Node builds.
 */
interface MinimalCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

/**
 * Generate a random 32-bit node ID using crypto-secure randomness.
 * The result is stable for the lifetime of the call only — callers should
 * persist this value for the lifetime of the node identity.
 */
export function generateNodeId(): number {
  const buf = new Uint32Array(1)
  // crypto is a global in Node 19+ and all modern browsers
  const c = (globalThis as { crypto?: MinimalCrypto }).crypto
  if (!c?.getRandomValues) {
    throw new Error(
      'No crypto.getRandomValues available. Provide an explicit nodeId via HLClockOptions.',
    )
  }
  c.getRandomValues(buf)
  return buf[0] ?? 0
}

export interface HLClockOptions {
  /**
   * Stable 32-bit node identifier. If omitted, a random one is generated
   * (NOT persisted — caller must persist if multi-session stability is needed).
   */
  nodeId?: number
  /**
   * Clock function. Defaults to `Date.now`. Override for tests.
   */
  now?: () => number
}

/**
 * Stateful Hybrid Logical Clock instance.
 *
 * Each `tick()` produces a new HLC larger than all prior local HLCs and all
 * received remote HLCs. Each `receive()` updates the internal state to be
 * greater than the received HLC.
 */
export class HLClock {
  private state: HLCParts
  private readonly now: () => number

  constructor(options: HLClockOptions = {}) {
    const nodeId = options.nodeId ?? generateNodeId()
    if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > 0xffffffff) {
      throw new RangeError(`HLClock nodeId must be a 32-bit unsigned integer, got ${nodeId}`)
    }
    this.state = { wall: 0, logical: 0, node: nodeId }
    this.now = options.now ?? Date.now
  }

  /**
   * Generate the next HLC for a local event.
   *
   * @throws HLCOverflowError if the logical counter exceeds 65535 in the same ms.
   */
  tick(): string {
    const wall = this.now()
    if (wall > this.state.wall) {
      this.state = { wall, logical: 0, node: this.state.node }
    } else {
      // Either same ms (increment logical) or clock went backwards
      // (still increment logical, keeping the larger wall — guarantees monotonicity)
      const newLogical = this.state.logical + 1
      if (newLogical > HLC_MAX_LOGICAL) {
        throw new HLCOverflowError()
      }
      this.state = {
        wall: this.state.wall,
        logical: newLogical,
        node: this.state.node,
      }
    }
    return encode(this.state)
  }

  /**
   * Merge a received HLC into the local clock and return the new local HLC.
   *
   * The result is guaranteed to be greater than both the previous local
   * state and the received remote HLC.
   *
   * @throws HLCOverflowError if the logical counter exceeds 65535.
   */
  receive(remoteHlc: string): string {
    const remote = decode(remoteHlc)
    const wallNow = this.now()
    const newWall = Math.max(wallNow, this.state.wall, remote.wall)

    let newLogical: number
    if (newWall === this.state.wall && newWall === remote.wall) {
      newLogical = Math.max(this.state.logical, remote.logical) + 1
    } else if (newWall === this.state.wall) {
      newLogical = this.state.logical + 1
    } else if (newWall === remote.wall) {
      newLogical = remote.logical + 1
    } else {
      newLogical = 0
    }

    if (newLogical > HLC_MAX_LOGICAL) {
      throw new HLCOverflowError()
    }

    this.state = {
      wall: newWall,
      logical: newLogical,
      node: this.state.node,
    }
    return encode(this.state)
  }

  /**
   * Get the current HLC without ticking.
   */
  current(): string {
    return encode(this.state)
  }

  /**
   * Get the current decoded HLC parts (copy).
   */
  currentParts(): HLCParts {
    return { ...this.state }
  }

  /**
   * The 32-bit node ID for this clock.
   */
  get nodeId(): number {
    return this.state.node
  }

  /**
   * Restore state from a persisted HLC. Used for crash recovery.
   * The provided HLC must include a node ID that matches this clock,
   * otherwise the new node ID is adopted.
   */
  setState(hlc: string): void {
    this.state = decode(hlc)
  }
}
