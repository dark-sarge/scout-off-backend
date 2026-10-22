/**
 * /api/indexer/stream — Next.js API Route (proxy)
 *
 * Transparently proxies the SSE stream from the backend indexer to the browser.
 *
 * Why proxy?
 *   - CORS: the browser's EventSource API cannot send custom headers, so we
 *     can't attach a Bearer token directly.  Instead the client sends its JWT
 *     as a `?token=<jwt>` query parameter; this proxy validates it and forwards
 *     the authenticated request to the indexer.
 *   - Auth consistency: all API traffic from the frontend goes through the
 *     Next.js server, keeping auth logic centralised.
 *   - URL stability: clients always talk to `/api/indexer/stream` regardless
 *     of where the backend is deployed.
 *
 * Security notes:
 *   - The `token` param is validated by the backend; this proxy does not
 *     perform its own JWT verification.
 *   - The proxy strips the `Host` header to avoid forwarding it to the
 *     upstream service (which may run on a different domain).
 *   - Only GET requests are accepted; other methods return 405.
 *
 * Environment:
 *   INDEXER_STREAM_URL  Full URL of the backend SSE endpoint.
 *                       Default: http://localhost:4000/api/events/stream
 *
 * Usage — client-side:
 * ```ts
 * const url = `/api/indexer/stream?token=${jwt}&eventType=milestone_approved`;
 * const es = new EventSource(url);
 * ```
 *
 * Related: issue #1314, src/frontend/lib/eventStream.ts
 */

import type { IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import http from 'http';
import { URL } from 'url';

// ─── Configuration ────────────────────────────────────────────────────────────

const UPSTREAM_URL =
  process.env.INDEXER_STREAM_URL ?? 'http://localhost:4000/api/events/stream';

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Next.js API route handler.
 *
 * Compatible with both the Pages Router (`pages/api/`) and can be adapted for
 * the App Router by exporting `{ GET }`.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end('Method Not Allowed');
    return;
  }

  // Build upstream URL, forwarding all query parameters.
  const reqUrl = req.url ?? '/';
  const queryString = reqUrl.includes('?') ? reqUrl.slice(reqUrl.indexOf('?')) : '';
  let upstream: URL;
  try {
    upstream = new URL(UPSTREAM_URL + queryString);
  } catch {
    res.writeHead(502);
    res.end('Bad Gateway: invalid upstream URL');
    return;
  }

  // Forward relevant request headers.
  const forwardHeaders: Record<string, string> = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  // Forward Last-Event-ID for resume support.
  const lastEventId = req.headers['last-event-id'];
  if (lastEventId && typeof lastEventId === 'string') {
    forwardHeaders['Last-Event-ID'] = lastEventId;
  }

  const transport = upstream.protocol === 'https:' ? https : http;

  const proxyReq = transport.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: upstream.pathname + upstream.search,
      method: 'GET',
      headers: forwardHeaders,
    },
    (proxyRes) => {
      if (proxyRes.statusCode && proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      // Stream SSE headers to client.
      res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        Connection:          'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Pipe the upstream SSE stream to the client.
      proxyRes.pipe(res, { end: true });

      // When the client disconnects, destroy the upstream connection.
      req.on('close', () => {
        proxyRes.destroy();
        proxyReq.destroy();
      });
    },
  );

  proxyReq.on('error', (err) => {
    console.error('[/api/indexer/stream] upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  // Upstream request has no body for SSE.
  proxyReq.end();
}

// ─── Next.js config (disable body parsing — not needed for SSE) ───────────────

export const config = {
  api: {
    bodyParser: false,
    // Disable response limit so SSE can stream indefinitely.
    responseLimit: false,
    // Allow long-running connections.
    externalResolver: true,
  },
};
