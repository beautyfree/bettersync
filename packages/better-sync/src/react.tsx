/**
 * better-sync/react — React bindings for better-sync.
 *
 * Usage:
 *   import { SyncProvider, useSync, useSyncQuery, SyncDevtools } from 'better-sync/react'
 *
 *   function App() {
 *     return (
 *       <SyncProvider client={syncClient}>
 *         <ProjectList />
 *         {process.env.NODE_ENV === 'development' && <SyncDevtools />}
 *       </SyncProvider>
 *     )
 *   }
 *
 *   function ProjectList() {
 *     const { data: projects } = useSyncQuery(
 *       (sync) => sync.model('project').findMany(),
 *       [],
 *     )
 *     return <ul>{projects?.map(p => <li key={String(p.id)}>{String(p.title)}</li>)}</ul>
 *   }
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
  type ReactNode,
} from 'react'
import type { SyncClient } from '@bettersync/client'

// ─── Context ────────────────────────────────────────────────────────

const SyncContext = createContext<SyncClient | null>(null)

export interface SyncProviderProps {
  client: SyncClient
  children: ReactNode
}

/**
 * Provides the SyncClient to all child components via React context.
 * Must wrap any component that uses `useSync` or `useSyncQuery`.
 */
export function SyncProvider({ client, children }: SyncProviderProps) {
  return <SyncContext.Provider value={client}>{children}</SyncContext.Provider>
}

/**
 * Access the SyncClient from context.
 * @throws if used outside `<SyncProvider>`.
 */
export function useSync(): SyncClient {
  const client = useContext(SyncContext)
  if (!client) {
    throw new Error('useSync() must be used inside a <SyncProvider>')
  }
  return client
}

// ─── useSyncQuery ───────────────────────────────────────────────────

export interface UseSyncQueryResult<T> {
  data: T | undefined
  loading: boolean
  error: Error | null
  /** Re-execute the query manually. */
  refetch: () => void
}

/**
 * Execute a local-first query against the sync client's local store.
 * Re-runs when `deps` change or when `refetch()` is called.
 *
 * @param queryFn - async function that reads from the local store via the client.
 * @param deps - dependency array (like useEffect deps). Pass [] for run-once.
 *
 * @example
 * const { data } = useSyncQuery(
 *   (sync) => sync.model('project').findMany(),
 *   [],
 * )
 */
export function useSyncQuery<T>(
  queryFn: (client: SyncClient) => Promise<T>,
  deps: unknown[] = [],
): UseSyncQueryResult<T> {
  const client = useSync()
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [tick, bump] = useReducer((n: number) => n + 1, 0)

  const refetch = useCallback(() => bump(), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    queryFn(client)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick, ...deps])

  return { data, loading, error, refetch }
}

// ─── SyncDevtools ───────────────────────────────────────────────────

export interface SyncDevtoolsProps {
  /**
   * Position on screen. Default: 'bottom-right'.
   */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
}

interface DevtoolsState {
  open: boolean
  pendingCount: number
  lastSyncAt: string | null
  lastError: string | null
  currentHlc: string
  syncHistory: Array<{ at: string; pushed: number; pulled: number }>
}

/**
 * Floating devtools panel for sync debugging.
 *
 * Shows: pending queue count, last sync time, current HLC, sync history,
 * last error. Includes a manual "Sync now" button.
 *
 * Only render in development:
 * ```tsx
 * {process.env.NODE_ENV === 'development' && <SyncDevtools />}
 * ```
 *
 * Tree-shakeable — not included in production bundles when guarded by
 * the NODE_ENV check (bundlers remove the dead branch).
 */
export function SyncDevtools({ position = 'bottom-right' }: SyncDevtoolsProps) {
  const client = useSync()
  const [state, setState] = useState<DevtoolsState>({
    open: false,
    pendingCount: 0,
    lastSyncAt: null,
    lastError: null,
    currentHlc: client.clock.current(),
    syncHistory: [],
  })

  // Refresh state every 2 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setState((prev) => ({
        ...prev,
        currentHlc: client.clock.current(),
      }))
    }, 2000)
    return () => clearInterval(timer)
  }, [client])

  const handleSyncNow = useCallback(async () => {
    try {
      const result = await client.syncNow()
      setState((prev) => ({
        ...prev,
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        syncHistory: [
          { at: new Date().toISOString(), pushed: result.pushed, pulled: result.pulled },
          ...prev.syncHistory.slice(0, 19),
        ],
      }))
    } catch (err: unknown) {
      setState((prev) => ({
        ...prev,
        lastError: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [client])

  const positionStyle = getPositionStyle(position)

  if (!state.open) {
    return (
      <button
        type="button"
        onClick={() => setState((s) => ({ ...s, open: true }))}
        style={{
          ...positionStyle,
          position: 'fixed',
          zIndex: 99999,
          background: '#1a1a2e',
          color: '#e94560',
          border: '1px solid #e94560',
          borderRadius: '8px',
          padding: '6px 12px',
          fontSize: '12px',
          fontFamily: 'monospace',
          cursor: 'pointer',
        }}
      >
        sync
      </button>
    )
  }

  return (
    <div
      style={{
        ...positionStyle,
        position: 'fixed',
        zIndex: 99999,
        width: '360px',
        maxHeight: '400px',
        overflow: 'auto',
        background: '#1a1a2e',
        color: '#eee',
        border: '1px solid #e94560',
        borderRadius: '8px',
        padding: '12px',
        fontSize: '12px',
        fontFamily: 'monospace',
        lineHeight: 1.6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <strong style={{ color: '#e94560' }}>better-sync devtools</strong>
        <button
          type="button"
          onClick={() => setState((s) => ({ ...s, open: false }))}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '14px' }}
        >
          x
        </button>
      </div>

      <div style={{ marginBottom: '8px' }}>
        <div>HLC: <span style={{ color: '#0f3460' }}>{state.currentHlc}</span></div>
        <div>Last sync: {state.lastSyncAt ?? 'never'}</div>
        {state.lastError && (
          <div style={{ color: '#e94560' }}>Error: {state.lastError}</div>
        )}
      </div>

      <button
        type="button"
        onClick={handleSyncNow}
        style={{
          width: '100%',
          padding: '6px',
          marginBottom: '8px',
          background: '#16213e',
          color: '#e94560',
          border: '1px solid #e94560',
          borderRadius: '4px',
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontSize: '12px',
        }}
      >
        Sync now
      </button>

      {state.syncHistory.length > 0 && (
        <div>
          <div style={{ color: '#888', marginBottom: '4px' }}>History (last {state.syncHistory.length}):</div>
          {state.syncHistory.map((h) => (
            <div key={h.at} style={{ color: '#aaa', fontSize: '11px' }}>
              {new Date(h.at).toLocaleTimeString()}: +{h.pushed} pushed, +{h.pulled} pulled
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function getPositionStyle(position: string): Record<string, string> {
  switch (position) {
    case 'bottom-left': return { bottom: '16px', left: '16px' }
    case 'top-right': return { top: '16px', right: '16px' }
    case 'top-left': return { top: '16px', left: '16px' }
    default: return { bottom: '16px', right: '16px' }
  }
}
