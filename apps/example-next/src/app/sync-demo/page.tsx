'use client'

/**
 * The magical moment: two-tab live sync with offline support.
 *
 * 1. Open this page in two browser tabs
 * 2. Add a todo in tab A — it appears in tab B within 5 seconds
 * 3. Open devtools → Network → toggle Offline
 * 4. Add todos while offline
 * 5. Go back online — todos sync automatically
 */

import { useCallback, useRef, useState } from 'react'
import { useSync, useSyncQuery } from 'better-sync/react'
import type { Row } from 'better-sync'

export default function SyncDemoPage() {
  const sync = useSync()
  const inputRef = useRef<HTMLInputElement>(null)
  const [syncing, setSyncing] = useState(false)

  const { data: todos, refetch } = useSyncQuery(
    (client) => client.model('todo').findMany(),
    [],
  )

  const addTodo = useCallback(async () => {
    const title = inputRef.current?.value?.trim()
    if (!title) return

    await sync.model('todo').insert({
      id: crypto.randomUUID(),
      userId: 'demo-user',
      title,
      completed: false,
    })

    if (inputRef.current) inputRef.current.value = ''
    refetch()
  }, [sync, refetch])

  const toggleTodo = useCallback(
    async (todo: Row) => {
      await sync.model('todo').update(String(todo.id), {
        completed: !todo.completed,
      })
      refetch()
    },
    [sync, refetch],
  )

  const deleteTodo = useCallback(
    async (id: string) => {
      await sync.model('todo').delete(id)
      refetch()
    },
    [sync, refetch],
  )

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      await sync.syncNow()
      refetch()
    } finally {
      setSyncing(false)
    }
  }, [sync, refetch])

  return (
    <div style={{ padding: 40, maxWidth: 500, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Sync Demo</h1>
      <p style={{ color: '#666', fontSize: 14, marginBottom: 20 }}>
        Open in two tabs. Add todos. Toggle offline. Watch them sync.
      </p>

      {/* Add todo */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="What needs to be done?"
          onKeyDown={(e) => e.key === 'Enter' && addTodo()}
          style={{
            flex: 1,
            padding: '10px 14px',
            background: '#1a1a2e',
            border: '1px solid #333',
            borderRadius: 6,
            color: '#eee',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={addTodo}
          style={{
            padding: '10px 20px',
            background: '#e94560',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Add
        </button>
      </div>

      {/* Sync button */}
      <button
        type="button"
        onClick={handleSync}
        disabled={syncing}
        style={{
          width: '100%',
          padding: '8px',
          marginBottom: 16,
          background: '#16213e',
          border: '1px solid #333',
          borderRadius: 6,
          color: '#888',
          cursor: 'pointer',
          fontSize: 12,
          fontFamily: 'monospace',
        }}
      >
        {syncing ? 'Syncing...' : 'Sync now'}
      </button>

      {/* Todo list */}
      {!todos && <p style={{ color: '#666' }}>Loading...</p>}
      {todos?.length === 0 && <p style={{ color: '#666' }}>No todos yet. Add one above.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {todos?.map((todo) => (
          <li
            key={String(todo.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 0',
              borderBottom: '1px solid #1a1a2e',
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(todo.completed)}
              onChange={() => toggleTodo(todo)}
              style={{ width: 18, height: 18, cursor: 'pointer' }}
            />
            <span
              style={{
                flex: 1,
                textDecoration: todo.completed ? 'line-through' : 'none',
                color: todo.completed ? '#666' : '#eee',
              }}
            >
              {String(todo.title)}
            </span>
            <button
              type="button"
              onClick={() => deleteTodo(String(todo.id))}
              style={{
                background: 'none',
                border: 'none',
                color: '#666',
                cursor: 'pointer',
                fontSize: 16,
              }}
            >
              x
            </button>
          </li>
        ))}
      </ul>

      {/* Stats */}
      {todos && todos.length > 0 && (
        <p style={{ color: '#666', fontSize: 12, marginTop: 16, fontFamily: 'monospace' }}>
          {todos.length} todo{todos.length === 1 ? '' : 's'} ·{' '}
          {todos.filter((t) => t.completed).length} completed
        </p>
      )}
    </div>
  )
}
