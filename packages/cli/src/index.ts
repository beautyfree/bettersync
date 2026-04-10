/**
 * bettersync CLI
 *
 * Usage:
 *   npx @bettersync/cli generate          # CREATE TABLE for new DB
 *   npx @bettersync/cli generate --alter  # ALTER TABLE for existing DB
 *   npx @bettersync/cli generate --output sync-schema.sql
 */

import { Command } from 'commander'
import { generate } from './commands/generate'
import { init } from './commands/init'

const program = new Command()
  .name('bettersync')
  .description('CLI tools for bettersync')
  .version('0.0.1')

program.addCommand(init)
program.addCommand(generate)

program.parse()
