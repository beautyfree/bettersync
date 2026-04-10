/**
 * POST /api/sync — the single sync endpoint.
 *
 * In this demo, auth is hardcoded to userId "demo-user".
 * In production, extract from session/JWT/cookie.
 */
import { toNextJsHandler } from 'better-sync/next-js'
import { syncServer } from '@/lib/sync-server'

export const POST = toNextJsHandler(syncServer, {
  auth: async () => {
    // Demo: hardcoded user. Replace with your auth:
    // const session = await getServerSession()
    // if (!session) throw new Error('Unauthorized')
    // return { userId: session.user.id }
    return { userId: 'demo-user' }
  },
})
