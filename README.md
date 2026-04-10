# better-sync

Tiny local-first sync for TypeScript. Bidirectional. Drop into your existing Next.js + Drizzle stack without replacing your data layer.

```bash
pnpm add better-sync
```

## Getting Started

### 1. Install

```bash
pnpm add better-sync
# For browser client (PGlite = Postgres in WASM):
pnpm add @electric-sql/pglite
```

### 2. Create Sync Config

Create `lib/sync.ts` — one file, like better-auth:

```ts
import { betterSync } from 'better-sync'
import { drizzleAdapter } from 'better-sync/adapters/drizzle'
import { db } from './db' // your Drizzle instance

export const sync = betterSync({
  database: drizzleAdapter(db),
  models: {
    todo: {
      fields: {
        id:        { type: 'string', primaryKey: true },
        userId:    { type: 'string' },
        title:     { type: 'string' },
        completed: { type: 'boolean', required: false },
        changed:   { type: 'string' },
      },
      scope: (ctx) => ({ userId: ctx.userId }),
    },
  },
})

export const syncSchema = sync.schema
```

### 3. Mount Handler

Create `app/api/sync/route.ts`:

```ts
import { sync } from '@/lib/sync'
import { toNextJsHandler } from 'better-sync/next-js'

export const POST = toNextJsHandler(sync, {
  auth: async (req) => {
    const session = await getSession(req)
    if (!session) throw new Error('Unauthorized')
    return { userId: session.user.id }
  },
})
```

### 4. Create Database Tables

```bash
npx better-sync generate  # coming soon — for now, create tables manually
```

### 5. Create Client

Create `lib/sync-client.ts`:

```ts
import { createSyncClient } from 'better-sync/client'
import { pgliteAdapter } from 'better-sync/adapters/pglite'
import { PGlite } from '@electric-sql/pglite'
import { syncSchema } from './sync'

export const syncClient = createSyncClient({
  database: pgliteAdapter(new PGlite('idb://my-app')),
  schema: syncSchema,
  syncUrl: '/api/sync',
})
```

### 6. Use in React

```tsx
import { SyncProvider, useSync, useSyncQuery, SyncDevtools } from 'better-sync/react'
import { syncClient } from '@/lib/sync-client'

function App() {
  return (
    <SyncProvider client={syncClient}>
      <TodoList />
      <SyncDevtools />
    </SyncProvider>
  )
}

function TodoList() {
  const sync = useSync()
  const { data: todos, refetch } = useSyncQuery(
    (s) => s.model('todo').findMany(),
    [],
  )

  return (
    <div>
      <button onClick={async () => {
        await sync.model('todo').insert({
          id: crypto.randomUUID(),
          userId: 'me',
          title: 'Buy milk',
        })
        refetch()
      }}>Add</button>
      {todos?.map(t => <div key={String(t.id)}>{String(t.title)}</div>)}
    </div>
  )
}
```

That's it. Open two tabs. Add a todo in one. See it in the other.

## Why

| | better-sync | ElectricSQL | Zero |
|---|---|---|---|
| Drop into existing Next.js + Drizzle | **Yes** | No (TanStack Start) | No (own data layer) |
| Extra infrastructure | **None** | HTTP/2 + Caddy | zero-cache service |
| Install | **1 package** | scaffolded app | 4+ packages |
| SQL dialect | **Postgres everywhere** | Postgres | Postgres |
| Conflict resolution | **HLC LWW** | CRDT shapes | server authority |
| License | **Apache 2.0** | Apache 2.0 | MIT |

## Packages

One install — `pnpm add better-sync`. Everything via subpath imports:

| Import | What |
|---|---|
| `better-sync` | Core + betterSync() + createSyncServer + createSyncClient |
| `better-sync/client` | Client engine |
| `better-sync/server` | Handler + hooks |
| `better-sync/next-js` | toNextJsHandler |
| `better-sync/react` | SyncProvider, useSync, useSyncQuery, SyncDevtools |
| `better-sync/adapters/drizzle` | Drizzle + Postgres |
| `better-sync/adapters/pglite` | PGlite (Postgres WASM) |
| `better-sync/adapters/memory` | In-memory (tests) |
| `better-sync/test` | Conformance suite |

## How It Works

```
Client (PGlite)                    Server (Postgres)
┌──────────────┐                   ┌──────────────┐
│ Local write   │─── syncNow() ───▶│ Apply writes  │
│ Pending queue │                  │ Scope check   │
│ HLC clock     │◀── response ────│ Return changes│
│ Apply merge   │                  │ HLC re-stamp  │
└──────────────┘                   └──────────────┘
```

- Writes go to local store first (instant, works offline)
- `syncNow()` pushes pending + pulls remote changes
- Server re-stamps every write with its own HLC (monotonic ordering)
- LWW: later HLC wins. Deterministic across all clients.
- Tombstones carry denormalized scope (no cross-tenant ID leak)
- Compound (changed, id) cursor for stable pagination

## Status

Alpha. API may change before v1.0.

- [x] HLC (Hybrid Logical Clock) — deterministic 24-hex
- [x] Server handler with scope enforcement + hooks
- [x] Client with local-first CRUD + persisted pending queue + polling
- [x] Drizzle + Postgres adapter (19/19 conformance)
- [x] PGlite adapter (19/19 conformance, no Docker)
- [x] Memory adapter + shared conformance suite (19 tests)
- [x] React: SyncProvider, useSync, useSyncQuery, SyncDevtools
- [x] Next.js: toNextJsHandler
- [x] Single meta-package with 9 subpath exports
- [x] Example Next.js app with two-tab sync demo
- [ ] CLI: `npx better-sync init` / `generate` / `migrate`
- [ ] Kysely, Prisma, better-sqlite3 adapters
- [ ] recover() for stale clients
- [ ] watch() reactive queries
- [ ] Hono, Express, Elysia, Fastify handlers

## License

[Apache 2.0](./LICENSE)
