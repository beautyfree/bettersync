/**
 * Shared sync schema — used by both server and client.
 * Defines what models are synced and their field shapes.
 */
import { defineSchema } from 'better-sync'

export interface AuthContext {
  userId: string
}

export const syncSchema = defineSchema<AuthContext>({
  todo: {
    fields: {
      id: { type: 'string', primaryKey: true },
      userId: { type: 'string' },
      title: { type: 'string' },
      completed: { type: 'boolean', required: false },
      changed: { type: 'string' },
    },
    scope: (ctx) => ({ userId: ctx.userId }),
  },
})
