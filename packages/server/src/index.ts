/**
 * @better-sync/server
 *
 * Framework-agnostic sync request handler. Wraps a SyncAdapter with a
 * `handleSync(request, ctx)` method that implements the full sync protocol:
 * scope enforcement, HLC-conditional upsert, tombstone denormalization,
 * cursor pagination, afterWriteInTransaction hooks with time budget,
 * and after-commit hooks.
 */

export { createSyncServer } from './server'
export type {
  CreateSyncServerOptions,
  SyncServer,
  SyncServerHooks,
  HookChangeDescriptor,
  AfterWriteInTransactionArgs,
  AfterCommitArgs,
  BeforeReadArgs,
} from './server'
export { runHookWithTimeout } from './hooks'
