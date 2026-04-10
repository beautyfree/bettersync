'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { SyncProvider, SyncDevtools } from 'bettersync/react'
import type { SyncClient } from 'bettersync/client'

export function SyncClientProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SyncClient | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Dynamic import — PGlite stays out of the server bundle
    import('@/lib/sync-client').then(async ({ syncClient }) => {
      if (cancelled) return
      await syncClient.start()
      if (!cancelled) setClient(syncClient)
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [])

  if (error) return <div style={{ padding: 20, color: '#e94560', fontFamily: 'monospace' }}>Sync failed: {error}</div>
  if (!client) return <div style={{ padding: 20, color: '#666', fontFamily: 'monospace' }}>Loading local database...</div>

  return (
    <SyncProvider client={client}>
      {children}
      <SyncDevtools />
    </SyncProvider>
  )
}
