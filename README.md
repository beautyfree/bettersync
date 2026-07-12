# bettersync

Tiny local-first sync for TypeScript. Bidirectional. Drop into your existing Next.js + Drizzle stack without replacing your data layer.

```bash
pnpm add bettersync
```

## Getting Started

### 1. Install

```bash
pnpm add bettersync
# For browser client (PGlite = Postgres in WASM):
pnpm add @electric-sql/pglite
```

### 2. Create Sync Config

Create `lib/sync.ts` — one file, like better-auth:

```ts
import { betterSync } from 'bettersync'
import { drizzleAdapter } from 'bettersync/adapters/drizzle'
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
      tombstoneScope: ['userId'],
    },
  },
})

export const syncSchema = sync.schema
```

### 3. Mount Handler

Create `app/api/sync/route.ts`:

```ts
import { sync } from '@/lib/sync'
import { toNextJsHandler } from 'bettersync/next-js'

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
npx @bettersync/cli generate --config src/lib/sync.ts --output migrations/bettersync.sql
```

Review generated SQL, commit it, then apply it through your normal database
migration system. `ensureSyncTables()` creates only bettersync internal tables;
it never mutates application tables in production.

For an existing table, generate a reviewable HLC migration:

```bash
npx @bettersync/cli generate --alter --backfill --config src/lib/sync.ts --output migrations/add-bettersync.sql
```

### Column Mapping

Keep logical TypeScript names while using existing snake_case tables:

```ts
project: {
  fields: {
    id: { type: 'string', primaryKey: true },
    userId: { type: 'string', columnName: 'user_id' },
    displayName: { type: 'string', columnName: 'display_name' },
    changed: { type: 'string' },
  },
}
```

Raw adapters map CRUD, scope, sort, sync rows, and pagination fields. Keep
`changed` unchanged by default. If an existing HLC column has another physical
name, configure that physical `hlcField` on the raw adapter; mapping otherwise
fails closed rather than creating a second clock column.

### Rolling Upgrades And Data Safety

Deploy server before client. Server accepts legacy v1 plain rows/tombstones and
new idempotent operation envelopes in the same v1 protocol. Never reset or
delete a local database during an upgrade. Schema row migrations and pending
outbox rewrites run in one local transaction; database DDL stays a reviewed,
explicit migration from the CLI output.

### 5. Create Client

Create `lib/sync-client.ts`:

```ts
import { createSyncClient } from 'bettersync/client'
import { pgliteAdapter } from 'bettersync/adapters/pglite'
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
import { SyncProvider, useSync, useSyncQuery, SyncDevtools } from 'bettersync/react'
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

| | bettersync | ElectricSQL | Zero |
|---|---|---|---|
| Drop into existing Next.js + Drizzle | **Yes** | No (TanStack Start) | No (own data layer) |
| Extra infrastructure | **None** | HTTP/2 + Caddy | zero-cache service |
| Install | **1 package** | scaffolded app | 4+ packages |
| SQL dialect | **Postgres everywhere** | Postgres | Postgres |
| Conflict resolution | **HLC LWW** | CRDT shapes | server authority |
| License | **Apache 2.0** | Apache 2.0 | MIT |

## Packages

One install — `pnpm add bettersync`. Everything via subpath imports:

| Import | What |
|---|---|
| `bettersync` | Core + betterSync() + createSyncServer + createSyncClient |
| `bettersync/client` | Client engine |
| `bettersync/server` | Handler + hooks |
| `bettersync/next-js` | toNextJsHandler |
| `bettersync/hono` | toHonoHandler (Node, Bun, Workers, Deno) |
| `bettersync/node` | toNodeHandler (Express/Fastify/Nest) |
| `bettersync/react` | SyncProvider, useSync, useSyncQuery, SyncDevtools |
| `bettersync/adapters/drizzle` | Drizzle + Postgres |
| `bettersync/adapters/pg` | node-postgres |
| `bettersync/adapters/pglite` | PGlite (Postgres WASM, web) |
| `bettersync/adapters/kysely` | Kysely |
| `bettersync/adapters/prisma` | Prisma |
| `bettersync/adapters/better-sqlite3` | SQLite (Node / Electron) |
| `bettersync/adapters/expo-sqlite` | SQLite (React Native / Expo) — offline-first on mobile |
| `bettersync/adapters/memory` | In-memory (tests) |
| `bettersync/test` | Conformance suite |

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
- Optional realtime events only wake clients up; clients still pull scoped rows through `syncNow()`

### Realtime Wake-Ups

Polling is the default fallback, but apps can add SSE/WebSocket/push wake-ups for faster cross-device freshness.
Realtime events intentionally carry no row data. They only tell the client that something changed, then the client calls
`syncNow({ drain: true })` and receives scoped data through the normal sync protocol.

For large mobile fleets, do not keep every app process connected to SSE. Use `realtime.publish()` as a bridge to
APNs/FCM/silent push or a queue-backed fanout service. SSE/EventSource is useful for web, dev tools, admin panels, and
small always-online cohorts. Polling remains the correctness fallback.

```ts
import { createInMemoryRealtimeBus, createSyncServer } from 'bettersync/server'

const realtime = createInMemoryRealtimeBus<AuthCtx>({
  topic: (ctx) => ctx.familyId,
  debounceMs: 100,
  maxSubscribers: 10_000,
})

const sync = createSyncServer({
  schema,
  database,
  auth,
  realtime,
})

app.post('/api/sync', (c) => sync.handler(c.req.raw))
app.get('/api/sync/events', (c) => realtime.handler(auth)(c.req.raw))
```

```ts
import { createSyncClient } from 'bettersync/client'

const client = createSyncClient({
  database,
  schema,
  syncUrl: '/api/sync',
  eventsUrl: '/api/sync/events',
})
```

React Native does not ship `EventSource` by default. In RN/Expo, pass a custom `realtime.subscribe` transport or an
EventSource polyfill.

Production shape:

- Server applies writes once, commits, then fires one model-only wake-up event.
- Wake-up events are coalesced per topic to avoid notification storms.
- Mobile push notification should only wake the app to run `syncNow({ drain: true })`.
- No row payloads go through push. Authz and scoping stay in the sync endpoint.
- If push delivery is delayed or dropped, next poll/app foreground still catches up.

## Status

Alpha. API may change before v1.0.

- [x] HLC (Hybrid Logical Clock) — deterministic 24-hex
- [x] Server handler with scope enforcement + hooks
- [x] Client with local-first CRUD + persisted pending queue + polling
- [x] Drizzle + Postgres adapter (19/19 conformance)
- [x] PGlite adapter (19/19 conformance, no Docker)
- [x] Memory adapter + shared conformance suite (19 tests)
- [x] React: SyncProvider, useSync, useSyncQuery, SyncDevtools
- [x] Realtime wake-up events via custom transport or SSE/EventSource
- [x] Next.js: toNextJsHandler
- [x] Hono: toHonoHandler (Node / Bun / Workers / Deno)
- [x] Node: toNodeHandler (Express / Fastify / Nest)
- [x] Kysely, Prisma, better-sqlite3 adapters
- [x] expo-sqlite adapter — offline-first React Native / Expo
- [x] Single meta-package with subpath exports
- [x] Example Next.js app with two-tab sync demo
- [x] CLI: `npx @bettersync/cli init` / `generate`
- [x] recover() for stale clients
- [ ] watch() reactive queries
- [ ] Express, Elysia, Fastify dedicated handlers

## License

[Apache 2.0](./LICENSE)
