/**
 * `bettersync init` — interactive wizard that scaffolds sync into
 * an existing project. Inspired by better-auth's init command.
 *
 * Steps:
 *   1. Detect package manager + framework
 *   2. Install bettersync + PGlite
 *   3. Prompt for database adapter
 *   4. Generate lib/sync.ts
 *   5. Generate lib/sync-client.ts
 *   6. Generate app/api/sync/route.ts
 *   7. Optionally generate demo page
 *   8. Show next steps
 */

import { exec as execCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import chalk from 'chalk'
import { Command } from 'commander'

const execAsync = promisify(execCb)

// ─── Prompts (readline-based, zero deps) ────────────────────────────

import readline from 'node:readline'

async function ask(question: string, defaultVal?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultVal ? chalk.gray(` (${defaultVal})`) : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultVal || '')
    })
  })
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N'
  const answer = await ask(`${question} [${hint}]`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function select(question: string, options: Array<{ value: string; label: string }>): Promise<string> {
  console.log(`\n${question}`)
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${chalk.cyan(String(i + 1))} ${options[i]!.label}`)
  }
  const answer = await ask('Choose', '1')
  const idx = Number.parseInt(answer, 10) - 1
  return options[Math.max(0, Math.min(idx, options.length - 1))]!.value
}

// ─── Detection helpers ──────────────────────────────────────────────

type PM = 'pnpm' | 'npm' | 'yarn' | 'bun'

function detectPackageManager(cwd: string): PM {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))) return 'bun'
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function installCmd(pm: PM, pkgs: string[]): string {
  const joined = pkgs.join(' ')
  switch (pm) {
    case 'pnpm': return `pnpm add ${joined}`
    case 'bun': return `bun add ${joined}`
    case 'yarn': return `yarn add ${joined}`
    default: return `npm install ${joined}`
  }
}

interface FrameworkInfo {
  id: string
  name: string
  routeDir: string
  routeFile: string
  useSrc: boolean
}

async function detectFramework(cwd: string): Promise<FrameworkInfo> {
  let pkgJson: Record<string, unknown> = {}
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf-8'))
  } catch { /* empty */ }

  const deps = {
    ...(pkgJson.dependencies as Record<string, string> ?? {}),
    ...(pkgJson.devDependencies as Record<string, string> ?? {}),
  }

  const hasSrc = existsSync(path.join(cwd, 'src'))
  const prefix = hasSrc ? 'src/' : ''

  if (deps.next) {
    // Detect App Router vs Pages Router
    const hasAppDir = existsSync(path.join(cwd, prefix, 'app'))
    if (hasAppDir) {
      return {
        id: 'next-app',
        name: 'Next.js (App Router)',
        routeDir: `${prefix}app/api/sync`,
        routeFile: 'route.ts',
        useSrc: hasSrc,
      }
    }
    return {
      id: 'next-pages',
      name: 'Next.js (Pages Router)',
      routeDir: `${prefix}pages/api`,
      routeFile: 'sync.ts',
      useSrc: hasSrc,
    }
  }

  if (deps.hono) return { id: 'hono', name: 'Hono', routeDir: `${prefix}`, routeFile: 'sync-handler.ts', useSrc: hasSrc }
  if (deps.express) return { id: 'express', name: 'Express', routeDir: `${prefix}`, routeFile: 'sync-handler.ts', useSrc: hasSrc }
  if (deps['@nestjs/core']) return { id: 'nestjs', name: 'NestJS', routeDir: `${prefix}sync`, routeFile: 'sync.controller.ts', useSrc: hasSrc }

  return { id: 'unknown', name: 'Unknown', routeDir: prefix || '.', routeFile: 'sync-handler.ts', useSrc: hasSrc }
}

// ─── Code generators ────────────────────────────────────────────────

function generateSyncConfig(adapter: string): string {
  const adapterImport = adapter === 'drizzle'
    ? `import { drizzleAdapter } from 'bettersync/adapters/drizzle'\nimport { db } from './db' // your Drizzle instance`
    : `import { memoryAdapter } from 'bettersync/adapters/memory'`

  const adapterCall = adapter === 'drizzle'
    ? 'drizzleAdapter(db)'
    : 'memoryAdapter()'

  return `import { betterSync } from 'bettersync'
${adapterImport}

export const sync = betterSync({
  database: ${adapterCall},
  models: {
    todo: {
      fields: {
        id:        { type: 'string', primaryKey: true },
        userId:    { type: 'string' },
        title:     { type: 'string' },
        completed: { type: 'boolean', required: false },
        changed:   { type: 'string' },
      },
      scope: (ctx) => ({ userId: ctx.userId }),
    },
  },
})

export const syncSchema = sync.schema
`
}

function generateSyncClient(): string {
  return `import { createSyncClient } from 'bettersync/client'
import { pgliteAdapter } from 'bettersync/adapters/pglite'
import { PGlite } from '@electric-sql/pglite'
import { syncSchema } from './sync'

const pg = new PGlite('idb://my-app')

export const syncClient = createSyncClient({
  database: pgliteAdapter(pg),
  schema: syncSchema,
  syncUrl: '/api/sync',
})
`
}

function generateNextAppRoute(): string {
  return `import { sync } from '@/lib/sync'
import { toNextJsHandler } from 'bettersync/next-js'

export const POST = toNextJsHandler(sync, {
  auth: async (req) => {
    // TODO: Replace with your auth logic
    // const session = await getSession(req)
    // if (!session) throw new Error('Unauthorized')
    // return { userId: session.user.id }
    return { userId: 'demo-user' }
  },
})
`
}

function generateNextPagesRoute(): string {
  return `import type { NextApiRequest, NextApiResponse } from 'next'
import { sync } from '@/lib/sync'
import { parseSyncRequest } from 'bettersync'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const syncReq = parseSyncRequest(req.body)
    // TODO: Replace with your auth logic
    const ctx = { userId: 'demo-user' }
    const syncRes = await sync.handleSync(syncReq, ctx)
    res.json(syncRes)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
`
}

function generateGenericHandler(): string {
  return `import { sync } from './sync'
import { parseSyncRequest } from 'bettersync'

/**
 * Handle POST /sync requests.
 * Wire this into your framework's router.
 */
export async function handleSync(body: unknown, userId: string) {
  const syncReq = parseSyncRequest(body)
  return sync.handleSync(syncReq, { userId })
}
`
}

function generateDemoPage(): string {
  return `'use client'

import { useCallback, useRef, useState } from 'react'
import { useSync, useSyncQuery } from 'bettersync/react'

export default function SyncDemo() {
  const sync = useSync()
  const inputRef = useRef<HTMLInputElement>(null)
  const { data: todos, refetch } = useSyncQuery(
    (s) => s.model('todo').findMany(), [],
  )

  const add = useCallback(async () => {
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

  return (
    <div style={{ padding: 40, maxWidth: 500, margin: '0 auto', fontFamily: 'system-ui' }}>
      <h1>Sync Demo</h1>
      <p style={{ color: '#888' }}>Open in two tabs. Add todos. They sync.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input ref={inputRef} placeholder="New todo..." onKeyDown={e => e.key === 'Enter' && add()}
          style={{ flex: 1, padding: 8, borderRadius: 4, border: '1px solid #ccc' }} />
        <button onClick={add} style={{ padding: '8px 16px' }}>Add</button>
      </div>
      <button onClick={() => { sync.syncNow().then(() => refetch()) }}
        style={{ marginBottom: 16, padding: '4px 12px', fontSize: 12 }}>Sync now</button>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos?.map(t => (
          <li key={String(t.id)} style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
            {String(t.title)}
          </li>
        ))}
      </ul>
    </div>
  )
}
`
}

// ─── Main command ───────────────────────────────────────────────────

export const init = new Command('init')
  .description('Scaffold bettersync into your project')
  .option('-c, --cwd <cwd>', 'working directory', process.cwd())
  .option('-y, --yes', 'skip prompts, use defaults', false)
  .action(async (opts) => {
    const cwd = path.resolve(opts.cwd)
    const auto = opts.yes

    console.log('')
    console.log(chalk.bold('  bettersync init'))
    console.log(chalk.gray('  Scaffold local-first sync into your project\n'))

    // ─── 1. Detect environment ────────────────────────────────
    const pm = detectPackageManager(cwd)
    const fw = await detectFramework(cwd)
    console.log(`  ${chalk.green('✓')} Package manager: ${chalk.bold(pm)}`)
    console.log(`  ${chalk.green('✓')} Framework: ${chalk.bold(fw.name)}`)

    const prefix = fw.useSrc ? 'src/' : ''
    const libDir = `${prefix}lib`

    // ─── 2. Install deps ──────────────────────────────────────
    const depsNeeded = ['bettersync', '@electric-sql/pglite']
    const shouldInstall = auto || await confirm(`\nInstall ${depsNeeded.join(' + ')}?`)

    if (shouldInstall) {
      const cmd = installCmd(pm, depsNeeded)
      console.log(chalk.gray(`  Running: ${cmd}`))
      try {
        await execAsync(cmd, { cwd })
        console.log(`  ${chalk.green('✓')} Dependencies installed`)
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Install failed. Run manually: ${cmd}`))
      }
    }

    // ─── 3. Choose adapter ────────────────────────────────────
    let adapter = 'memory'
    if (!auto) {
      adapter = await select('Database adapter:', [
        { value: 'memory', label: `${chalk.bold('Memory')} — for demo/prototyping (no real DB needed)` },
        { value: 'drizzle', label: `${chalk.bold('Drizzle + Postgres')} — for production` },
      ])
    }

    // ─── 4. Generate lib/sync.ts ──────────────────────────────
    const syncConfigPath = path.join(cwd, libDir, 'sync.ts')
    if (existsSync(syncConfigPath) && !auto) {
      const overwrite = await confirm(`${libDir}/sync.ts already exists. Overwrite?`, false)
      if (!overwrite) {
        console.log(chalk.gray('  Skipping sync.ts'))
      } else {
        await writeFile(syncConfigPath, generateSyncConfig(adapter))
      }
    } else {
      await writeFile(syncConfigPath, generateSyncConfig(adapter))
    }

    // ─── 5. Generate lib/sync-client.ts ───────────────────────
    const clientPath = path.join(cwd, libDir, 'sync-client.ts')
    if (!existsSync(clientPath) || auto) {
      await writeFile(clientPath, generateSyncClient())
    }

    // ─── 6. Generate route handler ────────────────────────────
    const routePath = path.join(cwd, fw.routeDir, fw.routeFile)
    if (!existsSync(routePath) || auto) {
      let routeCode: string
      if (fw.id === 'next-app') routeCode = generateNextAppRoute()
      else if (fw.id === 'next-pages') routeCode = generateNextPagesRoute()
      else routeCode = generateGenericHandler()
      await writeFile(routePath, routeCode)
    }

    // ─── 7. Optional demo page ────────────────────────────────
    if (fw.id === 'next-app') {
      const addDemo = auto || await confirm('Add a sync demo page?')
      if (addDemo) {
        const demoPath = path.join(cwd, prefix, 'app/sync-demo/page.tsx')
        await writeFile(demoPath, generateDemoPage())
      }
    }

    // ─── 8. Summary ───────────────────────────────────────────
    console.log('')
    console.log(chalk.green.bold('  ✓ bettersync initialized!'))
    console.log('')
    console.log(chalk.gray('  Created files:'))
    console.log(`    ${chalk.cyan(libDir + '/sync.ts')}         — sync config`)
    console.log(`    ${chalk.cyan(libDir + '/sync-client.ts')}  — client config`)
    console.log(`    ${chalk.cyan(fw.routeDir + '/' + fw.routeFile)}   — API handler`)
    if (fw.id === 'next-app') {
      console.log(`    ${chalk.cyan(prefix + 'app/sync-demo/page.tsx')} — demo page`)
    }
    console.log('')
    console.log(chalk.gray('  Next steps:'))
    if (adapter === 'drizzle') {
      console.log(`    1. Update ${chalk.yellow(libDir + '/sync.ts')} with your Drizzle db instance`)
      console.log(`    2. Run ${chalk.yellow('npx @bettersync/cli generate --alter')} to add sync columns`)
    }
    console.log(`    ${adapter === 'drizzle' ? '3' : '1'}. Update the auth handler in ${chalk.yellow(fw.routeDir + '/' + fw.routeFile)}`)
    console.log(`    ${adapter === 'drizzle' ? '4' : '2'}. Run ${chalk.yellow(pm === 'npm' ? 'npm run dev' : `${pm} dev`)}`)
    if (fw.id === 'next-app') {
      console.log(`    ${adapter === 'drizzle' ? '5' : '3'}. Open ${chalk.yellow('http://localhost:3000/sync-demo')} in two tabs`)
    }
    console.log('')

    process.exit(0)
  })

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  const relative = path.relative(process.cwd(), filePath)
  console.log(`  ${chalk.green('✓')} Created ${relative}`)
}
