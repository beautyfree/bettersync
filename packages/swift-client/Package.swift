// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BetterSync",
  platforms: [
    .iOS(.v15),
    .macOS(.v13),
    .watchOS(.v8),
  ],
  products: [
    .library(name: "BetterSync", targets: ["BetterSync"]),
    .executable(name: "BetterSyncFixtureCLI", targets: ["BetterSyncFixtureCLI"]),
  ],
  targets: [
    .target(name: "BetterSync"),
    .executableTarget(name: "BetterSyncFixtureCLI", dependencies: ["BetterSync"]),
    .testTarget(name: "BetterSyncTests", dependencies: ["BetterSync"]),
  ]
)
