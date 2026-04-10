/**
 * POST /api/sync — 2 lines, like better-auth.
 */
import { sync } from '@/lib/sync'
import { toNextJsHandler } from 'better-sync/next-js'

export const POST = toNextJsHandler(sync, {
  auth: async () => ({ userId: 'demo-user' }),
})
