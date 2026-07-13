import Foundation

public protocol SyncTransport: Sendable {
  func send(_ request: SyncRequest) async throws -> SyncResponse
}

public protocol SyncResponseSink: Sendable {
  func apply(_ response: SyncResponse) async throws
}

public struct NoopSyncResponseSink: SyncResponseSink {
  public init() {}
  public func apply(_ response: SyncResponse) async throws {}
}

public enum PendingOperation: Codable, Equatable, Sendable {
  case upsert(model: String, operation: UpsertOperation)
  case delete(operation: DeleteOperation)

  private enum CodingKeys: String, CodingKey { case type, model, operation }
  private enum Kind: String, Codable { case upsert, delete }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .upsert(let model, let operation):
      try container.encode(Kind.upsert, forKey: .type)
      try container.encode(model, forKey: .model)
      try container.encode(operation, forKey: .operation)
    case .delete(let operation):
      try container.encode(Kind.delete, forKey: .type)
      try container.encode(operation, forKey: .operation)
    }
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .upsert:
      self = .upsert(
        model: try container.decode(String.self, forKey: .model),
        operation: try container.decode(UpsertOperation.self, forKey: .operation)
      )
    case .delete:
      self = .delete(operation: try container.decode(DeleteOperation.self, forKey: .operation))
    }
  }

  var opId: String {
    switch self {
    case .upsert(_, let operation): operation.opId
    case .delete(let operation): operation.opId
    }
  }
}

public struct SyncClientState: Codable, Sendable {
  public var clock: HLCClock
  public var lastSyncedHLC: HLC
  public var pendingCursor: PaginationCursor?
  public var pendingOperations: [PendingOperation]

  public init(
    nodeID: UInt32,
    clockState: HLC? = nil,
    lastSyncedHLC: HLC = .zero,
    pendingCursor: PaginationCursor? = nil,
    pendingOperations: [PendingOperation] = []
  ) {
    self.clock = HLCClock(nodeID: nodeID, state: clockState)
    self.lastSyncedHLC = lastSyncedHLC
    self.pendingCursor = pendingCursor
    self.pendingOperations = pendingOperations
  }
}

public protocol SyncStateStore: Sendable {
  func load() async throws -> SyncClientState?
  func save(_ state: SyncClientState) async throws
}

public actor InMemorySyncStateStore: SyncStateStore {
  private var state: SyncClientState?

  public init(state: SyncClientState? = nil) {
    self.state = state
  }

  public func load() async throws -> SyncClientState? { state }
  public func save(_ state: SyncClientState) async throws { self.state = state }
}

public actor UserDefaultsSyncStateStore: SyncStateStore {
  private let defaults: UserDefaults
  private let key: String

  public init(defaults: UserDefaults, key: String = "bettersync.client-state.v1") {
    self.defaults = defaults
    self.key = key
  }

  public func load() async throws -> SyncClientState? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try JSONDecoder().decode(SyncClientState.self, from: data)
  }

  public func save(_ state: SyncClientState) async throws {
    let data = try JSONEncoder().encode(state)
    defaults.set(data, forKey: key)
    defaults.synchronize()
  }
}

public struct SyncResult: Sendable {
  public let pushed: Int
  public let pulled: Int
  public let tombstones: Int
  public let staleClient: Bool
  public let responses: [SyncResponse]
}

/// Durable BetterSync client. It persists HLC state, cursor and immutable
/// outbox before network I/O, so request retries are safe after a crash.
public actor SyncClient {
  private let transport: any SyncTransport
  private let stateStore: any SyncStateStore
  private let responseSink: any SyncResponseSink
  private let nodeID: UInt32
  private let limit: Int
  private var state: SyncClientState?

  public init(
    transport: any SyncTransport,
    stateStore: any SyncStateStore,
    responseSink: any SyncResponseSink = NoopSyncResponseSink(),
    nodeID: UInt32? = nil,
    limit: Int = 1_000
  ) {
    self.transport = transport
    self.stateStore = stateStore
    self.responseSink = responseSink
    self.nodeID = nodeID ?? UInt32.random(in: UInt32.min...UInt32.max)
    self.limit = limit
  }

  @discardableResult
  public func enqueueUpsert(model: String, row: SyncRow, opId: String = UUID().uuidString) async throws -> HLC {
    guard row["id"]?.stringValue?.isEmpty == false else {
      throw BetterSyncError.invalidRow("Upsert rows need a non-empty string id")
    }
    var localState = try await loadedState()
    let changed = try localState.clock.tick()
    var stamped = row
    stamped["changed"] = .string(changed.rawValue)
    localState.pendingOperations.append(.upsert(model: model, operation: UpsertOperation(opId: opId, row: stamped)))
    try await persist(localState)
    return changed
  }

  /// Mark a fresh client as already caught up. Use only when another scoped
  /// projection is authoritative for reads (for example a compact widget
  /// snapshot) and this client is used for durable writes. This prevents a
  /// widget extension from downloading an entire family journal on first tap.
  public func bootstrapToNowIfNeeded() async throws {
    var localState = try await loadedState()
    guard localState.lastSyncedHLC == .zero,
          localState.pendingCursor == nil,
          localState.pendingOperations.isEmpty else { return }
    localState.lastSyncedHLC = try localState.clock.tick()
    try await persist(localState)
  }

  @discardableResult
  public func enqueueDelete(
    model: String,
    id: String,
    scope: SyncRow,
    opId: String = UUID().uuidString
  ) async throws -> HLC {
    guard !id.isEmpty else { throw BetterSyncError.invalidRow("Tombstones need a non-empty id") }
    var localState = try await loadedState()
    let changed = try localState.clock.tick()
    let tombstone = Tombstone(model: model, id: id, hlc: changed, scope: scope)
    localState.pendingOperations.append(.delete(operation: DeleteOperation(opId: opId, tombstone: tombstone)))
    try await persist(localState)
    return changed
  }

  public func syncNow() async throws -> SyncResult {
    var localState = try await loadedState()
    let pendingAtStart = localState.pendingOperations
    var firstPage = true
    var cursor = localState.pendingCursor
    var responses: [SyncResponse] = []
    var pulled = 0
    var tombstones = 0
    var staleClient = false

    repeat {
      let clientTime = try localState.clock.tick()
      try await persist(localState)
      let request = SyncRequest(
        clientTime: clientTime,
        since: localState.lastSyncedHLC,
        cursor: cursor,
        limit: limit,
        changes: firstPage ? groupedUpserts(pendingAtStart) : nil,
        tombstones: firstPage ? pendingDeletes(pendingAtStart) : nil
      )
      let response = try await transport.send(request)
      try response.validate()
      try localState.clock.receive(response.serverTime)
      try await responseSink.apply(response)

      responses.append(response)
      pulled += response.changes.values.reduce(0) { $0 + $1.count }
      tombstones += response.tombstones.count
      staleClient = staleClient || (response.staleClient ?? false)

      if firstPage {
        let appliedIDs = Set(pendingAtStart.map(\.opId))
        localState.pendingOperations.removeAll { appliedIDs.contains($0.opId) }
        firstPage = false
      }

      if response.hasMore {
        guard let nextCursor = response.cursor else {
          throw BetterSyncError.invalidResponse("hasMore response is missing cursor")
        }
        localState.pendingCursor = nextCursor
        cursor = nextCursor
      } else {
        localState.pendingCursor = nil
        if !staleClient {
          localState.lastSyncedHLC = response.serverTime
        }
        cursor = nil
      }
      try await persist(localState)
    } while cursor != nil

    return SyncResult(
      pushed: pendingAtStart.count,
      pulled: pulled,
      tombstones: tombstones,
      staleClient: staleClient,
      responses: responses
    )
  }

  public func currentState() async throws -> SyncClientState {
    try await loadedState()
  }

  private func loadedState() async throws -> SyncClientState {
    if let state { return state }
    let loaded = try await stateStore.load() ?? SyncClientState(nodeID: nodeID)
    state = loaded
    return loaded
  }

  private func persist(_ nextState: SyncClientState) async throws {
    state = nextState
    try await stateStore.save(nextState)
  }

  private func groupedUpserts(_ pending: [PendingOperation]) -> [String: [UpsertOperation]]? {
    let pairs = pending.compactMap { operation -> (String, UpsertOperation)? in
      guard case .upsert(let model, let upsert) = operation else { return nil }
      return (model, upsert)
    }
    guard !pairs.isEmpty else { return nil }
    return Dictionary(grouping: pairs, by: \.0).mapValues { $0.map(\.1) }
  }

  private func pendingDeletes(_ pending: [PendingOperation]) -> [DeleteOperation]? {
    let deletes = pending.compactMap { operation -> DeleteOperation? in
      guard case .delete(let delete) = operation else { return nil }
      return delete
    }
    return deletes.isEmpty ? nil : deletes
  }
}
