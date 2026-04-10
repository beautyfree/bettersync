'use client';

import { useState } from 'react';

const PROMPT = `You are integrating bettersync into an existing project. bettersync is a local-first bidirectional sync engine for TypeScript. It syncs data between a server (Postgres) and clients (browser via PGlite, Node via SQLite).

Documentation: https://bettersync.vercel.app/docs
npm: https://www.npmjs.com/package/bettersync
GitHub: https://github.com/beautyfree/bettersync

## Your task

1. **Analyze the project** — detect the framework (Next.js, NestJS, Hono, Express, Fastify, Elysia, Bun), package manager, ORM (Drizzle, Prisma, or none), existing database, auth solution, and directory structure (src/ or not, App Router vs Pages Router for Next.js).

2. **Ask the user:**
   - Which models/tables should be synced? (e.g. "projects and tasks")
   - What is the scope field for multi-tenancy? (e.g. "userId" — each user sees only their data)
   - Should the client use PGlite (browser Postgres WASM) or memory adapter (for prototyping)?
   - What auth method is used? (JWT, session, Clerk, better-auth, etc.)

3. **Install bettersync:**
   \`\`\`bash
   pnpm add bettersync
   # If using PGlite for browser client:
   pnpm add @electric-sql/pglite
   \`\`\`

4. **Create the sync config file** (e.g. \`lib/sync.ts\` or \`src/lib/sync.ts\`):
   \`\`\`ts
   import { betterSync } from 'bettersync'
   // Import your adapter (drizzleAdapter for Drizzle, memoryAdapter for prototyping)

   export const sync = betterSync({
     database: yourAdapter,
     models: {
       // Define each model the user wants to sync with:
       // fields (id, userId, title, changed — HLC field required)
       // scope function for multi-tenancy
     },
     auth: async (req) => {
       // Extract userId from the request using the project's auth solution
     },
   })
   export const syncSchema = sync.schema
   \`\`\`

5. **Mount the sync handler:**
   - Next.js App Router: \`app/api/sync/route.ts\` → \`export const POST = sync.handler\`
   - Next.js Pages Router: \`pages/api/sync.ts\` → use \`parseSyncRequest\` + \`handleSync\`
   - Express/NestJS/Fastify: \`import { toNodeHandler } from 'bettersync/node'\` → \`app.post('/api/sync', toNodeHandler(sync))\`
   - Hono: \`app.post('/sync', (c) => sync.handler(c.req.raw))\`
   - Elysia: \`app.mount('/sync', sync.handler)\`

6. **Create the client config** (e.g. \`lib/sync-client.ts\`):
   \`\`\`ts
   import { createSyncClient } from 'bettersync/client'
   import { pgliteAdapter } from 'bettersync/adapters/pglite'
   import { PGlite } from '@electric-sql/pglite'
   import { syncSchema } from './sync'

   export const syncClient = createSyncClient({
     database: pgliteAdapter(new PGlite('idb://app-name')),
     schema: syncSchema,
     syncUrl: '/api/sync',   // or full URL for cross-origin
     headers: () => ({       // if auth requires headers
       Authorization: \\\`Bearer \\\${getToken()}\\\`,
     }),
   })
   \`\`\`

7. **Generate database migration:**
   \`\`\`bash
   npx @bettersync/cli generate --config lib/sync.ts
   # For existing tables:
   npx @bettersync/cli generate --config lib/sync.ts --alter --backfill
   \`\`\`

8. **If React** — wrap the app with SyncProvider:
   \`\`\`tsx
   import { SyncProvider, SyncDevtools } from 'bettersync/react'
   // Use dynamic import for PGlite to avoid SSR issues in Next.js
   // Use useSyncQuery((s) => s.model('todo').findMany(), [], { live: true }) for reactive queries
   \`\`\`

## Important details

- The \`changed\` field (HLC) MUST be declared in every model's fields. It's how sync tracks versions.
- The Drizzle adapter accepts Drizzle table objects directly: \`drizzleAdapter(db, { schema: { project: projectsTable } })\`. Column mapping is automatic.
- PGlite in Next.js MUST be dynamically imported (client-only) to avoid SSR crashes.
- \`sync.handler\` is a standard Web API \`(req: Request) => Promise<Response>\` handler.
- \`toNodeHandler(sync)\` converts it for Express/Fastify/NestJS.
- For live reactive queries use \`useSyncQuery(fn, deps, { live: true })\` — auto-refetches on every local write and sync.
- \`sync.on('change', callback)\` for event-driven updates outside React.

## After setup

Tell the user to open the app in two browser tabs, make a change in one tab, and verify it appears in the other. That's the magical moment.`;

export function CopyPromptButton({ variant = 'default' }: { variant?: 'default' | 'compact' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
      >
        {copied ? '✓ Copied!' : '📋 Copy AI prompt'}
      </button>
    );
  }

  return (
    <div className="rounded-xl border bg-fd-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">Set up with AI</h3>
          <p className="mt-1 text-sm text-fd-muted-foreground">
            Copy this prompt into Claude, Cursor, or Copilot. It will analyze your project,
            ask what to sync, and generate all the code.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          {copied ? '✓ Copied!' : 'Copy prompt'}
        </button>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-fd-muted-foreground hover:text-fd-foreground">
          Preview prompt ({Math.round(PROMPT.length / 1000)}k chars)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-fd-secondary p-3 text-xs whitespace-pre-wrap">
          {PROMPT}
        </pre>
      </details>
    </div>
  );
}
