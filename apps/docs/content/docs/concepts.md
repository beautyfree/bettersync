---
title: Core Concepts
description: HLC, schema, scope, tombstones, and how sync works.
---

# Core Concepts

## Hybrid Logical Clock (HLC)

Every write gets a deterministic timestamp: 24 hex characters encoding `(wall_ms, logical_counter, node_id)`.

```
01941d8c2e800001a3f7e2c1
└──────────┘└──┘└──────┘
  wall (48b) log  node
```

- Lexicographic string compare = temporal compare
- No randomness (unlike ULID) — two clients always agree on ordering
- Clock skew handled via `max()` merge rule

## Schema

Models are defined in `betterSync({ models })`:

```ts
models: {
  project: {
    fields: {
      id:      { type: 'string', primaryKey: true },
      userId:  { type: 'string' },
      title:   { type: 'string' },
      changed: { type: 'string' },  // HLC field
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
}
```

Field types: `string`, `number`, `boolean`, `date`, `json`, `['enum', 'values']`.

## Scope (Multi-tenancy)

The `scope` function returns a predicate applied to ALL queries:

```ts
scope: (ctx) => ({ userId: ctx.userId })
```

This ensures:
- Client A only sees their own rows
- Client A cannot write to another user's rows (SCOPE_VIOLATION error)
- Tombstones carry denormalized scope to prevent cross-tenant ID leaks

## Tombstones

Deletes are tracked via tombstone records with:
- `model` + `id` — which row was deleted
- `hlc` — when it was deleted
- `scope` — who owned it (denormalized at delete time)

Tombstones are garbage collected after 30 days (configurable). Clients that haven't synced within the retention window are flagged as stale and must call `recover()`.

## Last-Write-Wins (LWW)

When two clients modify the same row concurrently, the server re-stamps both writes with its own HLC. The later server-stamped HLC wins.

Server re-stamping is critical: without it, clients with skewed clocks could silently lose writes.

## Pending Queue

Client writes go to a persisted pending queue (in the local adapter). On `syncNow()`, pending writes are pushed to the server and cleared after acknowledgment. If the app crashes, pending writes survive and are pushed on next start.
