---
title: React
description: SyncProvider, useSync, useSyncQuery, SyncDevtools.
---

# React

## Setup

```tsx
import { SyncProvider, SyncDevtools } from 'bettersync/react'
import { syncClient } from '@/lib/sync-client'

function App({ children }) {
  return (
    <SyncProvider client={syncClient}>
      {children}
      {process.env.NODE_ENV === 'development' && <SyncDevtools />}
    </SyncProvider>
  )
}
```

## useSync()

Access the SyncClient from any component:

```tsx
const sync = useSync()

await sync.model('todo').insert({ id: '...', title: 'Buy milk' })
await sync.syncNow()
```

## useSyncQuery()

Local-first reactive query:

```tsx
// Manual refetch:
const { data, refetch } = useSyncQuery(
  (sync) => sync.model('todo').findMany(),
  [],
)

// Live mode — auto-refetches on every write and sync:
const { data } = useSyncQuery(
  (sync) => sync.model('todo').findMany(),
  [],
  { live: true },
)
```

Returns `{ data, loading, error, refetch }`.

## SyncDevtools

Floating debug panel showing:
- Current HLC
- Sync history (pushed/pulled per round)
- Last error
- Manual "Sync now" button

```tsx
<SyncDevtools position="bottom-right" />
```

Positions: `bottom-right` (default), `bottom-left`, `top-right`, `top-left`.

Tree-shakeable — guarded by `NODE_ENV` check, not in production bundle.
