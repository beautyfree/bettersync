/**
 * better-sync/next-js — Next.js App Router handler.
 *
 * Usage:
 *   // app/api/sync/route.ts
 *   import { sync } from '@/server/sync'
 *   import { toNextJsHandler } from 'better-sync/next-js'
 *
 *   export const POST = toNextJsHandler(sync, {
 *     auth: async (req) => {
 *       const session = await getSession(req.headers)
 *       if (!session) throw new Error('Unauthorized')
 *       return { userId: session.user.id }
 *     },
 *   })
 *
 * Works with Next.js 14+ App Router. Uses standard Web API Request/Response
 * — no Next.js-specific types needed.
 */

import {
  isSyncError,
  parseSyncRequest,
  type SyncError,
} from '@bettersync/core'
import type { SyncServer } from '@bettersync/server'

export interface NextJsHandlerOptions<Ctx> {
  /** Extract auth context from the request. Throw to reject (401). */
  auth: (req: Request) => Promise<Ctx> | Ctx
}

/**
 * Create a Next.js App Router POST handler for the sync endpoint.
 *
 * Returns a standard `(req: Request) => Promise<Response>` which Next.js
 * uses as a route handler export.
 */
export function toNextJsHandler<Ctx>(
  server: SyncServer<Ctx>,
  options: NextJsHandlerOptions<Ctx>,
) {
  return async function POST(req: Request): Promise<Response> {
    try {
      const body = await req.json()
      const syncReq = parseSyncRequest(body)
      const ctx = await options.auth(req)
      const syncRes = await server.handleSync(syncReq, ctx)
      return Response.json(syncRes)
    } catch (err: unknown) {
      if (isSyncError(err)) {
        const status = errorCodeToHttpStatus((err as SyncError).code)
        return Response.json((err as SyncError).toJSON(), { status })
      }
      // Generic auth/parse errors
      const message = err instanceof Error ? err.message : 'Internal server error'
      const status = message.toLowerCase().includes('unauthorized') ? 401 : 500
      return Response.json({ error: { message } }, { status })
    }
  }
}

function errorCodeToHttpStatus(code: string): number {
  switch (code) {
    case 'SCHEMA_VIOLATION': return 400
    case 'UNAUTHORIZED': return 401
    case 'SCOPE_VIOLATION': return 403
    case 'PROTOCOL_VERSION_MISMATCH': return 409
    case 'BATCH_TOO_LARGE': return 413
    case 'STALE_CLIENT': return 410
    case 'HOOK_TIMEOUT': return 500
    case 'ADAPTER_ERROR': return 500
    default: return 500
  }
}
