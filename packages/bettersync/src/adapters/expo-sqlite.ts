/**
 * bettersync/adapters/expo-sqlite — SQLite adapter for React Native / Expo.
 *
 * Offline-first local store for RN clients. No WASM, no IndexedDB —
 * runs on the native iOS/Android SQLite engine via expo-sqlite.
 */
export {
  expoSqliteAdapter,
  type ExpoSqliteAdapterOptions,
  type ExpoSqliteDbLike,
} from '@bettersync/expo-sqlite-adapter'
