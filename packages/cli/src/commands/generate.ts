/**
 * `better-sync generate` command.
 *
 * Reads the user's sync config, generates SQL for their schema.
 *
 * Usage:
 *   better-sync generate                    # CREATE TABLE (new DB)
 *   better-sync generate --alter            # ALTER TABLE (existing DB)
 *   better-sync generate --alter --backfill # ALTER + backfill HLC
 *   better-sync generate --output schema.sql
 *   better-sync generate --config src/lib/sync.ts
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { generateSQL, formatSQL, encodeHlc, generateNodeId } from '@bettersync/core'
import type { SyncSchema } from '@bettersync/core'
import { getConfig } from '../utils/get-config'

export const generate = new Command('generate')
  .description('Generate SQL schema for sync tables')
  .option('-c, --cwd <cwd>', 'working directory', process.cwd())
  .option('--config <path>', 'path to sync config file')
  .option('--output <file>', 'output file (default: stdout)')
  .option('--alter', 'generate ALTER TABLE for existing databases', false)
  .option('--backfill', 'include HLC backfill for existing rows (with --alter)', false)
  .option('-y, --yes', 'skip confirmation prompts', false)
  .action(async (opts) => {
    const cwd = path.resolve(opts.cwd)
    if (!existsSync(cwd)) {
      console.error(chalk.red(`Directory "${cwd}" does not exist.`))
      process.exit(1)
    }

    // Find and load config
    console.log(chalk.gray('Finding sync config...'))
    const config = await getConfig({ cwd, configPath: opts.config })

    if (!config) {
      console.error(
        chalk.red('No sync config found.') +
        '\n\n' +
        'Create a sync config file (e.g. ' + chalk.yellow('src/lib/sync.ts') + '):' +
        '\n\n' +
        chalk.gray(`  import { betterSync } from 'better-sync'\n`) +
        chalk.gray(`  export const sync = betterSync({ ... })\n`) +
        '\n' +
        'Or specify the path: ' + chalk.yellow('better-sync generate --config path/to/sync.ts'),
      )
      process.exit(1)
    }

    // Extract schema
    const schema = config.schema as SyncSchema | undefined
    if (!schema || Object.keys(schema).length === 0) {
      console.error(chalk.red('Config found but no models/schema defined.'))
      process.exit(1)
    }

    const modelCount = Object.keys(schema).length
    console.log(
      chalk.green(`Found ${modelCount} model${modelCount === 1 ? '' : 's'}: `) +
      Object.keys(schema).join(', '),
    )

    // Generate SQL
    const backfillHlc = opts.backfill
      ? encodeHlc({ wall: Date.now(), logical: 0, node: generateNodeId() })
      : undefined

    const statements = generateSQL(schema, {
      alter: opts.alter,
      backfillHlc,
    })
    const sql = formatSQL(statements)

    // Output
    if (opts.output) {
      const outPath = path.resolve(cwd, opts.output)
      const dirExists = existsSync(path.dirname(outPath))
      if (!dirExists) {
        await fs.mkdir(path.dirname(outPath), { recursive: true })
      }

      if (existsSync(outPath) && !opts.yes) {
        console.log(
          chalk.yellow(`File ${opts.output} already exists. `) +
          'Use --yes to overwrite.',
        )
        process.exit(1)
      }

      await fs.writeFile(outPath, sql, 'utf-8')
      console.log(chalk.green(`Schema written to ${opts.output}`))
    } else {
      // Print to stdout
      console.log('')
      console.log(sql)
    }

    if (opts.alter) {
      console.log(chalk.gray('\nNext steps:'))
      console.log(chalk.gray('  1. Review the SQL above'))
      console.log(chalk.gray('  2. Run it against your database'))
      console.log(chalk.gray('  3. Deploy your server with better-sync'))
    } else {
      console.log(chalk.gray('\nNext steps:'))
      console.log(chalk.gray('  1. Run the SQL against your database, or'))
      console.log(chalk.gray('  2. Use your ORM migration tool (drizzle-kit push, prisma migrate)'))
    }

    process.exit(0)
  })
