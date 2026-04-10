# better-sync

Tiny local-first sync between Postgres and anything. Bidirectional. TypeScript-first. Drop-in to your existing Next.js + Drizzle/Prisma stack without replacing your data layer.

> **Status:** alpha / pre-v0.1. Lane A foundation in progress.

## Why

- **Drop-in** to existing Next.js + Drizzle/Prisma + tRPC. No new query layer, no sidecar service.
- **Local-first** via PGlite, SQLite, or any Drizzle/Kysely/Prisma adapter.
- **Bidirectional sync** through one HTTP endpoint, one diff per cycle.
- **Deterministic conflict resolution** via Hybrid Logical Clocks (LWW).
- **Single npm package** with subpath imports — pattern from better-auth.

## Quickstart (planned, not yet shipped)

```bash
pnpm add better-sync @electric-sql/pglite
npx better-sync init
pnpm dev
```

## Status

This package is being implemented Lane A → Lane E. Currently building `@better-sync/core`:

- [x] Monorepo bootstrap (pnpm + turbo + biome + vitest)
- [ ] HLC (Hybrid Logical Clock) — deterministic, 24 hex chars
- [ ] Errors with structural type guards
- [ ] Protocol types (SyncRequest / SyncResponse / Tombstone)
- [ ] SyncSchema DSL (better-auth style)
- [ ] SyncAdapter interface
- [ ] Merge engine (upsertIfNewer, decideMerge)
- [ ] Adapter conformance suite
- [ ] Drizzle / Kysely / Prisma / pg / PGlite adapters
- [ ] HTTP server handler
- [ ] React hooks + SyncDevtools
- [ ] Ink provider for CLI clients
- [ ] CLI scaffolding (`npx better-sync init`)

See [`design.md`](./design.md) for the full design document.

## License

[Apache 2.0](./LICENSE)
