# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo bootstrap (pnpm + turbo + biome + vitest)
- `@better-sync/core` package skeleton
- HLC (Hybrid Logical Clock) implementation, 24 hex chars, deterministic
- Structural type guard `isSyncError` for cross-instance error checks
- Sync wire protocol types (SyncRequest, SyncResponse, Tombstone with denormalized scope)
- SyncSchema DSL (better-auth style)
- SyncAdapter interface
- Merge engine (upsertIfNewer, decideMerge)
