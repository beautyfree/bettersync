/**
 * bettersync/node — Node.js adapter for Express, Fastify, NestJS, etc.
 *
 * Converts Node.js IncomingMessage → Web API Request → sync.handler → Response → res.
 *
 * Usage with Express:
 *   import { toNodeHandler } from 'bettersync/node'
 *   app.all('/api/sync', toNodeHandler(sync))
 *
 * Usage with Fastify:
 *   import { toNodeHandler } from 'bettersync/node'
 *   fastify.all('/api/sync', async (req, reply) => {
 *     const response = await sync.handler(toWebRequest(req.raw))
 *     reply.status(response.status).send(await response.json())
 *   })
 */

import type { SyncServer } from '@bettersync/server'

interface NodeRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

interface NodeResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(body: string): void
}

/**
 * Convert a Node.js IncomingMessage to a Web API Request.
 */
export function toWebRequest(nodeReq: NodeRequest): Request {
  const protocol = 'http'
  const host = (nodeReq.headers.host as string) ?? 'localhost'
  const url = new URL(nodeReq.url ?? '/', `${protocol}://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }

  // Read body
  const body = new ReadableStream({
    start(controller) {
      nodeReq.on('data', (...args: unknown[]) => {
        const chunk = args[0]
        if (chunk instanceof Uint8Array) controller.enqueue(chunk)
        else if (typeof chunk === 'string') controller.enqueue(new TextEncoder().encode(chunk))
      })
      nodeReq.on('end', () => controller.close())
      nodeReq.on('error', (...args: unknown[]) => controller.error(args[0]))
    },
  })

  return new Request(url.toString(), {
    method: nodeReq.method ?? 'POST',
    headers,
    body: nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD' ? body : undefined,
    ...(nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD' ? { duplex: 'half' as const } : {}),
  })
}

/**
 * Convert a Web API Response to Node.js response.
 */
async function sendWebResponse(webRes: Response, nodeRes: NodeResponse): Promise<void> {
  const headers: Record<string, string> = {}
  webRes.headers.forEach((value, key) => {
    headers[key] = value
  })
  nodeRes.writeHead(webRes.status, { ...headers, 'content-type': 'application/json' })
  const text = await webRes.text()
  nodeRes.end(text)
}

/**
 * Create a Node.js HTTP handler for Express/Connect/NestJS.
 *
 * ```ts
 * import { toNodeHandler } from 'bettersync/node'
 * app.post('/api/sync', toNodeHandler(sync))
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: framework-agnostic
export function toNodeHandler(server: SyncServer<any>) {
  return async function handler(req: NodeRequest, res: NodeResponse) {
    const webReq = toWebRequest(req)
    const webRes = await server.handler(webReq)
    await sendWebResponse(webRes, res)
  }
}

/**
 * Convert Node.js headers to Web API Headers.
 * Useful for session retrieval in Express/Fastify routes.
 */
export function fromNodeHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const h = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value) h.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return h
}
