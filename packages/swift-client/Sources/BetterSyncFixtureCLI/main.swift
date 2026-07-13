import BetterSync
import Foundation

let changed = try HLC(rawValue: "018e23f14c0000021a2b3c4d")
let request = SyncRequest(
  clientTime: changed,
  since: .zero,
  changes: [
    "feeding": [
      UpsertOperation(
        opId: "swift-fixture-op",
        row: [
          "id": .string("swift-fixture-row"),
          "familyId": .string("family-1"),
          "childId": .string("child-1"),
          "type": .string("breast_left"),
          "timestamp": .number(1_710_000_000_000),
          "duration": .null,
          "changed": .string(changed.rawValue),
        ]
      ),
    ],
  ]
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(request)
print(String(decoding: data, as: UTF8.self))
