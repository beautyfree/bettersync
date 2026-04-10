'use client'

import { useState, useCallback, useRef } from 'react'

// ─── Inline HLC (minimal for demo) ──────────────────────────────────

let wallOffset = 0

function now(): number {
  return Date.now() + wallOffset
}

interface HLCState {
  wall: number
  logical: number
  node: string
}

function createHLC(node: string): HLCState {
  return { wall: now(), logical: 0, node }
}

function tickHLC(state: HLCState): string {
  const w = now()
  if (w > state.wall) {
    state.wall = w
    state.logical = 0
  } else {
    state.logical += 1
  }
  return encodeHLC(state)
}

function mergeHLC(state: HLCState, remoteHlc: string): void {
  const remote = decodeHLC(remoteHlc)
  const w = now()
  if (w > state.wall && w > remote.wall) {
    state.wall = w
    state.logical = 0
  } else if (remote.wall > state.wall) {
    state.wall = remote.wall
    state.logical = remote.logical + 1
  } else if (state.wall > remote.wall) {
    state.logical += 1
  } else {
    state.logical = Math.max(state.logical, remote.logical) + 1
  }
}

function encodeHLC(s: HLCState): string {
  const w = s.wall.toString(36).padStart(9, '0')
  const l = s.logical.toString(36).padStart(4, '0')
  return `${w}-${l}-${s.node}`
}

function decodeHLC(hlc: string): { wall: number; logical: number; node: string } {
  const [w, l, ...rest] = hlc.split('-')
  return { wall: parseInt(w!, 36), logical: parseInt(l!, 36), node: rest.join('-') }
}

// ─── Sync types ──────────────────────────────────────────────────────

interface Item {
  id: string
  title: string
  changed: string
}

interface Tombstone {
  id: string
  hlc: string
}

interface ClientState {
  name: string
  node: string
  hlc: HLCState
  items: Map<string, Item>
  tombstones: Map<string, Tombstone>
  lastSyncHlc: string
}

interface ServerState {
  items: Map<string, Item>
  tombstones: Map<string, Tombstone>
}

interface LogEntry {
  ts: number
  source: string
  action: string
  detail: string
  hlc?: string
}

// ─── Component ───────────────────────────────────────────────────────

let idCounter = 0
function genId(): string {
  idCounter += 1
  return `item-${idCounter}`
}

function shortHlc(hlc: string): string {
  const parts = hlc.split('-')
  return `${parts[0]?.slice(-4)}-${parts[1]}-${parts[2]?.slice(0, 4)}`
}

export function Playground() {
  const serverRef = useRef<ServerState>({
    items: new Map(),
    tombstones: new Map(),
  })

  const [clientA, setClientA] = useState<ClientState>(() => ({
    name: 'Client A',
    node: 'aaaa',
    hlc: createHLC('aaaa'),
    items: new Map(),
    tombstones: new Map(),
    lastSyncHlc: '000000000-0000-0000',
  }))

  const [clientB, setClientB] = useState<ClientState>(() => ({
    name: 'Client B',
    node: 'bbbb',
    hlc: createHLC('bbbb'),
    items: new Map(),
    tombstones: new Map(),
    lastSyncHlc: '000000000-0000-0000',
  }))

  const [log, setLog] = useState<LogEntry[]>([])
  const [inputA, setInputA] = useState('')
  const [inputB, setInputB] = useState('')

  const addLog = useCallback((source: string, action: string, detail: string, hlc?: string) => {
    setLog((prev) => [...prev.slice(-19), { ts: Date.now(), source, action, detail, hlc }])
  }, [])

  const addItem = useCallback(
    (client: ClientState, setClient: React.Dispatch<React.SetStateAction<ClientState>>, title: string) => {
      if (!title.trim()) return
      const id = genId()
      const hlc = tickHLC(client.hlc)
      const item: Item = { id, title: title.trim(), changed: hlc }
      setClient((prev) => {
        const items = new Map(prev.items)
        items.set(id, item)
        return { ...prev, items }
      })
      addLog(client.name, 'create', `"${title.trim()}"`, hlc)
    },
    [addLog],
  )

  const deleteItem = useCallback(
    (client: ClientState, setClient: React.Dispatch<React.SetStateAction<ClientState>>, id: string) => {
      const hlc = tickHLC(client.hlc)
      const title = client.items.get(id)?.title ?? id
      setClient((prev) => {
        const items = new Map(prev.items)
        items.delete(id)
        const tombstones = new Map(prev.tombstones)
        tombstones.set(id, { id, hlc })
        return { ...prev, items, tombstones }
      })
      addLog(client.name, 'delete', `"${title}"`, hlc)
    },
    [addLog],
  )

  const syncClient = useCallback(
    (client: ClientState, setClient: React.Dispatch<React.SetStateAction<ClientState>>) => {
      const server = serverRef.current

      // 1. Push client changes to server
      let pushed = 0
      for (const [id, item] of client.items) {
        const existing = server.items.get(id)
        const tomb = server.tombstones.get(id)
        if (tomb && tomb.hlc >= item.changed) continue
        if (!existing || existing.changed < item.changed) {
          server.items.set(id, { ...item })
          pushed += 1
        }
      }
      for (const [id, tomb] of client.tombstones) {
        const existingTomb = server.tombstones.get(id)
        if (!existingTomb || existingTomb.hlc < tomb.hlc) {
          server.tombstones.set(id, { ...tomb })
          server.items.delete(id)
          pushed += 1
        }
      }

      // 2. Pull server changes to client
      let pulled = 0
      const newItems = new Map(client.items)
      const newTombs = new Map(client.tombstones)
      let maxHlc = client.lastSyncHlc

      for (const [id, item] of server.items) {
        if (item.changed <= client.lastSyncHlc) continue
        const existing = newItems.get(id)
        const localTomb = newTombs.get(id)
        if (localTomb && localTomb.hlc >= item.changed) continue
        if (!existing || existing.changed < item.changed) {
          newItems.set(id, { ...item })
          mergeHLC(client.hlc, item.changed)
          pulled += 1
        }
        if (item.changed > maxHlc) maxHlc = item.changed
      }
      for (const [id, tomb] of server.tombstones) {
        if (tomb.hlc <= client.lastSyncHlc) continue
        const existingTomb = newTombs.get(id)
        if (!existingTomb || existingTomb.hlc < tomb.hlc) {
          newTombs.set(id, { ...tomb })
          newItems.delete(id)
          mergeHLC(client.hlc, tomb.hlc)
          pulled += 1
        }
        if (tomb.hlc > maxHlc) maxHlc = tomb.hlc
      }

      setClient((prev) => ({
        ...prev,
        items: newItems,
        tombstones: newTombs,
        lastSyncHlc: maxHlc,
      }))

      addLog(client.name, 'sync', `pushed ${pushed}, pulled ${pulled}`)
    },
    [addLog],
  )

  const reset = useCallback(() => {
    idCounter = 0
    wallOffset = 0
    serverRef.current = { items: new Map(), tombstones: new Map() }
    setClientA({
      name: 'Client A',
      node: 'aaaa',
      hlc: createHLC('aaaa'),
      items: new Map(),
      tombstones: new Map(),
      lastSyncHlc: '000000000-0000-0000',
    })
    setClientB({
      name: 'Client B',
      node: 'bbbb',
      hlc: createHLC('bbbb'),
      items: new Map(),
      tombstones: new Map(),
      lastSyncHlc: '000000000-0000-0000',
    })
    setLog([])
    setInputA('')
    setInputB('')
  }, [])

  const serverItemCount = serverRef.current.items.size
  const serverTombCount = serverRef.current.tombstones.size

  return (
    <div className="not-prose space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border bg-fd-card px-3 py-1.5 text-xs font-medium">
            Server: {serverItemCount} items, {serverTombCount} tombstones
          </div>
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-fd-accent"
        >
          Reset
        </button>
      </div>

      {/* Two client panels */}
      <div className="grid gap-4 md:grid-cols-2">
        <ClientPanel
          client={clientA}
          input={inputA}
          onInputChange={setInputA}
          onAdd={(title) => {
            addItem(clientA, setClientA, title)
            setInputA('')
          }}
          onDelete={(id) => deleteItem(clientA, setClientA, id)}
          onSync={() => syncClient(clientA, setClientA)}
          color="blue"
        />
        <ClientPanel
          client={clientB}
          input={inputB}
          onInputChange={setInputB}
          onAdd={(title) => {
            addItem(clientB, setClientB, title)
            setInputB('')
          }}
          onDelete={(id) => deleteItem(clientB, setClientB, id)}
          onSync={() => syncClient(clientB, setClientB)}
          color="violet"
        />
      </div>

      {/* Sync log */}
      <div className="rounded-xl border">
        <div className="border-b px-4 py-2.5">
          <h3 className="text-sm font-semibold">Sync Log</h3>
        </div>
        <div className="max-h-48 overflow-y-auto p-2">
          {log.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-fd-muted-foreground">
              Add items and sync to see the log
            </p>
          ) : (
            <div className="space-y-0.5">
              {log.map((entry, i) => (
                <div key={i} className="flex items-baseline gap-2 rounded px-2 py-1 text-xs hover:bg-fd-accent/50">
                  <span
                    className={`font-semibold ${
                      entry.source === 'Client A' ? 'text-blue-500' : 'text-violet-500'
                    }`}
                  >
                    {entry.source}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      entry.action === 'create'
                        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                        : entry.action === 'delete'
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                          : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    }`}
                  >
                    {entry.action}
                  </span>
                  <span className="text-fd-muted-foreground">{entry.detail}</span>
                  {entry.hlc && (
                    <code className="ml-auto text-[10px] text-fd-muted-foreground">{shortHlc(entry.hlc)}</code>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* How it works */}
      <details className="rounded-xl border">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold hover:bg-fd-accent/50">
          How does this work?
        </summary>
        <div className="space-y-2 border-t px-4 py-3 text-xs text-fd-muted-foreground">
          <p>
            Each client maintains a <strong>Hybrid Logical Clock (HLC)</strong> that combines wall-clock time with a
            logical counter and a node ID. This ensures every change gets a globally unique, monotonically increasing
            timestamp.
          </p>
          <p>
            When you <strong>sync</strong>, the client pushes local changes to the server and pulls remote changes.
            Conflicts are resolved with <strong>Last-Write-Wins (LWW)</strong> — the change with the higher HLC wins.
          </p>
          <p>
            <strong>Tombstones</strong> track deletions. When Client A deletes an item, the tombstone prevents Client B
            from resurrecting it with a stale write.
          </p>
          <p>
            This is exactly how <code>bettersync</code> works — but with real Postgres on the server and PGlite in the
            browser.
          </p>
        </div>
      </details>
    </div>
  )
}

// ─── Client Panel ────────────────────────────────────────────────────

interface ClientPanelProps {
  client: ClientState
  input: string
  onInputChange: (v: string) => void
  onAdd: (title: string) => void
  onDelete: (id: string) => void
  onSync: () => void
  color: 'blue' | 'violet'
}

function ClientPanel({ client, input, onInputChange, onAdd, onDelete, onSync, color }: ClientPanelProps) {
  const items = Array.from(client.items.values()).sort((a, b) => a.changed.localeCompare(b.changed))
  const accent = color === 'blue' ? 'text-blue-500' : 'text-violet-500'
  const border = color === 'blue' ? 'border-blue-500/30' : 'border-violet-500/30'
  const syncBg =
    color === 'blue'
      ? 'bg-blue-500 hover:bg-blue-600 text-white'
      : 'bg-violet-500 hover:bg-violet-600 text-white'

  return (
    <div className={`rounded-xl border ${border}`}>
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div>
          <h3 className={`text-sm font-semibold ${accent}`}>{client.name}</h3>
          <p className="text-[10px] text-fd-muted-foreground">
            node: {client.node} &middot; {client.items.size} items &middot; {client.tombstones.size} tombstones
          </p>
        </div>
        <button
          type="button"
          onClick={onSync}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${syncBg}`}
        >
          Sync
        </button>
      </div>

      {/* Add form */}
      <div className="border-b p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onAdd(input)
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="New item..."
            className="flex-1 rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-fd-muted-foreground focus:border-fd-primary"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-fd-accent disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </div>

      {/* Items */}
      <div className="max-h-56 min-h-[80px] overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-fd-muted-foreground">No items yet</p>
        ) : (
          <div className="divide-y">
            {items.map((item) => (
              <div key={item.id} className="group flex items-center gap-2 px-4 py-2">
                <span className="flex-1 text-sm">{item.title}</span>
                <code className="text-[10px] text-fd-muted-foreground">{shortHlc(item.changed)}</code>
                <button
                  type="button"
                  onClick={() => onDelete(item.id)}
                  className="text-xs text-fd-muted-foreground opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                  title="Delete"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
