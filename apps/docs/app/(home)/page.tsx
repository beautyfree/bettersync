import Link from 'next/link';
import { CodeBlock } from '@/components/code-block';

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-20 px-6 py-14 md:py-20">
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section className="space-y-8 text-center">
        <div className="inline-flex items-center rounded-full border px-3 py-1 text-sm text-fd-muted-foreground">
          v0.0.1 — local-first sync for TypeScript
        </div>
        <h1 className="mx-auto max-w-4xl text-4xl font-bold tracking-tight md:text-6xl lg:text-7xl">
          The sync engine that{' '}
          <span className="bg-gradient-to-r from-blue-500 to-violet-500 bg-clip-text text-transparent">
            drops into your stack
          </span>
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-fd-muted-foreground md:text-xl">
          Bidirectional sync between Postgres and any client. Offline-first. One package.
          Works with your existing Next.js + Drizzle/Prisma + tRPC.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs/getting-started"
            className="inline-flex items-center rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started in 2 minutes
          </Link>
          <Link
            href="https://github.com/beautyfree/bettersync"
            className="inline-flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            GitHub
          </Link>
        </div>
        <div className="mx-auto max-w-md">
          <CodeBlock lang="bash" code="pnpm add bettersync" />
        </div>
      </section>

      {/* ─── Features grid (9 cards) ─────────────────────────── */}
      <section className="space-y-8">
        <h2 className="text-center text-2xl font-semibold md:text-3xl">Everything you need</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {features.map((f) => (
            <article key={f.title} className="rounded-xl border p-5 transition-colors hover:bg-fd-accent/50">
              <div className="mb-2 text-2xl">{f.icon}</div>
              <h3 className="text-base font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-fd-muted-foreground">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ─── Code example ────────────────────────────────────── */}
      <section className="space-y-6">
        <h2 className="text-center text-2xl font-semibold md:text-3xl">3 files. That&apos;s it.</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="overflow-hidden rounded-xl border">
            <p className="px-4 pt-3 text-xs font-medium text-fd-muted-foreground">lib/sync.ts</p>
            <CodeBlock lang="ts" code={codeSync} />
          </div>
          <div className="overflow-hidden rounded-xl border">
            <p className="px-4 pt-3 text-xs font-medium text-fd-muted-foreground">app/api/sync/route.ts</p>
            <CodeBlock lang="ts" code={codeRoute} />
          </div>
          <div className="overflow-hidden rounded-xl border">
            <p className="px-4 pt-3 text-xs font-medium text-fd-muted-foreground">lib/sync-client.ts</p>
            <CodeBlock lang="ts" code={codeClient} />
          </div>
        </div>
      </section>

      {/* ─── Comparison table ────────────────────────────────── */}
      <section className="space-y-6">
        <h2 className="text-center text-2xl font-semibold md:text-3xl">How it compares</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-fd-card">
                <th className="p-3 text-left font-medium"></th>
                <th className="p-3 text-left font-semibold text-blue-500">bettersync</th>
                <th className="p-3 text-left font-medium">ElectricSQL</th>
                <th className="p-3 text-left font-medium">Zero</th>
                <th className="p-3 text-left font-medium">PowerSync</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((row) => (
                <tr key={row.label} className="border-b last:border-0">
                  <td className="p-3 text-fd-muted-foreground">{row.label}</td>
                  <td className="p-3 font-medium">{row.us}</td>
                  <td className="p-3 text-fd-muted-foreground">{row.electric}</td>
                  <td className="p-3 text-fd-muted-foreground">{row.zero}</td>
                  <td className="p-3 text-fd-muted-foreground">{row.powersync}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ─── Frameworks ──────────────────────────────────────── */}
      <section className="space-y-6 text-center">
        <h2 className="text-2xl font-semibold md:text-3xl">Works with your framework</h2>
        <p className="text-fd-muted-foreground">
          One handler. Standard Web API. Every framework supported.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {frameworks.map((fw) => (
            <span key={fw} className="rounded-lg border px-4 py-2 text-sm font-medium">
              {fw}
            </span>
          ))}
        </div>
      </section>

      {/* ─── Subpath exports ─────────────────────────────────── */}
      <section className="space-y-6">
        <h2 className="text-center text-2xl font-semibold md:text-3xl">One package. Many exports.</h2>
        <div className="grid gap-2 md:grid-cols-3">
          {subpaths.map((sp) => (
            <div key={sp.path} className="rounded-lg border px-4 py-3">
              <code className="text-sm font-medium text-blue-500">{sp.path}</code>
              <p className="mt-0.5 text-xs text-fd-muted-foreground">{sp.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border bg-fd-card p-8 text-center md:p-12">
        <h2 className="text-2xl font-semibold md:text-3xl">Ready to sync?</h2>
        <p className="mt-3 text-fd-muted-foreground">
          From zero to two-tab live sync in under 2 minutes.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/docs/getting-started"
            className="inline-flex items-center rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            href="https://www.npmjs.com/package/bettersync"
            className="inline-flex items-center rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            npm
          </Link>
        </div>
      </section>
    </main>
  );
}

const features = [
  { icon: '🔌', title: 'Drop-in', body: 'Works with Next.js, Express, NestJS, Hono, Elysia, Fastify, Bun. No rewrite.' },
  { icon: '📦', title: 'One package', body: 'pnpm add bettersync. 9 subpath exports. Everything included.' },
  { icon: '🐘', title: 'Postgres everywhere', body: 'PGlite in browser, Postgres on server. Same SQL dialect, same adapter pattern.' },
  { icon: '📡', title: 'Offline-first', body: 'Writes go to local store first. Sync happens in background when online.' },
  { icon: '⏱️', title: 'HLC conflict resolution', body: 'Hybrid Logical Clock + Last-Write-Wins. Deterministic across all clients.' },
  { icon: '🔒', title: 'Multi-tenant scope', body: 'Per-model scope functions. Client A never sees client B data. Enforced server-side.' },
  { icon: '⚛️', title: 'React hooks', body: 'SyncProvider, useSync, useSyncQuery with live mode. SyncDevtools built in.' },
  { icon: '🛠️', title: 'CLI tooling', body: 'npx bettersync init scaffolds your project. generate creates SQL migrations.' },
  { icon: '✅', title: '205+ tests', body: '19-test conformance suite. Drizzle + PGlite adapters tested against real Postgres.' },
];

const comparisons = [
  { label: 'Drop into existing stack', us: '✅ Yes', electric: '❌ TanStack Start', zero: '❌ Own data layer', powersync: '⚠️ Managed service' },
  { label: 'Extra infrastructure', us: '✅ None', electric: 'HTTP/2 + Caddy', zero: 'zero-cache', powersync: 'PowerSync service' },
  { label: 'Install', us: '✅ 1 package', electric: 'Scaffolded app', zero: '4+ packages', powersync: '3+ packages' },
  { label: 'Local DB', us: 'PGlite / SQLite', electric: 'PGlite', zero: 'Custom store', powersync: 'SQLite' },
  { label: 'Conflict resolution', us: 'HLC LWW', electric: 'CRDT shapes', zero: 'Server authority', powersync: 'Custom' },
  { label: 'License', us: 'Apache 2.0', electric: 'Apache 2.0', zero: 'MIT', powersync: 'Apache 2.0' },
];

const frameworks = [
  'Next.js', 'Hono', 'Elysia', 'Express', 'Fastify', 'NestJS', 'Bun', 'Node.js',
];

const codeSync = `import { betterSync } from 'bettersync'
import { drizzleAdapter }
  from 'bettersync/adapters/drizzle'

export const sync = betterSync({
  database: drizzleAdapter(db, {
    schema: { project: projects },
  }),
  models: {
    project: {
      fields: { id, userId, title, changed },
      scope: ctx => ({ userId: ctx.userId }),
    },
  },
})`;

const codeRoute = `import { sync } from '@/lib/sync'

export const POST = sync.handler`;

const codeClient = `import { createSyncClient }
  from 'bettersync/client'
import { pgliteAdapter }
  from 'bettersync/adapters/pglite'

export const syncClient = createSyncClient({
  database: pgliteAdapter(
    new PGlite('idb://app'),
  ),
  schema: syncSchema,
  syncUrl: '/api/sync',
})`;

const subpaths = [
  { path: 'bettersync', desc: 'Core + betterSync() + server + client' },
  { path: 'bettersync/client', desc: 'Local-first sync client engine' },
  { path: 'bettersync/server', desc: 'Handler + hooks' },
  { path: 'bettersync/next-js', desc: 'Next.js App Router handler' },
  { path: 'bettersync/node', desc: 'Express / Fastify / NestJS adapter' },
  { path: 'bettersync/react', desc: 'SyncProvider, useSync, useSyncQuery, SyncDevtools' },
  { path: 'bettersync/adapters/drizzle', desc: 'Drizzle + Postgres (better-auth style)' },
  { path: 'bettersync/adapters/pglite', desc: 'PGlite (Postgres WASM in browser)' },
  { path: 'bettersync/test', desc: '19-test conformance suite' },
];
