---
title: CLI
description: init, generate — scaffold and migrate.
---

# CLI

## Install

The CLI is published as `@bettersync/cli`:

```bash
npx @bettersync/cli --help
```

## init

Scaffold bettersync into an existing project:

```bash
npx @bettersync/cli init
```

Detects your framework (Next.js, NestJS, Hono, Express) and generates:
- `lib/sync.ts` — sync config
- `lib/sync-client.ts` — client config
- API route handler
- Demo page (Next.js App Router)

Use `--yes` to skip prompts.

## generate

Generate SQL schema from your sync config:

```bash
# New database — CREATE TABLE
npx @bettersync/cli generate --config lib/sync.ts

# Existing database — ALTER TABLE + backfill
npx @bettersync/cli generate --config lib/sync.ts --alter --backfill

# Save to file
npx @bettersync/cli generate --config lib/sync.ts --output migrations/sync.sql
```

The CLI reads your TypeScript config file directly (via c12 + jiti). No compilation needed.

### Options

| Flag | Description |
|---|---|
| `--config <path>` | Path to sync config file |
| `--output <file>` | Write to file (default: stdout) |
| `--alter` | ALTER TABLE for existing databases |
| `--backfill` | Include HLC backfill for existing rows |
| `--cwd <dir>` | Working directory |
| `--yes` | Skip confirmation prompts |
