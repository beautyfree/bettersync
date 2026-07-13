import Foundation

public enum BetterSyncError: Error, Equatable, Sendable {
  case invalidHLC(String)
  case hlcOverflow
  case invalidRow(String)
  case protocolMismatch(expected: String, received: String)
  case invalidResponse(String)
  case httpStatus(Int, String)
}

/// 96-bit, lexicographically sortable HLC. Format matches @bettersync/core:
/// 48-bit wall clock + 16-bit logical clock + 32-bit node id.
public struct HLC: Codable, Hashable, Comparable, Sendable {
  public static let zero = try! HLC(rawValue: "000000000000000000000000")

  public let rawValue: String

  public init(rawValue: String) throws {
    guard rawValue.count == 24,
          rawValue.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
      throw BetterSyncError.invalidHLC(rawValue)
    }
    self.rawValue = rawValue
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    try self.init(rawValue: container.decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public init(wallMilliseconds: UInt64, logical: UInt16, nodeID: UInt32) throws {
    guard wallMilliseconds <= 0xFFFFFFFFFFFF else {
      throw BetterSyncError.invalidHLC("wall clock exceeds 48 bits")
    }
    self.rawValue = String(format: "%012llx%04x%08x", wallMilliseconds, logical, nodeID)
  }

  public var wallMilliseconds: UInt64 {
    UInt64(rawValue.prefix(12), radix: 16)!
  }

  public var logical: UInt16 {
    UInt16(rawValue.dropFirst(12).prefix(4), radix: 16)!
  }

  public var nodeID: UInt32 {
    UInt32(rawValue.suffix(8), radix: 16)!
  }

  public static func < (lhs: HLC, rhs: HLC) -> Bool {
    lhs.rawValue < rhs.rawValue
  }
}

public struct HLCClock: Codable, Sendable {
  public private(set) var current: HLC

  public init(nodeID: UInt32, state: HLC? = nil) {
    self.current = state ?? (try! HLC(wallMilliseconds: 0, logical: 0, nodeID: nodeID))
  }

  public mutating func tick(now: UInt64 = HLCClock.currentMilliseconds()) throws -> HLC {
    let wall = max(now, current.wallMilliseconds)
    let logical: UInt16
    if wall > current.wallMilliseconds {
      logical = 0
    } else {
      guard current.logical < UInt16.max else { throw BetterSyncError.hlcOverflow }
      logical = current.logical + 1
    }
    current = try HLC(wallMilliseconds: wall, logical: logical, nodeID: current.nodeID)
    return current
  }

  @discardableResult
  public mutating func receive(_ remote: HLC, now: UInt64 = HLCClock.currentMilliseconds()) throws -> HLC {
    let wall = max(now, current.wallMilliseconds, remote.wallMilliseconds)
    let logical: UInt16
    if wall == current.wallMilliseconds && wall == remote.wallMilliseconds {
      let maxLogical = max(current.logical, remote.logical)
      guard maxLogical < UInt16.max else { throw BetterSyncError.hlcOverflow }
      logical = maxLogical + 1
    } else if wall == current.wallMilliseconds {
      guard current.logical < UInt16.max else { throw BetterSyncError.hlcOverflow }
      logical = current.logical + 1
    } else if wall == remote.wallMilliseconds {
      guard remote.logical < UInt16.max else { throw BetterSyncError.hlcOverflow }
      logical = remote.logical + 1
    } else {
      logical = 0
    }
    current = try HLC(wallMilliseconds: wall, logical: logical, nodeID: current.nodeID)
    return current
  }

  public static func currentMilliseconds() -> UInt64 {
    UInt64((Date().timeIntervalSince1970 * 1_000).rounded(.down))
  }
}
