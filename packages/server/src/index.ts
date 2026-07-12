/**
 * @bettersync/server
 *
 * Framework-agnostic sync request handler. Wraps a SyncAdapter with a
 * `handleSync(request, ctx)` method that implements the full sync protocol:
 * scope enforcement, HLC-conditional upsert, tombstone denormalization,
 * cursor pagination, afterWriteInTransaction hooks with time budget,
 * and after-commit hooks.
 */

export { createInMemoryRealtimeBus, createSyncServer } from './server'
export type {
  AuthResolver,
  CreateInMemoryRealtimeBusOptions,
  CreateSyncServerOptions,
  SyncServer,
  SyncServerHooks,
  SyncRealtimeBus,
  SyncRealtimePublisher,
  SyncRealtimePublishArgs,
  SyncRealtimeUnsubscribe,
  HookChangeDescriptor,
  AfterWriteInTransactionArgs,
  AfterCommitArgs,
  BeforeReadArgs,
  BeforeWriteArgs,
} from './server'
export { runHookWithTimeout } from './hooks'
