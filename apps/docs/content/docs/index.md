---
title: Introduction
description: Tiny local-first sync for TypeScript. Bidirectional. Drop-in.
---

# bettersync

Tiny local-first sync between Postgres and anything. Bidirectional. TypeScript-first. Drop into your existing Next.js + Drizzle/Prisma stack without replacing your data layer.

## Why bettersync?

| | bettersync | ElectricSQL | Zero |
|---|---|---|---|
| Drop into existing stack | **Yes** | No (TanStack Start) | No (own data layer) |
| Extra infrastructure | **None** | HTTP/2 + Caddy | zero-cache service |
| Install | **1 package** | scaffolded app | 4+ packages |
| SQL dialect | **Postgres everywhere** | Postgres | Postgres |
| Conflict resolution | **HLC LWW** | CRDT shapes | server authority |

## Quick Install

```bash
pnpm add bettersync
```

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
- Server re-stamps every write with its own HLC
- LWW: later HLC wins. Deterministic across all clients.
