import Foundation

public enum BetterSyncProtocol {
  public static let version = "1.0.0"
}

public struct PaginationCursor: Codable, Equatable, Sendable {
  public let model: String
  public let hlc: HLC
  public let id: String

  public init(model: String, hlc: HLC, id: String) {
    self.model = model
    self.hlc = hlc
    self.id = id
  }
}

public struct Tombstone: Codable, Equatable, Sendable {
  public let model: String
  public let id: String
  public let hlc: HLC
  public let scope: SyncRow

  public init(model: String, id: String, hlc: HLC, scope: SyncRow) {
    self.model = model
    self.id = id
    self.hlc = hlc
    self.scope = scope
  }
}

public struct UpsertOperation: Codable, Equatable, Sendable {
  public let opId: String
  public let row: SyncRow

  public init(opId: String, row: SyncRow) {
    self.opId = opId
    self.row = row
  }
}

public struct DeleteOperation: Codable, Equatable, Sendable {
  public let opId: String
  public let tombstone: Tombstone

  public init(opId: String, tombstone: Tombstone) {
    self.opId = opId
    self.tombstone = tombstone
  }
}

public struct SyncRequest: Codable, Equatable, Sendable {
  public let protocolVersion: String
  public let clientTime: HLC
  public let since: HLC
  public let cursor: PaginationCursor?
  public let limit: Int?
  public let forceFetch: [String]?
  public let changes: [String: [UpsertOperation]]?
  public let tombstones: [DeleteOperation]?

  public init(
    protocolVersion: String = BetterSyncProtocol.version,
    clientTime: HLC,
    since: HLC,
    cursor: PaginationCursor? = nil,
    limit: Int? = nil,
    forceFetch: [String]? = nil,
    changes: [String: [UpsertOperation]]? = nil,
    tombstones: [DeleteOperation]? = nil
  ) {
    self.protocolVersion = protocolVersion
    self.clientTime = clientTime
    self.since = since
    self.cursor = cursor
    self.limit = limit
    self.forceFetch = forceFetch
    self.changes = changes
    self.tombstones = tombstones
  }
}

public struct SyncResponse: Codable, Equatable, Sendable {
  public let protocolVersion: String
  public let serverTime: HLC
  public let changes: [String: [SyncRow]]
  public let tombstones: [Tombstone]
  public let hasMore: Bool
  public let cursor: PaginationCursor?
  public let staleClient: Bool?

  public init(
    protocolVersion: String,
    serverTime: HLC,
    changes: [String: [SyncRow]],
    tombstones: [Tombstone],
    hasMore: Bool,
    cursor: PaginationCursor? = nil,
    staleClient: Bool? = nil
  ) {
    self.protocolVersion = protocolVersion
    self.serverTime = serverTime
    self.changes = changes
    self.tombstones = tombstones
    self.hasMore = hasMore
    self.cursor = cursor
    self.staleClient = staleClient
  }

  public func validate() throws {
    guard protocolVersion.split(separator: ".").first == BetterSyncProtocol.version.split(separator: ".").first else {
      throw BetterSyncError.protocolMismatch(expected: BetterSyncProtocol.version, received: protocolVersion)
    }
    if hasMore && cursor == nil {
      throw BetterSyncError.invalidResponse("hasMore response is missing cursor")
    }
  }
}
