---
title: Getting Started
description: From zero to working sync in 6 steps.
---

# Getting Started

## 1. Install

```bash
pnpm add bettersync
# For browser client:
pnpm add @electric-sql/pglite
```

## 2. Create Sync Config

Create `lib/sync.ts` — one file, like better-auth:

```ts title="lib/sync.ts"
import { betterSync } from 'bettersync'
import { drizzleAdapter } from 'bettersync/adapters/drizzle'
import { db } from './db'

export const sync = betterSync({
  database: drizzleAdapter(db, {
    schema: { project: projects, task: tasks },
  }),
  models: {
    project: {
      fields: {
        id:     { type: 'string', primaryKey: true },
        userId: { type: 'string' },
        title:  { type: 'string' },
        changed: { type: 'string' },
      },
      scope: (ctx) => ({ userId: ctx.userId }),
    },
  },
  auth: async (req) => {
    const session = await getSession(req.headers)
    if (!session) throw new Error('Unauthorized')
    return { userId: session.user.id }
  },
})

export const syncSchema = sync.schema
```

## 3. Mount Handler

### Next.js App Router

```ts title="app/api/sync/route.ts"
import { sync } from '@/lib/sync'
export const POST = sync.handler
```

### Express / NestJS

```ts
import { toNodeHandler } from 'bettersync/node'
app.post('/api/sync', toNodeHandler(sync))
```

### Hono

```ts
app.post('/sync', (c) => sync.handler(c.req.raw))
```

### Elysia

```ts
app.mount(sync.handler)
```

## 4. Create Database Tables

```bash
npx @bettersync/cli generate --config lib/sync.ts
```

Run the generated SQL against your database.

## 5. Create Client

```ts title="lib/sync-client.ts"
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

## 6. Use in React

```tsx
import { SyncProvider, useSync, useSyncQuery, SyncDevtools } from 'bettersync/react'

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
  const { data: todos } = useSyncQuery(
    (s) => s.model('todo').findMany(), [],
    { live: true },
  )

  return (
    <ul>
      {todos?.map(t => <li key={String(t.id)}>{String(t.title)}</li>)}
    </ul>
  )
}
```

That's it. Open two tabs. Add a todo in one. See it in the other.
