/**
 * @bettersync/client
 *
 * Local-first sync client. Wraps a SyncAdapter with a HLC clock, pending
 * queue, and sync loop. Writes go to the local store first (fast, offline)
 * and are later flushed to the server via `syncNow()`.
 *
 * In v0.1 the pending queue is in-memory only. Persistence + polling loop
 * + recover() + watch() arrive in v0.2.
 */

export { createSyncClient } from './client'
export type {
  ChangeEvent,
  ChangeListener,
  CreateSyncClientOptions,
  ErrorListener,
  ModelAccessor,
  PendingOp,
  SyncClient,
  SyncEvent,
  SyncListener,
  SyncResult,
  Transport,
} from './client'
