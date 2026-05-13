/**
 * bettersync/hono — Hono handler.
 *
 * Usage:
 *   // server/index.ts
 *   import { Hono } from 'hono'
 *   import { sync } from './sync'
 *   import { toHonoHandler } from 'bettersync/hono'
 *
 *   const app = new Hono()
 *   app.post('/api/sync', toHonoHandler(sync, {
 *     auth: async (c) => {
 *       const session = await getSession(c.req.raw.headers)
 *       if (!session) throw new Error('Unauthorized')
 *       return { userId: session.user.id }
 *     },
 *   }))
 *
 * Works on Node (Railway, Fly), Bun, Cloudflare Workers, Deno —
 * anywhere Hono runs. Uses Web API Request/Response, no Hono-internal
 * coupling beyond `Context`.
 */

import {
  isSyncError,
  parseSyncRequest,
  type SyncError,
} from '@bettersync/core'
import type { SyncServer } from '@bettersync/server'

/**
 * Minimal shape of a Hono `Context`. Avoids importing `hono` types so the
 * meta package stays dependency-free; full type-safety still works for
 * consumers — they pass their own `Context` through generics if needed.
 */
interface HonoLikeContext {
  req: { raw: Request }
  json(body: unknown, init?: number | ResponseInit): Response
}

export interface HonoHandlerOptions<Ctx> {
  /** Extract auth context from the Hono request. Throw to reject (401). */
  auth: (c: HonoLikeContext) => Promise<Ctx> | Ctx
}

/**
 * Create a Hono handler for the sync endpoint.
 *
 * Returns `(c: Context) => Promise<Response>` that Hono uses as a route
 * handler. Errors are mapped to standard sync HTTP statuses.
 */
export function toHonoHandler<Ctx>(
  server: SyncServer<Ctx>,
  options: HonoHandlerOptions<Ctx>,
) {
  return async function handler(c: HonoLikeContext): Promise<Response> {
    try {
      const body = await c.req.raw.json()
      const syncReq = parseSyncRequest(body)
      const ctx = await options.auth(c)
      const syncRes = await server.handleSync(syncReq, ctx)
      return c.json(syncRes)
    } catch (err: unknown) {
      if (isSyncError(err)) {
        const status = errorCodeToHttpStatus((err as SyncError).code)
        return c.json((err as SyncError).toJSON(), status)
      }
      const message = err instanceof Error ? err.message : 'Internal server error'
      const status = message.toLowerCase().includes('unauthorized') ? 401 : 500
      return c.json({ error: { message } }, status)
    }
  }
}

function errorCodeToHttpStatus(code: string): number {
  switch (code) {
    case 'SCHEMA_VIOLATION':
      return 400
    case 'UNAUTHORIZED':
      return 401
    case 'SCOPE_VIOLATION':
      return 403
    case 'PROTOCOL_VERSION_MISMATCH':
      return 409
    case 'BATCH_TOO_LARGE':
      return 413
    case 'STALE_CLIENT':
      return 410
    case 'HOOK_TIMEOUT':
      return 500
    case 'ADAPTER_ERROR':
      return 500
    default:
      return 500
  }
}
