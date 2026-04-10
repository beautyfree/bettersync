---
title: Framework Integrations
description: Next.js, NestJS, Express, Hono, Elysia, Fastify, Bun.
---

# Framework Integrations

bettersync exposes a standard Web API handler: `sync.handler`. Every framework that supports `Request` / `Response` works natively.

## Next.js (App Router)

```ts title="app/api/sync/route.ts"
import { sync } from '@/lib/sync'
export const POST = sync.handler
```

## Hono

```ts
import { Hono } from 'hono'

const app = new Hono()
app.post('/sync', (c) => sync.handler(c.req.raw))
```

## Elysia

```ts
import { Elysia } from 'elysia'

const app = new Elysia()
  .mount('/sync', sync.handler)
```

## Bun

```ts
Bun.serve({ fetch: sync.handler })
```

## Express

Uses `toNodeHandler` to convert between Node.js and Web API:

```ts
import express from 'express'
import { toNodeHandler } from 'bettersync/node'

const app = express()
app.post('/api/sync', toNodeHandler(sync))
```

## Fastify

```ts
import { toNodeHandler } from 'bettersync/node'

fastify.post('/api/sync', async (req, reply) => {
  const handler = toNodeHandler(sync)
  return handler(req.raw, reply.raw)
})
```

## NestJS

```ts title="sync/sync.controller.ts"
import { All, Controller, Req, Res } from '@nestjs/common'
import { toNodeHandler } from 'bettersync/node'
import { SyncService } from './sync.service'

@Controller('api/sync')
export class SyncController {
  private handler = toNodeHandler(this.syncService.sync)

  constructor(private readonly syncService: SyncService) {}

  @All()
  async handleSync(@Req() req, @Res() res) {
    return this.handler(req, res)
  }
}
```
