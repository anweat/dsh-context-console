/** Register read/write JSON endpoints on Connection's shared authenticated API. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'

function failure(rpcId: string, message: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'gateway/bad-request', message, details: {} } },
  })
}

/**
 * Mount exact routes instead of a dedicated channel. DSH 0.1.5 permits
 * Connection to exist before WebServer; exact Fetch routes join `/api` when a
 * browser transport is present and do not compete for its single interceptor.
 */
export function registerRpcRoutes(
  ctx: Context,
  prefix: string,
  endpoints: readonly string[],
  handler: ConnectionRpcHandler,
): void {
  for (const endpoint of endpoints) {
    const method = `${prefix}/${endpoint}`
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof body === 'object' && body !== null
          && typeof (body as { rpcId?: unknown }).rpcId === 'string'
          ? (body as { rpcId: string }).rpcId
          : 'invalid-request'
        if (typeof body !== 'object' || body === null
          || (body as { type?: unknown }).type !== 'client-request'
          || (body as { method?: unknown }).method !== method) {
          return failure(rpcId, 'invalid RPC request')
        }
        try {
          const result = await handler(
            endpoint,
            (body as { payload?: unknown }).payload,
            request.signal,
          )
          return Response.json({ type: 'server-response', rpcId, result })
        } catch (error) {
          return failure(rpcId, String(error instanceof Error ? error.message : error).slice(0, 500))
        }
      },
    }), `dsh-context-console: ${method} RPC route`)
  }
}
