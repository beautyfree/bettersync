/**
 * better-sync CLI
 *
 * Usage:
 *   npx @bettersync/cli generate          # CREATE TABLE for new DB
 *   npx @bettersync/cli generate --alter  # ALTER TABLE for existing DB
 *   npx @bettersync/cli generate --output sync-schema.sql
 */

import { Command } from 'commander'
import { generate } from './commands/generate'

const program = new Command()
  .name('better-sync')
  .description('CLI tools for better-sync')
  .version('0.0.1')

program.addCommand(generate)

program.parse()
