# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@bettersync/expo-sqlite-adapter` — SQLite adapter for React Native / Expo,
  enabling true offline-first sync on iOS/Android without WASM or IndexedDB
  (19/19 conformance via a synchronous shim over better-sqlite3 in CI)
- `bettersync/hono` — `toHonoHandler` for mounting the sync endpoint on Hono
  (Node, Bun, Cloudflare Workers, Deno). Mirrors `toNextJsHandler` API
- `bettersync/adapters/expo-sqlite` subpath re-export from the meta package
- Monorepo bootstrap (pnpm + turbo + biome + vitest)
- `@bettersync/core` package skeleton
- HLC (Hybrid Logical Clock) implementation, 24 hex chars, deterministic
- Structural type guard `isSyncError` for cross-instance error checks
- Sync wire protocol types (SyncRequest, SyncResponse, Tombstone with denormalized scope)
- SyncSchema DSL (better-auth style)
- SyncAdapter interface
- Merge engine (upsertIfNewer, decideMerge)
