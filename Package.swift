// swift-tools-version: 6.0
import PackageDescription

// Root manifest makes the Swift client consumable from a Git URL. The
// implementation stays under packages/swift-client with the Node packages.
let package = Package(
  name: "BetterSync",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
    .watchOS(.v8),
  ],
  products: [
    .library(name: "BetterSync", targets: ["BetterSync"]),
  ],
  targets: [
    .target(name: "BetterSync", path: "packages/swift-client/Sources/BetterSync"),
    .testTarget(
      name: "BetterSyncTests",
      dependencies: ["BetterSync"],
      path: "packages/swift-client/Tests/BetterSyncTests"
    ),
  ]
)
