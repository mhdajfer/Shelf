import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Router, type Request, type Response } from 'express';

import type { Database } from '@shelf/db';

import { logger } from '../observability/logger.js';
import type { RateLimits } from '../security/rateLimit.js';
import { bearerAuth, grantOf } from './auth.js';
import { buildServer } from './server.js';

export const MCP_PATH = '/mcp';

/** The JSON-RPC method and the tool, prompt, or resource it names. Never arguments. */
function describeCall(body: unknown): { rpc: string; target?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { rpc: 'unknown' };
  const { method, params } = body as {
    method?: unknown;
    params?: { name?: unknown; uri?: unknown };
  };
  const target = typeof params?.name === 'string' ? params.name : params?.uri;
  return {
    rpc: typeof method === 'string' ? method : 'unknown',
    ...(typeof target === 'string' ? { target } : {}),
  };
}

const CACHE_CONTROL = 'no-store, no-transform';

/**
 * The SDK writes its own `Cache-Control` (`no-cache, no-transform` on event
 * streams) in `writeHead`, where it would override one set earlier. `no-cache`
 * still lets a cache keep a copy, and every answer here is one user's data, so
 * the header is replaced as it is written. `no-transform` stays, so no proxy
 * buffers or compresses a stream.
 */
function neverStored(res: Response): void {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) continue;
      const headers = arg as Record<string, unknown>;
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'cache-control') headers[name] = CACHE_CONTROL;
      }
    }
    res.setHeader('Cache-Control', CACHE_CONTROL);
    return writeHead(...args);
  }) as Response['writeHead'];
}

/**
 * The MCP endpoint: Streamable HTTP through the SDK's per-request handler,
 * which serves protocol revision 2026-07-28 and answers 2025-era clients
 * statelessly from the same server definition.
 */
export function createMcpRouter(deps: { db: Database; limits: RateLimits }): Router {
  const onerror = (error: Error): void => {
    logger.error({ err: error }, 'mcp transport error');
  };
  const handler = createMcpHandler(({ authInfo }) => buildServer(deps, grantOf(authInfo)), {
    legacy: 'stateless',
    onerror,
  });
  const serve = toNodeHandler(handler, { onerror });

  const router = Router();
  router.all(MCP_PATH, bearerAuth(deps), async (req: Request, res: Response) => {
    const started = performance.now();
    neverStored(res);
    res.on('finish', () => {
      logger.info(
        {
          mcp: describeCall(req.body),
          grantId: req.auth?.clientId,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
        },
        'mcp request',
      );
    });
    // express.json() has already read the stream, so the parsed body is passed on.
    await serve(req, res, req.body);
  });
  return router;
}
