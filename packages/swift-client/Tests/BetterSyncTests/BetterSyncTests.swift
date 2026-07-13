import BetterSync
import Foundation
import Testing

private actor RecordingTransport: SyncTransport {
  private var requests: [SyncRequest] = []
  private var shouldFail = false

  init(shouldFail: Bool = false) {
    self.shouldFail = shouldFail
  }

  func send(_ request: SyncRequest) async throws -> SyncResponse {
    requests.append(request)
    if shouldFail {
      shouldFail = false
      throw URLError(.notConnectedToInternet)
    }
    let serverTime = try HLC(rawValue: "018e23f14c000003ffffffff")
    return SyncResponse(
      protocolVersion: BetterSyncProtocol.version,
      serverTime: serverTime,
      changes: [:],
      tombstones: [],
      hasMore: false,
      cursor: nil,
      staleClient: false
    )
  }

  func allRequests() -> [SyncRequest] { requests }
}

@Test func hlcMatchesTypeScriptGoldenVector() throws {
  let value = try HLC(wallMilliseconds: 1_710_000_000_000, logical: 2, nodeID: 0x1a2b3c4d)
  #expect(value.rawValue == "018e23f14c0000021a2b3c4d")
  #expect(try JSONEncoder().encode(value) == Data("\"018e23f14c0000021a2b3c4d\"".utf8))
}

@Test func durableOutboxRetriesSameOperation() async throws {
  let transport = RecordingTransport(shouldFail: true)
  let storage = InMemorySyncStateStore()
  let client = SyncClient(transport: transport, stateStore: storage, nodeID: 0x1a2b3c4d)

  _ = try await client.enqueueUpsert(
    model: "feeding",
    row: [
      "id": .string("feeding-1"),
      "familyId": .string("family-1"),
      "childId": .string("child-1"),
      "type": .string("breast_left"),
      "timestamp": .number(1_710_000_000_000),
      "duration": .null,
    ],
    opId: "stable-operation-id"
  )

  await #expect(throws: URLError.self) {
    try await client.syncNow()
  }
  let result = try await client.syncNow()
  #expect(result.pushed == 1)

  let requests = await transport.allRequests()
  #expect(requests.count == 2)
  let first = try #require(requests[0].changes?["feeding"]?.first)
  let second = try #require(requests[1].changes?["feeding"]?.first)
  #expect(first.opId == "stable-operation-id")
  #expect(second.opId == "stable-operation-id")
  #expect(first.row["changed"] == second.row["changed"])
}

@Test func paginationCursorPersistsUntilDrainCompletes() async throws {
  let cursor = PaginationCursor(
    model: "feeding",
    hlc: try HLC(rawValue: "018e23f14c000003ffffffff"),
    id: "feeding-1"
  )
  let first = SyncResponse(
    protocolVersion: BetterSyncProtocol.version,
    serverTime: try HLC(rawValue: "018e23f14c000004ffffffff"),
    changes: ["feeding": [["id": .string("feeding-1")]]],
    tombstones: [],
    hasMore: true,
    cursor: cursor,
    staleClient: false
  )
  let second = SyncResponse(
    protocolVersion: BetterSyncProtocol.version,
    serverTime: try HLC(rawValue: "018e23f14c000005ffffffff"),
    changes: ["sleepSession": [["id": .string("sleep-1")]]],
    tombstones: [],
    hasMore: false,
    cursor: nil,
    staleClient: false
  )
  let transport = SequenceTransport(responses: [first, second])
  let storage = InMemorySyncStateStore()
  let client = SyncClient(transport: transport, stateStore: storage, nodeID: 1)

  let result = try await client.syncNow()
  #expect(result.pulled == 2)
  #expect((try await client.currentState()).pendingCursor == nil)
  let requests = await transport.allRequests()
  #expect(requests.count == 2)
  #expect(requests[1].cursor == cursor)
}

private actor SequenceTransport: SyncTransport {
  private var responses: [SyncResponse]
  private var requests: [SyncRequest] = []

  init(responses: [SyncResponse]) { self.responses = responses }

  func send(_ request: SyncRequest) async throws -> SyncResponse {
    requests.append(request)
    return responses.removeFirst()
  }

  func allRequests() -> [SyncRequest] { requests }
}
