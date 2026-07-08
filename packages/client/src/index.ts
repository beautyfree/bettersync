/**
 * @bettersync/client
 *
 * Local-first sync client. Wraps a SyncAdapter with a HLC clock, pending
 * queue, and sync loop. Writes go to the local store first (fast,
 * offline) and automatically attempt a background push when transport is
 * available. Use write `{ sync: 'remote' }` when UI must wait for server
 * acknowledgement.
 */

export { createSyncClient } from './client'
export type {
  ChangeEvent,
  ChangeListener,
  CreateSyncClientOptions,
  EnableSyncOptions,
  ErrorListener,
  ModelAccessor,
  PendingOp,
  SyncClient,
  SyncEvent,
  SyncListener,
  SyncNowOptions,
  SyncResult,
  SyncStatus,
  Transport,
  WriteOptions,
} from './client'
