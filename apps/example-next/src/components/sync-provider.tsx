'use client'

/**
 * Client-side SyncProvider — lazy-loads PGlite to avoid SSR issues.
 *
 * PGlite uses WASM and browser APIs (IndexedDB). It CANNOT be imported
 * in Server Components. This provider initializes it inside useEffect
 * (client-only) and wraps children with <SyncProvider>.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { SyncProvider, SyncDevtools } from 'better-sync/react'
import type { SyncClient } from 'better-sync/client'

export function SyncClientProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // Dynamic import — PGlite never hits the server bundle
        const [{ createSyncClient }, { pgliteAdapter }, { PGlite }, { syncSchema }] =
          await Promise.all([
            import('better-sync/client'),
            import('better-sync/adapters/pglite'),
            import('@electric-sql/pglite'),
            import('@/lib/schema'),
          ])

        if (cancelled) return

        const pg = new PGlite('idb://better-sync-demo')
        const syncClient = createSyncClient({
          database: pgliteAdapter(pg),
          schema: syncSchema,
          transport: async (req) => {
            const res = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req),
            })
            if (!res.ok) {
              const body = await res.json().catch(() => ({}))
              throw new Error(body.error?.message ?? `Sync failed: ${res.status}`)
            }
            return res.json()
          },
          pollInterval: 5_000, // 5s for demo (30s default)
        })

        await syncClient.start()
        if (!cancelled) setClient(syncClient)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div style={{ padding: 20, color: '#e94560', fontFamily: 'monospace' }}>
        Sync init failed: {error}
      </div>
    )
  }

  if (!client) {
    return (
      <div style={{ padding: 20, color: '#888', fontFamily: 'monospace' }}>
        Loading local database...
      </div>
    )
  }

  return (
    <SyncProvider client={client}>
      {children}
      <SyncDevtools position="bottom-right" />
    </SyncProvider>
  )
}
