---
title: Adapters
description: Drizzle, PGlite, Memory, and how to write your own.
---

# Adapters

## Drizzle + Postgres (Server)

Pass your Drizzle table objects directly. Column mapping is automatic.

```ts
import { drizzleAdapter } from 'better-sync/adapters/drizzle'
import { projects, tasks } from './db/schema'

const sync = betterSync({
  database: drizzleAdapter(db, {
    schema: { project: projects, task: tasks },
  }),
  // ...
})
```

Uses Drizzle query builder for CRUD. Raw SQL only for `ON CONFLICT ... WHERE` (conditional upsert).

## PGlite (Browser Client)

Postgres in WASM. Same SQL dialect as the server.

```ts
import { pgliteAdapter } from 'better-sync/adapters/pglite'
import { PGlite } from '@electric-sql/pglite'

const pg = new PGlite('idb://my-app')  // IndexedDB persistence
const client = createSyncClient({
  database: pgliteAdapter(pg),
  // ...
})
```

Bundle: ~1.5MB gzip. Use dynamic import in Next.js to avoid SSR issues.

## Memory (Tests)

In-memory adapter for unit tests and prototyping.

```ts
import { memoryAdapter } from 'better-sync/adapters/memory'

const adapter = memoryAdapter()
```

## Conformance Suite

Every adapter must pass 19 conformance tests:

```ts
import { CONFORMANCE_TESTS } from 'better-sync/test'

describe('my-adapter conformance', () => {
  for (const test of CONFORMANCE_TESTS) {
    it(test.name, () => test.run({ factory: () => myAdapter() }))
  }
})
```

Tests cover: CRUD, HLC-conditional upsert, cursor pagination, scope isolation, tombstone handling, transaction rollback, resurrection prevention.
